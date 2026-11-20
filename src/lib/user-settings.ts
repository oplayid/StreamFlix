import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection } from "./mongo";

export type UserSettings = {
  displayName: string;
  avatarUrl: string;
  showProviderPhoto: boolean;
  vip: boolean;
  createdAt: string;
};

export type UserDevice = {
  id: string;
  device_id: string;
  device_label: string;
  browser: string | null;
  os: string | null;
  ip_address: string | null;
  last_seen_at: string | null;
  created_at: string | null;
};

type UserDoc = {
  _id: string;
  name: string;
  avatar_url?: string;
  show_provider_photo?: boolean;
  vip?: boolean;
  createdAt: Date;
};

type DeviceDoc = {
  _id: string;
  user_id: string;
  device_id: string;
  device_label: string;
  browser?: string | null;
  os?: string | null;
  ip_address?: string | null;
  last_seen_at: Date;
  created_at: Date;
};

const readSettings = createServerFn({ method: "GET" }).handler(async (): Promise<UserSettings> => {
  const { requireUser } = await import("./auth");
  const user = await requireUser();
  const users = await collection<UserDoc>("users");
  const doc = await users.findOne({ _id: user.id });
  return {
    displayName: doc?.name ?? user.name,
    avatarUrl: doc?.avatar_url ?? "",
    showProviderPhoto: doc?.show_provider_photo ?? true,
    vip: !!doc?.vip,
    createdAt: new Date(doc?.createdAt ?? user.createdAt).toISOString(),
  };
});

const writeSettings = createServerFn({ method: "POST" })
  .validator(z.object({
    displayName: z.string().max(80).optional(),
    avatarUrl: z.string().optional(),
    showProviderPhoto: z.boolean().optional(),
  }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const users = await collection<UserDoc>("users");
    const patch: Record<string, unknown> = {};
    if (data.displayName !== undefined) patch.name = data.displayName;
    if (data.avatarUrl !== undefined) patch.avatar_url = data.avatarUrl;
    if (data.showProviderPhoto !== undefined) patch.show_provider_photo = data.showProviderPhoto;
    await users.updateOne({ _id: user.id }, { $set: patch }, { upsert: true });
  });

const readVip = createServerFn({ method: "GET" }).handler(async (): Promise<boolean> => {
  const { requireUser } = await import("./auth");
  const user = await requireUser();
  const users = await collection<UserDoc>("users");
  const doc = await users.findOne({ _id: user.id }, { projection: { vip: 1 } });
  const vips = await collection<{ _id: string }>("vip");
  return !!doc?.vip || !!(await vips.findOne({ _id: user.id }));
});

const readDevices = createServerFn({ method: "GET" }).handler(async (): Promise<UserDevice[]> => {
  const { requireUser } = await import("./auth");
  const user = await requireUser();
  const devices = await collection<DeviceDoc>("user_devices");
  const docs = await devices.find({ user_id: user.id }).toArray();
  return docs.map((d) => ({
    id: d._id,
    device_id: d.device_id,
    device_label: d.device_label,
    browser: d.browser ?? null,
    os: d.os ?? null,
    ip_address: d.ip_address ?? null,
    last_seen_at: d.last_seen_at?.toISOString?.() ?? null,
    created_at: d.created_at?.toISOString?.() ?? null,
  }));
});

const removeDeviceFn = createServerFn({ method: "POST" })
  .validator(z.object({ deviceId: z.string(), allOthers: z.boolean().default(false) }))
  .handler(async ({ data }) => {
    const { requireUser } = await import("./auth");
    const user = await requireUser();
    const devices = await collection<DeviceDoc>("user_devices");
    if (data.allOthers) {
      await devices.deleteMany({ user_id: user.id, device_id: { $ne: data.deviceId } });
    } else {
      await devices.deleteMany({ user_id: user.id, device_id: data.deviceId });
    }
  });

export function getUserSettings(): Promise<UserSettings> {
  return readSettings();
}

export function updateUserSettings(data: {
  displayName?: string;
  avatarUrl?: string;
  showProviderPhoto?: boolean;
}): Promise<void> {
  return writeSettings({ data });
}

export function getVipStatus(): Promise<boolean> {
  return readVip();
}

export function getUserDevices(): Promise<UserDevice[]> {
  return readDevices();
}

export function removeUserDevices(deviceId: string, allOthers = false): Promise<void> {
  return removeDeviceFn({ data: { deviceId, allOthers } });
}

