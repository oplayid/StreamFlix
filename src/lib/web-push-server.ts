import { sendNotification, setVapidDetails } from "web-push";
import { collection, now } from "./mongo";

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  movie_id?: string;
  image?: string;
};

type SubscriptionDoc = {
  _id: string;
  user_id: string;
  device_id: string;
  subscription: {
    endpoint: string;
    keys?: { p256dh?: string; auth?: string };
  };
  last_seen_at: Date;
};

let configured = false;

function configure(): boolean {
  if (configured) return true;
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VITE_WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  const subject = process.env.WEB_PUSH_SUBJECT;
  if (!publicKey || !privateKey || !subject) return false;
  setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function isWebPushConfigured(): boolean {
  return !!(process.env.WEB_PUSH_PRIVATE_KEY && (process.env.WEB_PUSH_PUBLIC_KEY || process.env.VITE_WEB_PUSH_PUBLIC_KEY));
}

/** Sends a Web Push payload to every subscription owned by the given users. */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<{ successCount: number; failureCount: number; total: number }> {
  if (userIds.length === 0 || !configure()) {
    return { successCount: 0, failureCount: 0, total: 0 };
  }
  const col = await collection<SubscriptionDoc>("web_push_subscriptions");
  const docs = await col.find({ user_id: { $in: userIds } }).toArray();
  if (docs.length === 0) return { successCount: 0, failureCount: 0, total: 0 };

  let successCount = 0;
  let failureCount = 0;
  const staleEndpoints: string[] = [];

  await Promise.all(
    docs.map(async (doc) => {
      const { endpoint, keys } = doc.subscription ?? {};
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        failureCount += 1;
        return;
      }
      try {
        await sendNotification(
          { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
          JSON.stringify({ type: "OPLAY_PUSH", ...payload }),
        );
        successCount += 1;
        await col.updateOne({ _id: doc._id }, { $set: { last_seen_at: now() } });
      } catch (error) {
        failureCount += 1;
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) staleEndpoints.push(doc._id);
      }
    }),
  );

  if (staleEndpoints.length) await col.deleteMany({ _id: { $in: staleEndpoints } });
  return { successCount, failureCount, total: docs.length };
}
