import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getDeviceId } from "./device-tracking";

export type PushStatus = "granted" | "denied" | "unavailable" | "no-vapid";

const SW_URL = "/sw-new.js";

const publicKey = (): string => {
  const value = (import.meta as any).env?.VITE_WEB_PUSH_PUBLIC_KEY as string | undefined;
  return (value || "").trim();
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

type SubscriptionDoc = {
  _id: string;
  user_id: string;
  device_id: string;
  platform: string;
  subscription: Record<string, unknown>;
  user_agent: string;
  created_at: Date;
  last_seen_at: Date;
};

const saveSubscription = createServerFn({ method: "POST" })
  .validator(z.object({
    subscription: z.record(z.unknown()),
    device_id: z.string(),
    platform: z.string(),
    user_agent: z.string().default(""),
  }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const { collection, now } = await import("./mongo");
    const userId = (await requireUser()).id;
    const endpoint = String(data.subscription.endpoint ?? "");
    if (!endpoint) return;
    const col = await collection<SubscriptionDoc>("web_push_subscriptions");
    const existing = await col.findOne({ _id: endpoint });
    const timestamp = now();
    await col.replaceOne(
      { _id: endpoint },
      {
        user_id: userId,
        device_id: data.device_id,
        platform: data.platform,
        subscription: data.subscription,
        user_agent: data.user_agent,
        created_at: existing?.created_at ?? timestamp,
        last_seen_at: timestamp,
      },
      { upsert: true },
    );
  });

export async function checkPushSupport(): Promise<{ ok: boolean; reason?: string }> {
  if (typeof window === "undefined") return { ok: false, reason: "Server" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "Browser does not support web push" };
  }
  if (!publicKey()) return { ok: false, reason: "VAPID public key is not configured" };
  return { ok: true };
}

export async function requestCapacitorNotificationPermission(): Promise<boolean> {
  // Native Capacitor push is FCM-specific and is not part of this self-hosted build.
  return false;
}

export async function ensurePushSubscription(): Promise<PushStatus> {
  const support = await checkPushSupport();
  if (!support.ok) return support.reason?.includes("VAPID") ? "no-vapid" : "unavailable";
  const { getSession } = await import("./session");
  const user = await getSession();
  if (!user) return "unavailable";

  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return "denied";

    const registration = await navigator.serviceWorker.register(SW_URL, {
      scope: "/",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey()).buffer as ArrayBuffer,
      }));

    await saveSubscription({
      data: {
        subscription: subscription.toJSON() as Record<string, unknown>,
        device_id: getDeviceId(),
        platform: "web",
        user_agent: navigator.userAgent,
      },
    });
    return "granted";
  } catch (error) {
    console.error("Web push subscription failed", error);
    return "unavailable";
  }
}

export function setupForegroundPush(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; title?: string; body?: string; url?: string } | null;
    if (data?.type !== "OPLAY_PUSH" || !data.title) return;
    try {
      new Notification(data.title, { body: data.body, icon: "/icon.png", tag: "oplayid" });
    } catch {
      // Notification permission may have been revoked.
    }
  });
}
