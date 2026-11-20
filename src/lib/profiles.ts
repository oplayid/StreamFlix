import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { collection, now } from "./mongo";

export type Profile = {
  id: string;
  userId: string;
  name: string;
  color: string;
  kids: boolean;
  avatarUrl?: string;
  pin?: string;
  hasPin?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type ProfileDoc = {
  _id: string;
  userId: string;
  name: string;
  color: string;
  kids: boolean;
  avatarUrl?: string;
  pinHash?: string;
  createdAt: Date;
  updatedAt: Date;
};

const profileColors = [
  "from-rose-500 to-red-700",
  "from-sky-500 to-indigo-700",
  "from-amber-400 to-orange-600",
  "from-emerald-400 to-teal-600",
  "from-violet-500 to-purple-700",
  "from-pink-500 to-rose-700",
  "from-cyan-500 to-blue-700",
  "from-lime-400 to-green-600",
];

function publicProfile(doc: ProfileDoc): Profile {
  return {
    id: doc._id,
    userId: doc.userId,
    name: doc.name,
    color: doc.color,
    kids: doc.kids,
    avatarUrl: doc.avatarUrl,
    hasPin: !!doc.pinHash,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function currentUserId(): Promise<string> {
  const { requireUser } = await import("./auth");
  return (await requireUser()).id;
}

async function profileCollection() {
  return collection<ProfileDoc>("profiles");
}

export const getUserProfilesFn = createServerFn({ method: "GET" })
  .validator(z.string().optional())
  .handler(async (): Promise<Profile[]> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const docs = await profiles.find({ userId }).sort({ createdAt: 1 }).toArray();
    return docs.map(publicProfile);
  });

export const createProfileFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z.string().min(1).max(50),
      kids: z.boolean().default(false),
      avatarUrl: z.string().optional(),
      pin: z.string().optional(),
    }),
  )
  .handler(async ({ data }): Promise<Profile> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const existing = await profiles.countDocuments({ userId });
    const doc: ProfileDoc = {
      _id: randomUUID(),
      userId,
      name: data.name,
      color: profileColors[existing % profileColors.length],
      kids: data.kids,
      avatarUrl: data.avatarUrl || undefined,
      ...(data.pin ? { pinHash: btoa(data.pin) } : {}),
      createdAt: now(),
      updatedAt: now(),
    };
    await profiles.insertOne(doc);
    return publicProfile(doc);
  });

export const updateProfileFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      profileId: z.string(),
      name: z.string().max(50).optional(),
      color: z.string().optional(),
      kids: z.boolean().optional(),
      avatarUrl: z.string().optional(),
    }),
  )
  .handler(async ({ data }): Promise<void> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const patch: Partial<ProfileDoc> = { updatedAt: now() };
    for (const key of ["name", "color", "kids", "avatarUrl"] as const) {
      if (data[key] !== undefined) (patch as Record<string, unknown>)[key] = data[key];
    }
    await profiles.updateOne({ _id: data.profileId, userId }, { $set: patch });
  });

export const deleteProfileFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<void> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    await profiles.deleteOne({ _id: data.profileId, userId });
  });

export const ensureUserHasProfileFn = createServerFn({ method: "POST" })
  .validator(z.string().optional())
  .handler(async ({ data: displayName }): Promise<Profile[]> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const docs = await profiles.find({ userId }).sort({ createdAt: 1 }).toArray();
    if (docs.length === 0) {
      const doc: ProfileDoc = {
        _id: randomUUID(),
        userId,
        name: displayName || "Profile 1",
        color: profileColors[0],
        kids: false,
        createdAt: now(),
        updatedAt: now(),
      };
      await profiles.insertOne(doc);
      return [publicProfile(doc)];
    }
    return docs.map(publicProfile);
  });

export const setProfilePinFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string(), pin: z.string() }))
  .handler(async ({ data }): Promise<void> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    await profiles.updateOne(
      { _id: data.profileId, userId },
      { $set: { pinHash: btoa(data.pin), updatedAt: now() } },
    );
  });

export const removeProfilePinFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<void> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    await profiles.updateOne(
      { _id: data.profileId, userId },
      { $unset: { pinHash: "" }, $set: { updatedAt: now() } },
    );
  });

export const verifyProfilePinFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string(), pin: z.string() }))
  .handler(async ({ data }): Promise<boolean> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const doc = await profiles.findOne({ _id: data.profileId, userId });
    if (!doc) return false;
    if (!doc.pinHash) return true;
    return doc.pinHash === btoa(data.pin);
  });

export const profileHasPinFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<boolean> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const doc = await profiles.findOne({ _id: data.profileId, userId });
    return !!doc?.pinHash;
  });

export const isKidsProfileOnServerFn = createServerFn({ method: "POST" })
  .validator(z.object({ profileId: z.string() }))
  .handler(async ({ data }): Promise<boolean> => {
    const userId = await currentUserId();
    const profiles = await profileCollection();
    const doc = await profiles.findOne({ _id: data.profileId, userId });
    return !!doc?.kids;
  });

// Backwards-compatible wrappers. The rest of the app still calls these with the
// old positional arguments; the authenticated user comes from the Pocket ID session.
export function getUserProfiles(_userId?: string): Promise<Profile[]> {
  return getUserProfilesFn({ data: undefined });
}

export function createProfile(
  _userId: string,
  data: { name: string; kids?: boolean; avatarUrl?: string; pin?: string },
): Promise<Profile> {
  return createProfileFn({ data: { ...data, kids: data.kids ?? false } });
}

export function updateProfile(
  _userId: string,
  profileId: string,
  patch: { name?: string; color?: string; kids?: boolean; avatarUrl?: string },
): Promise<void> {
  return updateProfileFn({ data: { profileId, ...patch } });
}

export function deleteProfile(_userId: string, profileId: string): Promise<void> {
  return deleteProfileFn({ data: { profileId } });
}

export function ensureUserHasProfile(_userId: string, displayName?: string): Promise<Profile[]> {
  return ensureUserHasProfileFn({ data: displayName });
}

export function setProfilePin(_userId: string, profileId: string, pin: string): Promise<void> {
  return setProfilePinFn({ data: { profileId, pin } });
}

export function removeProfilePin(_userId: string, profileId: string): Promise<void> {
  return removeProfilePinFn({ data: { profileId } });
}

export function verifyProfilePin(_userId: string, profileId: string, pin: string): Promise<boolean> {
  return verifyProfilePinFn({ data: { profileId, pin } });
}

export function profileHasPin(_userId: string, profileId: string): Promise<boolean> {
  return profileHasPinFn({ data: { profileId } });
}

export function isKidsProfileOnServer(_userId: string, profileId: string): Promise<boolean> {
  return isKidsProfileOnServerFn({ data: { profileId } });
}
