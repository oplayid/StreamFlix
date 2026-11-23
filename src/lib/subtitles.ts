import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { collection, now } from "./mongo";

export type SubtitleTrack = {
  id: string;
  mediaId: string;
  lang: string;
  label: string;
  source: "upload" | "url" | "subdl";
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
  source: "upload" | "url" | "subdl";
  origin?: string;
  externalId?: string;
  content: string;
  offset?: number;
  scale?: number;
  createdAt: Date;
};

const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;
const mediaIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(tv-)?\d+$/);

/** Indonesian is preferred, then English, then any other language. */
export function normalizeLang(lang: string): string {
  const value = lang.trim().toLowerCase();
  if (["id", "ids", "ind", "in", "id-id", "indonesia", "bahasa indonesia"].includes(value))
    return "id";
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
  const text = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
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
    const times = lines[timeIndex].replace(/\s*-->\s*/, " --> ").replace(/(\d),(\d{3})/g, "$1.$2");
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
  .validator(
    z.object({
      mediaId: mediaIdSchema,
      lang: z.string().min(2).max(20),
      label: z.string().min(1).max(60),
      content: z.string().min(1),
    }),
  )
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
  .validator(
    z.object({
      mediaId: mediaIdSchema,
      lang: z.string().min(2).max(20),
      label: z.string().min(1).max(60),
      url: z.string().url().max(2000),
    }),
  )
  .handler(async ({ data }): Promise<SubtitleTrack> => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const parsed = new URL(data.url);
    if (!/^https?:$/.test(parsed.protocol))
      throw new Error("Only http(s) subtitle URLs are allowed");

    const res = await fetch(parsed, {
      headers: { "User-Agent": "OPLAY.ID-Subtitle-Fetch/1.0", Accept: "*/*" },
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
  .validator(
    z.object({
      id: z.string().min(1),
      offset: z.number().min(-600).max(600),
      scale: z.number().min(0.9).max(1.1),
    }),
  )
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const col = await collection<SubtitleDoc>("subtitles");
    const doc = await col.findOne({ _id: data.id });
    if (!doc) throw new Error("Subtitle not found");
    if (doc.userId !== user.id) throw new Error("You can only adjust subtitles you added");
    await col.updateOne({ _id: data.id }, { $set: { offset: data.offset, scale: data.scale } });
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

export type SubdlSubtitleResult = {
  id: string;
  lang: string;
  label: string;
  releaseName: string;
  author?: string;
  hi: boolean;
  downloadPath: string;
  format: string;
};

type SubdlApiSubtitle = {
  release_name?: string;
  name?: string;
  lang?: string;
  language?: string;
  author?: string;
  url?: string;
  hi?: boolean;
  season?: number | null;
  episode?: number | null;
  full_season?: boolean;
  episode_from?: number | null;
  episode_end?: number | null;
  unpack_files?: Array<{
    file_n_id?: string;
    name?: string;
    release_name?: string;
    season?: number;
    episode?: number;
    language?: string;
    hi?: boolean;
    format?: string;
    url?: string;
  }>;
};

type SubdlApiResponse = {
  status?: boolean;
  error?: string;
  message?: string;
  subtitles?: SubdlApiSubtitle[];
};

function subdlApiKey(): string {
  const key = process.env.SUBDL_API_KEY?.trim();
  if (!key) throw new Error("SUBDL_API_KEY belum dikonfigurasi di server");
  return key;
}

function sanitizeSubdlPath(path: string): string {
  const clean = path.split("?")[0]?.trim() ?? "";
  if (!/^\/subtitle\/[A-Za-z0-9/_-]+$/.test(clean)) {
    throw new Error("Path subtitle SubDL tidak valid");
  }
  return clean;
}

function mediaToSubdlQuery(mediaId: string, season?: number, episode?: number) {
  const isTv = mediaId.startsWith("tv-");
  const tmdbId = Number(mediaId.replace(/^tv-/, ""));
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw new Error("mediaId tidak valid");
  return {
    tmdbId: String(tmdbId),
    type: isTv ? "tv" : "movie",
    season: isTv && typeof season === "number" ? season : undefined,
    episode: isTv && typeof episode === "number" ? episode : undefined,
  };
}

const searchSubdl = createServerFn({ method: "GET" })
  .validator(
    z.object({
      mediaId: mediaIdSchema,
      season: z.number().int().min(0).optional(),
      episode: z.number().int().min(0).optional(),
      languages: z.string().max(50).optional(),
    }),
  )
  .handler(async ({ data }): Promise<SubdlSubtitleResult[]> => {
    const apiKey = subdlApiKey();
    const q = mediaToSubdlQuery(data.mediaId, data.season, data.episode);
    const params = new URLSearchParams({
      api_key: apiKey,
      tmdb_id: q.tmdbId,
      type: q.type,
      languages: data.languages?.trim() || "ID,EN",
      subs_per_page: "30",
      unpack: "1",
    });
    if (q.type === "tv" && typeof q.season === "number")
      params.set("season_number", String(q.season));
    if (q.type === "tv" && typeof q.episode === "number")
      params.set("episode_number", String(q.episode));

    const res = await fetch(`https://api.subdl.com/api/v1/subtitles?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": "OPLAY.ID-SubDL/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`SubDL API error ${res.status}`);
    const json = (await res.json()) as SubdlApiResponse;
    if (!json.status) {
      const msg = json.error || json.message || "SubDL tidak mengembalikan hasil";
      if (/can't find|not found/i.test(msg)) return [];
      throw new Error(msg);
    }

    const out: SubdlSubtitleResult[] = [];
    for (const sub of json.subtitles ?? []) {
      const files = sub.unpack_files?.length ? sub.unpack_files : [];
      for (const file of files) {
        const rawPath = file.url || sub.url;
        if (!rawPath) continue;
        let downloadPath: string;
        try {
          downloadPath = sanitizeSubdlPath(rawPath);
        } catch {
          continue;
        }
        const langCode = normalizeLang(file.language || sub.language || sub.lang || "en");
        const hi = !!(file.hi ?? sub.hi);
        const releaseName =
          file.release_name || file.name || sub.release_name || sub.name || "Subtitle";
        out.push({
          id: `${downloadPath}:${langCode}:${hi ? "hi" : "n"}`,
          lang: langCode,
          label: `${languageLabel(langCode)}${hi ? " (HI)" : ""} · ${releaseName}`.slice(0, 120),
          releaseName,
          author: sub.author,
          hi,
          downloadPath,
          format: (file.format || "srt").toLowerCase(),
        });
      }
    }

    const seen = new Set<string>();
    return out
      .filter((item) => {
        const key = item.downloadPath;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 40);
  });

const importSubdl = createServerFn({ method: "POST" })
  .validator(
    z.object({
      mediaId: mediaIdSchema,
      lang: z.string().min(2).max(20),
      label: z.string().min(1).max(120),
      downloadPath: z.string().min(1).max(500),
      releaseName: z.string().max(200).optional(),
    }),
  )
  .handler(async ({ data }): Promise<SubtitleTrack> => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const apiKey = subdlApiKey();
    const downloadPath = sanitizeSubdlPath(data.downloadPath);

    const col = await collection<SubtitleDoc>("subtitles");
    const existing = await col.findOne({
      mediaId: data.mediaId,
      externalId: `subdl:${downloadPath}`,
    });
    if (existing) return publicTrack(existing, user.id);

    const dlUrl = new URL(`https://dl.subdl.com${downloadPath}`);
    dlUrl.searchParams.set("api_key", apiKey);
    const res = await fetch(dlUrl, {
      headers: { "User-Agent": "OPLAY.ID-SubDL/1.0", Accept: "*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`SubDL download gagal (${res.status})`);
    const raw = await res.text();
    const content = toWebVtt(raw);

    const doc: SubtitleDoc = {
      _id: randomUUID(),
      mediaId: data.mediaId,
      userId: user.id,
      lang: normalizeLang(data.lang),
      label: data.label.slice(0, 60),
      source: "subdl",
      origin: "subdl.com",
      externalId: `subdl:${downloadPath}`,
      content,
      createdAt: now(),
    };
    await col.insertOne(doc);
    return publicTrack(doc, user.id);
  });

export function searchSubdlSubtitles(input: {
  mediaId: string;
  season?: number;
  episode?: number;
  languages?: string;
}): Promise<SubdlSubtitleResult[]> {
  return searchSubdl({ data: input });
}

export function importSubdlSubtitle(input: {
  mediaId: string;
  lang: string;
  label: string;
  downloadPath: string;
  releaseName?: string;
}): Promise<SubtitleTrack> {
  return importSubdl({ data: input });
}

// ---------------------------------------------------------------------------
// mfp.oplay.id shared subtitle bridge
//
// SubDL is searched and imported inside the mfp iframe. When a viewer picks a
// result, mfp emits `subdlImported` and Streamflix stores the VTT as a shared
// track (userId: null) so every account can restore it. No schema change: the
// existing subtitles collection and externalId dedupe key are reused.
// ---------------------------------------------------------------------------

const MFP_ORIGIN = "https://mfp.oplay.id";

export type SharedMfpSubtitle = {
  id: string;
  lang: string;
  label: string;
  content: string;
  externalId: string;
};

const storeMfpSubtitle = createServerFn({ method: "POST" })
  .validator(
    z.object({
      mediaId: mediaIdSchema,
      lang: z.string().min(2).max(20),
      label: z.string().min(1).max(120),
      downloadPath: z.string().min(1).max(500),
      url: z.string().url().max(2000),
    }),
  )
  .handler(async ({ data }): Promise<SubtitleTrack> => {
    const { requireUser } = await import("./auth");
    await requireUser(); // only signed-in viewers may seed a shared track
    const downloadPath = sanitizeSubdlPath(data.downloadPath);
    const signed = new URL(data.url);
    if (signed.origin !== MFP_ORIGIN || !signed.pathname.startsWith("/_token_")) {
      throw new Error("URL subtitle MediaFlow tidak dikenali");
    }

    // The VTT lives behind mfp's signed capability URL. The key never travels
    // to the browser; Streamflix fetches server-side and stores the content.
    const res = await fetch(signed, {
      headers: { "User-Agent": "OPLAY.ID-SubDL/1.0", Accept: "text/vtt,*/*" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Gagal mengambil subtitle MediaFlow (${res.status})`);
    const content = toWebVtt(await res.text());

    const col = await collection<SubtitleDoc>("subtitles");
    const externalId = `subdl:${downloadPath}`;
    const existing = await col.findOne({ externalId });
    if (existing) return publicTrack(existing, null);

    const doc: SubtitleDoc = {
      _id: randomUUID(),
      mediaId: data.mediaId,
      userId: null,
      lang: normalizeLang(data.lang),
      label: data.label.slice(0, 60),
      source: "subdl",
      origin: "mfp.oplay.id",
      externalId,
      content,
      createdAt: now(),
    };
    await col.insertOne(doc);
    return publicTrack(doc, null);
  });

const readSharedMfpSubtitles = createServerFn({ method: "GET" })
  .validator(z.object({ mediaId: mediaIdSchema }))
  .handler(async ({ data }): Promise<SharedMfpSubtitle[]> => {
    const col = await collection<SubtitleDoc>("subtitles");
    const docs = await col
      .find({
        userId: null,
        origin: "mfp.oplay.id",
        $or: [{ mediaId: data.mediaId }, { mediaId: data.mediaId.replace(/^tv-/, "") }],
      })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((doc) => ({
      id: doc._id,
      lang: doc.lang,
      label: doc.label,
      content: doc.content,
      externalId: doc.externalId ?? "",
    }));
  });

export function saveMfpSubtitle(input: {
  mediaId: string;
  lang: string;
  label: string;
  downloadPath: string;
  url: string;
}): Promise<SubtitleTrack> {
  return storeMfpSubtitle({ data: input });
}

export function sharedMfpSubtitles(mediaId: string): Promise<SharedMfpSubtitle[]> {
  return readSharedMfpSubtitles({ data: { mediaId } });
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
    const text = lines
      .slice(timeIndex + 1)
      .join("\n")
      .trim();
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
  if (lastEnd > 24 * 3600)
    warnings.push("Durasi subtitle lebih dari 24 jam — periksa kembali file-nya.");

  return { cues, warnings };
}
