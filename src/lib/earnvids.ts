import { createHmac } from "node:crypto";
import { collection } from "./mongo";

/**
 * Server-only EarnVids bridge. StreamFlix sends media identity plus an HMAC to
 * mfp; mfp resolves the source, signs a same-origin proxy URL and asks EarnVids
 * to fetch it. The EarnVids API key, the shared HMAC secret and the original
 * provider URL never reach the browser or MongoDB.
 */

const MFP_ORIGIN = (process.env.MFP_ORIGIN ?? "https://mfp.oplay.id").replace(/\/+$/, "");
const COLLECTION = "earnvids_assets";
const EARNVIDS_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

export type EarnvidsMediaType = "movie" | "tv";
export type EarnvidsAssetStatus = "queued" | "uploading" | "encoding" | "uploaded" | "failed";

export type EarnvidsUploadInput = {
  type: EarnvidsMediaType;
  id: string | number;
  season?: string | number;
  episode?: string | number;
  quality?: string;
  source?: string;
  title?: string;
  filePublic?: boolean;
};

export type EarnvidsAssetDoc = {
  _id: string;
  tmdb_id: string;
  type: EarnvidsMediaType;
  season: string;
  episode: string;
  quality: string;
  source_host: string;
  earnvids_filecode: string;
  /** Verified API `link`; empty until EarnVids reports a playable player URL. */
  earnvids_player_url: string;
  status: EarnvidsAssetStatus;
  progress: number;
  title: string;
  year: string;
  overview: string;
  duration: number;
  error: string;
  checkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type UploadResponse = {
  filecode: string;
  source: string;
  quality: string;
  player_url?: string;
  title?: string;
  year?: string;
  overview?: string;
  media: { type: string; id: string; season: string; episode: string };
};

type StatusResponse = {
  filecode: string;
  state?: string;
  status?: string;
  progress: number;
  canplay?: boolean;
  player_url?: string;
  title?: string;
  duration?: number;
  error?: string | null;
  requests_available?: number;
};

function assetKey(
  type: string,
  id: string,
  season: string,
  episode: string,
  quality: string,
): string {
  return `${type}:${id}:${season}:${episode}:${quality || "auto"}`;
}

function mapState(raw: string, canplay: boolean): EarnvidsAssetStatus {
  const value = raw.trim().toLowerCase();
  if (canplay || ["uploaded", "converted", "ready", "done", "public"].includes(value)) {
    return "uploaded";
  }
  if (["failed", "error", "deleted"].includes(value)) return "failed";
  if (["encoding", "converting"].includes(value)) return "encoding";
  if (["uploading", "pending", "downloading"].includes(value)) return "uploading";
  return "queued";
}

async function postToMfp<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const secret = process.env.MFP_EARNVIDS_SECRET;
  if (!secret) throw new Error("MFP_EARNVIDS_SECRET is not configured");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

  const response = await fetch(`${MFP_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mfp-timestamp": timestamp,
      "x-mfp-signature": signature,
    },
    body: payload,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });

  if (!response.ok) {
    let detail = "";
    try {
      const error = (await response.json()) as { detail?: unknown };
      detail = typeof error.detail === "string" ? error.detail : "";
    } catch {
      // Keep the generic status; never echo an unexpected upstream body.
    }
    throw new Error(`mfp ${path} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  return (await response.json()) as T;
}

export async function uploadToEarnvids(input: EarnvidsUploadInput): Promise<EarnvidsAssetDoc> {
  if (input.type !== "movie" && input.type !== "tv") throw new Error("type must be movie or tv");

  const id = String(input.id ?? "")
    .replace(/^tv-/i, "")
    .trim();
  if (!/^\d+$/.test(id)) throw new Error("id must be a numeric TMDB id");

  const season = String(input.season ?? "1");
  const episode = String(input.episode ?? "1");
  const quality = String(input.quality ?? "").trim();
  const title = String(input.title ?? "").trim();
  const key = assetKey(input.type, id, season, episode, quality);
  const col = await collection<EarnvidsAssetDoc>(COLLECTION);

  const existing = await col.findOne({ _id: key });
  if (existing && existing.status !== "failed") return existing;
  if (
    existing?.status === "failed" &&
    Date.now() - new Date(existing.checkedAt).getTime() < EARNVIDS_RETRY_COOLDOWN_MS
  ) {
    return existing;
  }

  const result = await postToMfp<UploadResponse>("/internal/earnvids/upload", {
    type: input.type,
    id,
    season,
    episode,
    ...(quality ? { quality } : {}),
    source: input.source ?? "auto",
    ...(title ? { title } : {}),
    file_public: input.filePublic !== false,
  });

  if (!/^[A-Za-z0-9_-]+$/.test(result.filecode ?? "")) {
    throw new Error("mfp returned an invalid filecode");
  }

  const doc: EarnvidsAssetDoc = {
    _id: key,
    tmdb_id: id,
    type: input.type,
    season,
    episode,
    quality: result.quality || quality || "auto",
    source_host: result.source || "auto",
    earnvids_filecode: result.filecode,
    earnvids_player_url: result.player_url ?? "",
    status: "queued",
    progress: 0,
    title: result.title || title || "",
    year: result.year || "",
    overview: result.overview || "",
    duration: 0,
    error: "",
    checkedAt: new Date(),
    createdAt: existing?.createdAt ?? new Date(),
    updatedAt: new Date(),
  };

  const { _id, ...fields } = doc;
  await col.replaceOne({ _id }, { _id, ...fields }, { upsert: true });
  return doc;
}

export async function checkEarnvidsUpload(fileCode: string): Promise<EarnvidsAssetDoc | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(fileCode)) throw new Error("invalid file_code");

  const result = await postToMfp<StatusResponse>("/internal/earnvids/status", {
    file_code: fileCode,
  });
  const col = await collection<EarnvidsAssetDoc>(COLLECTION);
  const doc = await col.findOne({ earnvids_filecode: fileCode });
  if (!doc) return null;

  const status = mapState(result.state ?? result.status ?? "", Boolean(result.canplay));
  const progress = Number(result.progress) || 0;
  const patch: Partial<EarnvidsAssetDoc> = {
    status,
    progress,
    title: result.title || doc.title,
    duration: Number(result.duration) || doc.duration,
    error: result.error ?? "",
    checkedAt: new Date(),
    updatedAt: new Date(),
  };
  if (result.player_url) patch.earnvids_player_url = result.player_url;

  await col.updateOne({ _id: doc._id }, { $set: patch });
  return { ...doc, ...patch };
}

export async function getEarnvidsAsset(
  type: EarnvidsMediaType,
  id: string | number,
  season?: string | number,
  episode?: string | number,
  quality?: string,
): Promise<EarnvidsAssetDoc | null> {
  const key = assetKey(
    type,
    String(id ?? "").replace(/^tv-/i, ""),
    String(season ?? "1"),
    String(episode ?? "1"),
    String(quality ?? "").trim(),
  );
  const col = await collection<EarnvidsAssetDoc>(COLLECTION);
  return col.findOne({ _id: key });
}

export function publicEarnvidsAsset(doc: EarnvidsAssetDoc) {
  const { _id, ...rest } = doc;
  return { ...rest, key: _id };
}
