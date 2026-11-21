import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection, now } from "./mongo";
import { hasConsent } from "./consent";
import { readMigratedStorage } from "./storage-migration";

const DEVICE_ID_KEY = "oplayid_device_id";
const LEGACY_DEVICE_ID_KEY = "streamflix_device_id";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = readMigratedStorage(DEVICE_ID_KEY, LEGACY_DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function parseUserAgent(ua: string): { browser: string; os: string; label: string } {
  const u = ua || "";
  let browser = "Browser";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\//.test(u) || /Opera/.test(u)) browser = "Opera";
  else if (/Chrome\//.test(u) && !/Chromium/.test(u)) browser = "Chrome";
  else if (/Firefox\//.test(u)) browser = "Firefox";
  else if (/Safari\//.test(u) && /Version\//.test(u)) browser = "Safari";

  let os = "Unknown OS";
  if (/Windows NT 10/.test(u)) os = "Windows";
  else if (/Windows/.test(u)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(u)) os = "macOS";
  else if (/Android/.test(u)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(u)) os = "iOS";
  else if (/Linux/.test(u)) os = "Linux";

  let device = "Desktop";
  if (/iPad|Tablet/.test(u)) device = "Tablet";
  else if (/Mobile|iPhone|Android.*Mobile/.test(u)) device = "Mobile";

  return { browser, os, label: `${browser} on ${os} · ${device}` };
}

type DeviceDoc = {
  _id: string;
  user_id: string;
  device_id: string;
  device_label: string;
  browser: string;
  os: string;
  user_agent: string;
  ip_address: string | null;
  last_seen_at: Date;
  created_at: Date;
};

const record = createServerFn({ method: "POST" })
  .validator(z.object({
    device_id: z.string(),
    device_label: z.string(),
    browser: z.string(),
    os: z.string(),
    user_agent: z.string(),
    ip_address: z.string().nullable(),
  }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const userId = (await requireUser()).id;
    const col = await collection<DeviceDoc>("user_devices");
    const existing = await col.findOne({ _id: data.device_id, user_id: userId });
    const timestamp = now();
    await col.replaceOne(
      { _id: data.device_id },
      {
        ...data,
        user_id: userId,
        created_at: existing?.created_at ?? timestamp,
        last_seen_at: timestamp,
      },
      { upsert: true },
    );
  });

async function fetchClientIp(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("/api/client-ip", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { ip?: unknown };
    return typeof data.ip === "string" && data.ip ? data.ip : null;
  } catch {
    return null;
  }
}

export async function recordCurrentDevice(): Promise<void> {
  if (!hasConsent()) return;
  if (typeof window === "undefined") return;
  const ua = navigator.userAgent;
  const { browser, os, label } = parseUserAgent(ua);
  await record({
    data: {
      device_id: getDeviceId(),
      device_label: label,
      browser,
      os,
      user_agent: ua,
      ip_address: await fetchClientIp(),
    },
  });
}
