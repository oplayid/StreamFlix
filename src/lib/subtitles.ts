import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { collection, now } from "./mongo";

export type SubtitleTrack = {
  id: string;
  mediaId: string;
  lang: string;
  label: string;
  source: "upload" | "url";
  origin?: string;
  url: string;
  content: string;
  isOwner: boolean;
  /** Seconds added to cue times. */
  offset: number;
  /** Playback-speed correction; 1 means no drift. */
  scale: number;
  createdAt: string;
};

type SubtitleDoc = {
  _id: string;
  mediaId: string;
  userId: string | null;
  lang: string;
  label: string;
  source: "upload" | "url";
  origin?: string;
  content: string;
  offset?: number;
  scale?: number;
  createdAt: Date;
};

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const mediaIdSchema = z.string().min(1).max(100).regex(/^(tv-)?\d+$/);

/** Indonesian is preferred, then English, then any other language. */
export function normalizeLang(lang: string): string {
  const value = lang.trim().toLowerCase();
  if (["id", "ids", "ind", "in", "id-id", "indonesia", "bahasa indonesia"].includes(value)) return "id";
  if (["en", "eng", "en-us", "en-gb", "english"].includes(value)) return "en";
  return value;
}

export function languageLabel(lang: string): string {
  const code = normalizeLang(lang);
  if (code === "id") return "Bahasa Indonesia";
  if (code === "en") return "English";
  return lang;
}

function languageRank(lang: string): number {
  const code = normalizeLang(lang);
  if (code === "id") return 0;
  if (code === "en") return 1;
  return 2;
}

/** Saved choice wins; otherwise Indonesian first, English as fallback. */
export function pickInitialSubtitle(tracks: SubtitleTrack[], saved: string | null): string | null {
  const find = (code: string) => tracks.find((track) => normalizeLang(track.lang) === code);
  if (saved) {
    const match = find(normalizeLang(saved));
    if (match) return match.lang;
  }
  return find("id")?.lang ?? find("en")?.lang ?? tracks[0]?.lang ?? null;
}

/** Convert Common Subtitle Format (.srt) into WebVTT. VTT is passed through. */
export function toWebVtt(input: string): string {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("Subtitle file is empty");
  if (text.length > MAX_SUBTITLE_BYTES) throw new Error("Subtitle file is too large (max 2 MB)");

  if (/^WEBVTT\b/i.test(text)) {
    return text.startsWith("WEBVTT") ? text : `WEBVTT\n\n${text}`;
  }

  const blocks = text.split(/\n{2,}/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const times = lines[timeIndex]
      .replace(/\s*-->\s*/, " --> ")
      .replace(/(\d),(\d{3})/g, "$1.$2");
    const payload = lines.slice(timeIndex + 1).join("\n");
    cues.push(`${times}\n${payload}`.trim());
  }
  if (cues.length === 0) throw new Error("No valid subtitle cues found");
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

async function publicTrack(doc: SubtitleDoc, viewerId: string | null): Promise<SubtitleTrack> {
  return {
    id: doc._id,
    mediaId: doc.mediaId,
    lang: doc.lang,
    label: doc.label,
    source: doc.source,
    origin: doc.origin,
    url: `/api/subtitles/${encodeURIComponent(doc._id)}`,
    content: doc.content,
    isOwner: !!viewerId && doc.userId === viewerId,
    offset: doc.offset ?? 0,
    scale: doc.scale ?? 1,
    createdAt: new Date(doc.createdAt).toISOString(),
  };
}

async function viewerId(): Promise<string | null> {
  try {
    const { getCurrentUser } = await import("./auth");
    return (await getCurrentUser())?.id ?? null;
  } catch {
    return null;
  }
}

const readTracks = createServerFn({ method: "GET" })
  .validator(z.object({ mediaId: mediaIdSchema }))
  .handler(async ({ data }): Promise<SubtitleTrack[]> => {
    const userId = await viewerId();
    const col = await collection<SubtitleDoc>("subtitles");
    const docs = await col
      .find({
        $or: [{ mediaId: data.mediaId }, { mediaId: data.mediaId.replace(/^tv-/, "") }],
      })
      .sort({ createdAt: 1 })
      .toArray();
    const tracks = await Promise.all(docs.map((doc) => publicTrack(doc, userId)));
    return tracks.sort((a, b) => languageRank(a.lang) - languageRank(b.lang));
  });

const createUpload = createServerFn({ method: "POST" })
  .validator(z.object({
    mediaId: mediaIdSchema,
    lang: z.string().min(2).max(20),
    label: z.string().min(1).max(60),
    content: z.string().min(1),
  }))
  .handler(async ({ data }): Promise<SubtitleTrack> => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const content = toWebVtt(data.content);
    const doc: SubtitleDoc = {
      _id: randomUUID(),
      mediaId: data.mediaId,
      userId: user.id,
      lang: data.lang,
      label: data.label,
      source: "upload",
      content,
      createdAt: now(),
    };
    const col = await collection<SubtitleDoc>("subtitles");
    await col.insertOne(doc);
    return publicTrack(doc, user.id);
  });

const createFromUrl = createServerFn({ method: "POST" })
  .validator(z.object({
    mediaId: mediaIdSchema,
    lang: z.string().min(2).max(20),
    label: z.string().min(1).max(60),
    url: z.string().url().max(2000),
  }))
  .handler(async ({ data }): Promise<SubtitleTrack> => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const parsed = new URL(data.url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http(s) subtitle URLs are allowed");

    const res = await fetch(parsed, {
      headers: { "User-Agent": "StreamFlix-Subtitle-Fetch/1.0", Accept: "*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Subtitle URL returned ${res.status}`);
    const raw = await res.text();
    const content = toWebVtt(raw);
    const doc: SubtitleDoc = {
      _id: randomUUID(),
      mediaId: data.mediaId,
      userId: user.id,
      lang: data.lang,
      label: data.label,
      source: "url",
      origin: parsed.origin,
      content,
      createdAt: now(),
    };
    const col = await collection<SubtitleDoc>("subtitles");
    await col.insertOne(doc);
    return publicTrack(doc, user.id);
  });

const removeTrack = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const col = await collection<SubtitleDoc>("subtitles");
    await col.deleteOne({ _id: data.id, userId: user.id });
  });

const updateTiming = createServerFn({ method: "POST" })
  .validator(z.object({
    id: z.string().min(1),
    offset: z.number().min(-600).max(600),
    scale: z.number().min(0.9).max(1.1),
  }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const col = await collection<SubtitleDoc>("subtitles");
    const doc = await col.findOne({ _id: data.id });
    if (!doc) throw new Error("Subtitle not found");
    if (doc.userId !== user.id) throw new Error("You can only adjust subtitles you added");
    await col.updateOne(
      { _id: data.id },
      { $set: { offset: data.offset, scale: data.scale } },
    );
  });

export function listSubtitles(mediaId: string): Promise<SubtitleTrack[]> {
  return readTracks({ data: { mediaId } });
}

export function uploadSubtitle(input: {
  mediaId: string;
  lang: string;
  label: string;
  content: string;
}): Promise<SubtitleTrack> {
  return createUpload({ data: input });
}

export function addSubtitleFromUrl(input: {
  mediaId: string;
  lang: string;
  label: string;
  url: string;
}): Promise<SubtitleTrack> {
  return createFromUrl({ data: input });
}

export function deleteSubtitle(id: string): Promise<void> {
  return removeTrack({ data: { id } });
}

export function updateSubtitleTiming(input: {
  id: string;
  offset: number;
  scale: number;
}): Promise<void> {
  return updateTiming({ data: input });
}

/** Client-side WebVTT cue parser used for the embed overlay. */
export type SubtitleCue = { start: number; end: number; text: string };

function parseTimestamp(value: string): number {
  const parts = value.trim().split(":");
  if (parts.length !== 3) return NaN;
  const seconds = Number(parts[2].replace(",", "."));
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + seconds;
}

export function parseVttCues(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of content.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim());
    const start = parseTimestamp(startRaw ?? "");
    const end = parseTimestamp((endRaw ?? "").split(/\s+/)[0] ?? "");
    if (!isFinite(start) || !isFinite(end)) continue;
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

export function cueAtTime(cues: SubtitleCue[], time: number): SubtitleCue | null {
  return cues.find((cue) => time >= cue.start && time <= cue.end) ?? null;
}

export type SubtitleValidation = { cues: SubtitleCue[]; warnings: string[] };

/** Validate an uploaded file before saving and expose a short preview. */
export function validateSubtitle(content: string): SubtitleValidation {
  const cues = parseVttCues(toWebVtt(content));
  if (cues.length === 0) throw new Error("No valid subtitle cues found");

  const warnings: string[] = [];
  if (cues.some((cue, i) => i > 0 && cue.start < cues[i - 1].start)) {
    warnings.push("Beberapa cue tidak berurutan berdasarkan waktu.");
  }
  if (cues.some((cue) => cue.end <= cue.start)) {
    warnings.push("Ada cue dengan durasi nol atau negatif.");
  }
  const lastEnd = Math.max(...cues.map((cue) => cue.end));
  if (lastEnd > 24 * 3600) warnings.push("Durasi subtitle lebih dari 24 jam — periksa kembali file-nya.");

  return { cues, warnings };
}
