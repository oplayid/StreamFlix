import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection, now } from "./mongo";
import type { Movie } from "./types";

const CW_COLLECTION = "continue_watching";
const MAX = 12;

type FirestoreContinueDoc = FirestoreContinueItem & { _id: string };

export type FirestoreContinueItem = {
  id: string;
  userId: string;
  profileId: string;
  movieId: string;
  title: string;
  poster: string;
  backdrop: string;
  rating: string;
  runtime: string;
  genres: string[];
  genreIds: number[];
  match: number;
  score?: number;
  description: string;
  year: number;
  cast: string[];
  castPfp: string[];
  director: string;
  directorId: string;
  progress: number;
  duration: number;
  updatedAt: number;
  season?: number;
  episode?: number;
};

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  poster: z.string(),
  backdrop: z.string(),
  rating: z.string(),
  runtime: z.string(),
  genres: z.array(z.string()),
  genreIds: z.array(z.number()),
  match: z.number(),
  score: z.number().optional(),
  description: z.string(),
  year: z.number(),
  cast: z.array(z.string()),
  castPfp: z.array(z.string()),
  director: z.string(),
  directorId: z.string(),
}).passthrough();

async function owner(userId: string, profileId: string) {
  const profiles = await collection<{ _id: string; userId: string }>("profiles");
  const found = await profiles.findOne({ _id: profileId, userId });
  if (!found) throw new Error("Profile not found");
}

function makeDocId(movieId: string, season?: number, episode?: number) {
  return season != null && episode != null ? `${movieId}:S${season}E${episode}` : movieId;
}

const saveProgress = createServerFn({ method: "POST" })
  .validator(z.object({
    movie: itemSchema,
    progress: z.number(),
    duration: z.number(),
    season: z.number().optional(),
    episode: z.number().optional(),
    profileId: z.string(),
  }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<FirestoreContinueDoc>(CW_COLLECTION);
    const suffix = makeDocId(data.movie.id, data.season, data.episode);
    const id = `${userId}_${data.profileId}_${suffix.replace(/[^a-zA-Z0-9:]/g, "_")}`;
    if (data.duration > 0 && data.progress / data.duration >= 0.95) {
      await col.deleteOne({ _id: id });
      return;
    }
    if (data.progress <= 5) return;
    const m = data.movie;
    const doc: FirestoreContinueDoc = {
      _id: id,
      id,
      userId,
      profileId: data.profileId,
      movieId: m.id,
      title: m.title,
      poster: m.poster,
      backdrop: m.backdrop,
      rating: m.rating,
      runtime: m.runtime,
      genres: m.genres,
      genreIds: m.genreIds,
      match: m.match,
      score: m.score,
      description: m.description,
      year: m.year,
      cast: m.cast,
      castPfp: m.castPfp,
      director: m.director,
      directorId: m.directorId,
      progress: data.progress,
      duration: data.duration,
      updatedAt: now().getTime(),
      season: data.season,
      episode: data.episode,
    } as FirestoreContinueDoc;
    await col.replaceOne({ _id: id }, doc, { upsert: true });
  });

const listProgress = createServerFn({ method: "GET" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<FirestoreContinueItem[]> => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<FirestoreContinueDoc>(CW_COLLECTION);
    const docs = await col
      .find({ userId, profileId: data.profileId })
      .sort({ updatedAt: -1 })
      .limit(MAX)
      .toArray();
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: String(_id) }) as FirestoreContinueItem);
  });

function getSelectedProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("sf:selectedProfile");
    if (!raw) return null;
    return JSON.parse(raw).id ?? null;
  } catch {
    return null;
  }
}

export async function saveProgressToFirestore(
  movie: Movie,
  progress: number,
  duration: number,
  season?: number,
  episode?: number,
) {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  if (!duration || !isFinite(duration)) return;
  await saveProgress({ data: { movie, progress, duration, season, episode, profileId } });
}

export async function getContinueWatchingFromFirestore(): Promise<FirestoreContinueItem[]> {
  const profileId = getSelectedProfileId();
  if (!profileId) return [];
  return listProgress({ data: { profileId } });
}

export function toMovie(item: FirestoreContinueItem): Movie {
  return {
    id: item.movieId,
    title: item.title,
    description: item.description,
    year: item.year,
    rating: item.rating,
    runtime: item.runtime,
    genres: item.genres,
    genreIds: item.genreIds,
    poster: item.poster,
    backdrop: item.backdrop,
    cast: item.cast,
    castPfp: item.castPfp,
    director: item.director,
    directorId: item.directorId,
    match: item.match,
    score: item.score,
  };
}
