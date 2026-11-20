import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { collection, now } from "./mongo";
import { getDeviceId } from "./device-tracking";
import { hasConsent } from "./consent";

type SessionDoc = {
  _id: string;
  userId: string;
  profileId: string;
  movieId: string;
  deviceId: string;
  startedAt: Date;
  lastActiveAt: Date;
};

function getSelectedProfileId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("sf:selectedProfile");
    if (!raw) return null;
    return JSON.parse(raw).id ?? null;
  } catch {
    return null;
  }
}

const start = createServerFn({ method: "POST" })
  .validator(z.object({ movieId: z.string(), profileId: z.string(), deviceId: z.string() }))
  .handler(async ({ data }): Promise<string> => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const col = await collection<SessionDoc>("playback_sessions");
    const id = randomUUID();
    await col.insertOne({
      _id: id,
      userId,
      profileId: data.profileId,
      movieId: data.movieId,
      deviceId: data.deviceId,
      startedAt: now(),
      lastActiveAt: now(),
    });
    return id;
  });

const end = createServerFn({ method: "POST" })
  .validator(z.object({ sessionId: z.string() }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const col = await collection<SessionDoc>("playback_sessions");
    await col.deleteOne({ _id: data.sessionId, userId });
  });

const countActive = createServerFn({ method: "GET" }).handler(async (): Promise<number> => {
  const { requireUser } = await import("./auth");
  const userId = (await requireUser()).id;
  const col = await collection<SessionDoc>("playback_sessions");
  return col.countDocuments({ userId });
});

export async function startSession(movieId: string): Promise<string | null> {
  if (!hasConsent()) return null;
  const profileId = getSelectedProfileId();
  if (!profileId) return null;
  return start({ data: { movieId, profileId, deviceId: getDeviceId() } });
}

export async function endSession(sessionId: string): Promise<void> {
  await end({ data: { sessionId } });
}

export async function getActiveSessionCount(_userId?: string): Promise<number> {
  return countActive();
}

export async function cleanupSessions(): Promise<void> {
  // TTL index on lastActiveAt handles cleanup; this is kept for compatibility.
  const { getDb } = await import("./mongo");
  const db = await getDb();
  await db.collection("playback_sessions").deleteMany({
    lastActiveAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
}
