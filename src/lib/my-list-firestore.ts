import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection, now } from "./mongo";
import type { Movie } from "./types";

const MYLIST_COLLECTION = "my_list";

type MyListDoc = {
  _id: string;
  userId: string;
  profileId: string;
  movieId: string;
  addedAt: number;
  movie: Movie;
};

const movieSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  year: z.number(),
  rating: z.string(),
  runtime: z.string(),
  genres: z.array(z.string()),
  genreIds: z.array(z.number()),
  poster: z.string(),
  backdrop: z.string(),
  cast: z.array(z.string()),
  castPfp: z.array(z.string()),
  director: z.string(),
  directorId: z.string(),
  match: z.number(),
}).passthrough();

function docId(userId: string, profileId: string, movieId: string): string {
  return `${userId}_${profileId}_${movieId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

async function owner(userId: string, profileId: string) {
  const profiles = await collection<{ _id: string; userId: string }>("profiles");
  const found = await profiles.findOne({ _id: profileId, userId });
  if (!found) throw new Error("Profile not found");
}

const setEntry = createServerFn({ method: "POST" })
  .validator(z.object({ movie: movieSchema, inList: z.boolean(), profileId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<MyListDoc>(MYLIST_COLLECTION);
    const id = docId(userId, data.profileId, data.movie.id);
    if (!data.inList) {
      await col.deleteOne({ _id: id });
      return;
    }
    const doc: MyListDoc = {
      _id: id,
      userId,
      profileId: data.profileId,
      movieId: data.movie.id,
      addedAt: now().getTime(),
      movie: data.movie as Movie,
    };
    await col.replaceOne({ _id: id }, doc, { upsert: true });
  });

const removeEntry = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), profileId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<MyListDoc>(MYLIST_COLLECTION);
    await col.deleteOne({ _id: docId(userId, data.profileId, data.id) });
  });

const listEntries = createServerFn({ method: "GET" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<{ id: string; addedAt: number; movie: Movie }[]> => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<MyListDoc>(MYLIST_COLLECTION);
    const docs = await col
      .find({ userId, profileId: data.profileId })
      .sort({ addedAt: -1 })
      .toArray();
    return docs.filter((d) => d.movie).map((d) => ({ id: d.movieId, addedAt: d.addedAt, movie: d.movie }));
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

export async function setMyListInFirestore(movie: Movie, inList: boolean) {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  await setEntry({ data: { movie, inList, profileId } });
}

export async function removeMyListFromFirestore(id: string) {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  await removeEntry({ data: { id, profileId } });
}

export async function getMyListFromFirestore(): Promise<
  { id: string; addedAt: number; movie: Movie }[]
> {
  const profileId = getSelectedProfileId();
  if (!profileId) return [];
  return listEntries({ data: { profileId } });
}
