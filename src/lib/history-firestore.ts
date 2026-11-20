import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection } from "./mongo";
import type { WatchHistoryItem } from "./continue-watching";

const HISTORY_COLLECTION = "watch_history";
const MAX = 50;

type HistoryDoc = WatchHistoryItem & {
  _id: string;
  movieId: string;
  userId: string;
  profileId: string;
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
  progress: z.number(),
  duration: z.number(),
  updatedAt: z.number(),
  watchedAt: z.number(),
  season: z.number().optional(),
  episode: z.number().optional(),
}).passthrough();

async function owner(userId: string, profileId: string) {
  const profiles = await collection<{ _id: string; userId: string }>("profiles");
  const found = await profiles.findOne({ _id: profileId, userId });
  if (!found) throw new Error("Profile not found");
}

const save = createServerFn({ method: "POST" })
  .validator(z.object({ item: itemSchema, profileId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<HistoryDoc>(HISTORY_COLLECTION);
    const id = `${userId}_${data.profileId}_${data.item.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const doc = {
      ...data.item,
      _id: id,
      movieId: data.item.id.split(":")[0],
      userId,
      profileId: data.profileId,
    } as HistoryDoc;
    await col.replaceOne({ _id: id }, doc, { upsert: true });
  });

const remove = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string(), profileId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<HistoryDoc>(HISTORY_COLLECTION);
    const docs = await col.find({ userId, profileId: data.profileId }).toArray();
    const targets = docs.filter((d) => d.movieId === data.itemId || d.id === data.itemId);
    await Promise.all(targets.map((d) => col.deleteOne({ _id: d._id })));
  });

const clear = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<HistoryDoc>(HISTORY_COLLECTION);
    await col.deleteMany({ userId, profileId: data.profileId });
  });

const list = createServerFn({ method: "GET" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<WatchHistoryItem[]> => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    await owner(userId, data.profileId);
    const col = await collection<HistoryDoc>(HISTORY_COLLECTION);
    const docs = await col
      .find({ userId, profileId: data.profileId })
      .sort({ watchedAt: -1 })
      .limit(MAX)
      .toArray();
    return docs.map(({ _id: _ignored, ...rest }) => rest as WatchHistoryItem);
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

export async function saveHistoryToFirestore(item: WatchHistoryItem) {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  await save({ data: { item, profileId } });
}

export async function removeHistoryFromFirestore(itemId: string) {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  await remove({ data: { itemId, profileId } });
}

export async function clearHistoryFromFirestore() {
  const profileId = getSelectedProfileId();
  if (!profileId) return;
  await clear({ data: { profileId } });
}

export async function getWatchHistoryFromFirestore(): Promise<WatchHistoryItem[]> {
  const profileId = getSelectedProfileId();
  if (!profileId) return [];
  return list({ data: { profileId } });
}
