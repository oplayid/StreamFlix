import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection, now } from "./mongo";

export type ReleaseNotification = {
  id: string;
  user_id: string;
  movie_id: string;
  title: string;
  poster: string;
  release_date: string;
  created_at?: string;
  reminded_at?: string | null;
};

export type NotifiableItem = {
  id: string;
  title: string;
  poster: string;
  releaseDate: string;
};

type NotificationDoc = {
  _id: string;
  user_id: string;
  movie_id: string;
  title: string;
  poster: string;
  release_date: string;
  created_at: Date;
  reminded_at?: Date | null;
};

function toPublic(doc: NotificationDoc): ReleaseNotification {
  return {
    id: doc._id,
    user_id: doc.user_id,
    movie_id: doc.movie_id,
    title: doc.title,
    poster: doc.poster,
    release_date: doc.release_date,
    created_at: doc.created_at.toISOString(),
    reminded_at: doc.reminded_at ? doc.reminded_at.toISOString() : null,
  };
}

const toggle = createServerFn({ method: "POST" })
  .validator(z.object({ item: z.object({
    id: z.string(),
    title: z.string(),
    poster: z.string(),
    releaseDate: z.string(),
  }) }))
  .handler(async ({ data }): Promise<boolean> => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const col = await collection<NotificationDoc>("release_notifications");
    const id = `${userId}_${data.item.id}`;
    const existing = await col.findOne({ _id: id });
    if (existing) {
      await col.deleteOne({ _id: id });
      return false;
    }
    await col.insertOne({
      _id: id,
      user_id: userId,
      movie_id: data.item.id,
      title: data.item.title,
      poster: data.item.poster,
      release_date: data.item.releaseDate,
      created_at: now(),
      reminded_at: null,
    });
    return true;
  });

const list = createServerFn({ method: "GET" }).handler(async (): Promise<ReleaseNotification[]> => {
  const { requireUser } = await import("./auth");
  const userId = (await requireUser()).id;
  const col = await collection<NotificationDoc>("release_notifications");
  const docs = await col.find({ user_id: userId }).toArray();
  return docs.map(toPublic);
});

const mark = createServerFn({ method: "POST" })
  .validator(z.object({ movieId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const col = await collection<NotificationDoc>("release_notifications");
    await col.updateOne(
      { _id: `${userId}_${data.movieId}` },
      { $set: { reminded_at: now() } },
    );
  });

export async function toggleReleaseNotification(_userId: string, item: NotifiableItem): Promise<boolean> {
  return toggle({ data: { item } });
}

export async function getUserNotifications(_userId?: string): Promise<ReleaseNotification[]> {
  return list();
}

export async function getNotifiedIds(userId?: string): Promise<Set<string>> {
  const rows = await getUserNotifications(userId);
  return new Set(rows.map((n) => n.movie_id));
}

export async function markReminded(_userId: string, movieId: string): Promise<void> {
  await mark({ data: { movieId } });
}
