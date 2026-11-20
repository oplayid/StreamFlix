import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection } from "./mongo";

export const GENRE_OPTIONS = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 14, name: "Fantasy" },
  { id: 36, name: "History" },
  { id: 27, name: "Horror" },
  { id: 10402, name: "Music" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Sci-Fi" },
  { id: 53, name: "Thriller" },
  { id: 10752, name: "War" },
  { id: 37, name: "Western" },
];

type UserDoc = { _id: string; favoriteGenres?: number[] };

const readGenres = createServerFn({ method: "GET" }).handler(async (): Promise<number[]> => {
  const { requireUser } = await import("./auth");
  const userId = (await requireUser()).id;
  const users = await collection<UserDoc>("users");
  const user = await users.findOne({ _id: userId });
  return Array.isArray(user?.favoriteGenres) ? user!.favoriteGenres! : [];
});

const writeGenres = createServerFn({ method: "POST" })
  .validator(z.object({ genreIds: z.array(z.number()) }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const users = await collection<UserDoc>("users");
    await users.updateOne({ _id: userId }, { $set: { favoriteGenres: data.genreIds } }, { upsert: true });
  });

export async function getFavoriteGenres(_userId?: string): Promise<number[]> {
  return readGenres();
}

export async function setFavoriteGenres(_userId: string, genreIds: number[]): Promise<void> {
  await writeGenres({ data: { genreIds } });
}
