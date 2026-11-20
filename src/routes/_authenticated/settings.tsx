import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2,
  Monitor,
  Smartphone,
  Tablet,
  Trash2,
  LogOut,
  Mail,
  User as UserIcon,
  ShieldCheck,
  CheckCircle2,
  Upload,
  Check,
  Crown,
  KeyRound,
  EyeOff,
  Bell,
  BellOff,
  BellRing,
} from "lucide-react";
import { signOutFn, useSession } from "@/lib/session";
import {
  getUserSettings,
  getVipStatus,
  getUserDevices,
  removeUserDevices,
  updateUserSettings,
  type UserDevice as Device,
} from "@/lib/user-settings";

// Validate avatar URL to prevent XSS
const isValidAvatarUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};
import { Navbar } from "@/components/streamflix/Navbar";
import { Footer } from "@/components/streamflix/Footer";
import { Skeleton } from "@/components/ui/skeleton";
import { AvatarCropModal } from "@/components/streamflix/AvatarCropModal";
import { getDeviceId, recordCurrentDevice } from "@/lib/device-tracking";
import { isKidsProfile } from "@/lib/kids-mode";
import { useReduceMotion } from "@/lib/reduce-motion";
import { formatDistanceToNow } from "date-fns";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Account Settings — StreamFlix" }] }),
  component: SettingsPage,
});

type Profile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  show_google_pfp: boolean;
  created_at: string;
};

function deviceIcon(label: string) {
  if (/Mobile/i.test(label)) return Smartphone;
  if (/Tablet/i.test(label)) return Tablet;
  return Monitor;
}

function SettingsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [savingName, setSavingName] = useState(false);
  const currentDeviceId = typeof window !== "undefined" ? getDeviceId() : "";
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<{ state: string; message: string } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const { reduceMotion, setReduceMotion } = useReduceMotion();
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");
  const [notifBusy, setNotifBusy] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const isElectron = typeof window !== "undefined" && !!window.electronAPI;

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setNotifPermission(Notification.permission);
      setHasToken(Notification.permission === "granted");
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.getVersion().then(setAppVersion).catch(() => {});
    const unsubscribe = window.electronAPI.onUpdaterStatus((status) => {
      setUpdateStatus(status);
      setUpdateBusy(false);
      if (status.state === "downloaded") {
        toast.success("Update downloaded. Restart to install.", {
          action: {
            label: "Restart now",
            onClick: () => window.electronAPI?.installUpdate(),
          },
        });
      } else if (status.state === "uptodate") {
        toast.success(status.message);
      } else if (status.state === "error") {
        toast.error(status.message);
      }
    });
    return unsubscribe;
  }, []);

  const checkForUpdates = async () => {
    if (!window.electronAPI) return;
    setUpdateBusy(true);
    try {
      const res = await window.electronAPI.checkForUpdates();
      setUpdateStatus(res);
      if (res.state === "dev") {
        setUpdateBusy(false);
        toast.info(res.message);
      } else if (res.state === "checking") {
        setUpdateStatus(res);
      }
    } catch {
      setUpdateBusy(false);
      toast.error("Could not check for updates.");
    }
  };

  useEffect(() => {
    recordCurrentDevice();
  }, []);

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["profile", user?.uid],
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Profile | null> => {
      if (!user) return null;
      const s = await getUserSettings();
      return {
        id: user.id,
        display_name: s.displayName,
        avatar_url: s.avatarUrl || null,
        show_google_pfp: s.showProviderPhoto,
        created_at: s.createdAt,
      };
    },
  });

  useEffect(() => {
    if (profile?.display_name) setDisplayName(profile.display_name);
    setAvatarUrl(profile?.avatar_url ?? "");
  }, [profile?.display_name, profile?.avatar_url]);

  const googlePhotoURL: string | undefined = user?.picture ?? undefined;

  const { data: isVip } = useQuery({
    queryKey: ["vip", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<boolean> => {
      if (!user) return false;
      return getVipStatus();
    },
  });

  const useGooglePfp = async () => {
    if (!googlePhotoURL || !user) return;
    const prevProfile = qc.getQueryData<Profile>(["profile", user.uid]);
    const prevAvatarUrl = avatarUrl;
    setAvatarUrl(googlePhotoURL);
    qc.setQueryData<Profile>(["profile", user.uid], (old) =>
      old ? { ...old, avatar_url: googlePhotoURL, show_google_pfp: true } : old,
    );
    setSavingName(true);
    try {
      await updateUserSettings({ avatarUrl: googlePhotoURL, showProviderPhoto: true });
      toast.success("Avatar updated to Pocket ID profile picture");
      qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err: any) {
      setAvatarUrl(prevAvatarUrl);
      if (prevProfile) qc.setQueryData(["profile", user.uid], prevProfile);
      toast.error(err.message);
    }
    setSavingName(false);
  };

  const removeAvatar = async () => {
    if (!user) return;
    const prevProfile = qc.getQueryData<Profile>(["profile", user.uid]);
    const prevAvatarUrl = avatarUrl;
    setAvatarUrl("");
    qc.setQueryData<Profile>(["profile", user.uid], (old) =>
      old ? { ...old, avatar_url: "", show_google_pfp: false } : old,
    );
    setSavingName(true);
    try {
      await updateUserSettings({ avatarUrl: "", showProviderPhoto: false });
      toast.success("Avatar removed");
      qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err: any) {
      setAvatarUrl(prevAvatarUrl);
      if (prevProfile) qc.setQueryData(["profile", user.uid], prevProfile);
      toast.error(err.message);
    }
    setSavingName(false);
  };

  const onFilePicked = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(String(reader.result));
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const saveUploadedAvatar = async (dataUrl: string) => {
    if (!user) return;
    setSavingName(true);
    try {
      await updateUserSettings({ avatarUrl: dataUrl, showProviderPhoto: false });
      setAvatarUrl(dataUrl);
      setCropSrc(null);
      toast.success("Avatar updated");
      qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err: any) {
      toast.error(err.message);
    }
    setSavingName(false);
  };

  const devicesQ = useQuery({
    queryKey: ["user_devices", user?.uid],
    enabled: !!user,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Device[]> => {
      if (!user) return [];
      const rows = await getUserDevices();
      return rows.sort((a, b) => {
        const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
        const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
        return tb - ta;
      });
    },
  });

  const deviceQueryKey = ["user_devices", user?.uid] as const;

  const removeDevice = useMutation({
    mutationFn: async (d: Device) => {
      if (d.device_id === currentDeviceId) return;
      await removeUserDevices(d.device_id);
    },
    onMutate: async (d: Device) => {
      if (d.device_id === currentDeviceId) return { prev: undefined };
      await qc.cancelQueries({ queryKey: deviceQueryKey });
      const prev = qc.getQueryData<Device[]>(deviceQueryKey);
      qc.setQueryData<Device[]>(deviceQueryKey, (old) => (old ?? []).filter((dev) => dev.id !== d.id));
      return { prev };
    },
    onError: (e: Error, _d, context) => {
      if (context?.prev) qc.setQueryData(deviceQueryKey, context.prev);
      toast.error(e.message);
    },
    onSuccess: () => {
      toast.success("Device removed");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: deviceQueryKey });
    },
  });

  const removeAllOthers = useMutation({
    mutationFn: async () => {
      if (!user) return;
      await removeUserDevices(currentDeviceId, true);
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: deviceQueryKey });
      const prev = qc.getQueryData<Device[]>(deviceQueryKey);
      qc.setQueryData<Device[]>(deviceQueryKey, (old) =>
        (old ?? []).filter((d) => d.device_id === currentDeviceId),
      );
      return { prev };
    },
    onError: (e: Error, _vars, context) => {
      if (context?.prev) qc.setQueryData(deviceQueryKey, context.prev);
      toast.error(e.message);
    },
    onSuccess: () => {
      toast.success("Signed out of all other devices");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: deviceQueryKey });
    },
  });

  const saveName = async () => {
    if (!user || !displayName.trim()) return;
    const trimmed = displayName.trim();
    const prevProfile = qc.getQueryData<Profile>(["profile", user.uid]);
    qc.setQueryData<Profile>(["profile", user.uid], (old) =>
      old ? { ...old, display_name: trimmed } : old,
    );
    setSavingName(true);
    try {
      await updateUserSettings({ displayName: trimmed });
      toast.success("Profile updated");
      qc.invalidateQueries({ queryKey: ["profile"] });
    } catch (err: any) {
      if (prevProfile) qc.setQueryData(["profile", user.uid], prevProfile);
      toast.error(err.message);
    }
    setSavingName(false);
  };

  const signOut = async () => {
    await signOutFn();
    router.navigate({ to: "/auth", replace: true });
  };

  const createdAt = profile?.created_at ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="mx-auto max-w-4xl px-4 pt-28 pb-20 sm:px-8">
        <h1 className="text-3xl font-bold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your profile, security, and signed-in devices.
        </p>

        {/* VIP (only for users listed in the vip collection) */}
        {isVip && (
          <section className="mt-8 rounded-lg border border-yellow-500/30 bg-gradient-to-r from-yellow-500/15 via-amber-500/5 to-transparent p-4 sm:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="grid size-12 shrink-0 place-items-center rounded-full bg-yellow-500/20 text-yellow-400">
                <Crown className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-bold text-yellow-400">VIP Member</p>
                  <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-yellow-400">
                    Exclusive
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Enjoy an ad-free experience, early access to new releases, and priority support.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* Profile */}
        <section className="mt-8 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <UserIcon className="size-4" /> Profile
          </div>
          {profileLoading ? (
            <div className="mt-5 flex flex-col sm:flex-row gap-6">
              <div className="flex flex-col items-center gap-3">
                <Skeleton className="size-24 rounded-full" />
                <Skeleton className="h-5 w-32 rounded" />
              </div>
              <div className="flex-1 grid gap-4 sm:grid-cols-2">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className={i === 5 ? "sm:col-span-2" : ""}>
                    <Skeleton className="h-3 w-20 mb-1 rounded" />
                    <Skeleton className="h-10 w-full rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-5 flex flex-col sm:flex-row gap-6">
              <div className="flex flex-col items-center gap-3">
                {avatarUrl && isValidAvatarUrl(avatarUrl) ? (
                  <img
                    src={avatarUrl}
                    alt=""
                    className="size-24 rounded-full object-cover ring-2 ring-border"
                  />
                ) : avatarUrl && !isValidAvatarUrl(avatarUrl) ? (
                  <div className="size-24 rounded-full bg-destructive/10 flex items-center justify-center text-xs text-destructive">
                    Invalid URL
                  </div>
                ) : googlePhotoURL && (profile?.show_google_pfp ?? true) ? (
                  <img
                    src={googlePhotoURL}
                    alt=""
                    className="size-24 rounded-full object-cover ring-2 ring-border"
                  />
                ) : (
                  <div className="grid size-24 place-items-center rounded-full bg-gradient-to-br from-rose-500 to-red-700 text-4xl font-black text-white/90">
                    {(displayName || user?.email || "?")[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  {googlePhotoURL && (profile?.show_google_pfp ?? true) && (
                    <button
                      onClick={useGooglePfp}
                      disabled={savingName}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      <Check className="size-3" /> Use Pocket ID photo
                    </button>
                  )}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={savingName}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    <Upload className="size-3" /> Upload
                  </button>
                  {(avatarUrl || (googlePhotoURL && (profile?.show_google_pfp ?? true))) && (
                    <button
                      onClick={removeAvatar}
                      disabled={savingName}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onFilePicked(e.target.files?.[0])}
                />
              </div>
              <div className="flex-1 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Email
                  </label>
                  <div className="mt-1 flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2 text-sm">
                    <Mail className="size-4 text-muted-foreground shrink-0" />
                    <span
                      className="min-w-0 truncate"
                      style={{
                        fontSize:
                          (user?.email?.length ?? 0) > 30
                            ? `${Math.max(11, 14 - ((user?.email?.length ?? 0) - 30) * 0.12)}px`
                            : undefined,
                      }}
                    >
                      {user?.email ?? "—"}
                    </span>
                    <CheckCircle2 className="ml-auto size-4 shrink-0 text-emerald-400" />
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="dn"
                    className="text-xs uppercase tracking-wider text-muted-foreground"
                  >
                    Display name
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      id="dn"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="flex-1 rounded-md border border-border bg-background/60 px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <button
                      onClick={saveName}
                      disabled={
                        savingName || !displayName.trim() || displayName === profile?.display_name
                      }
                      className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {savingName ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Member since
                  </label>
                  <div className="mt-1 rounded-md border border-border bg-background/60 px-3 py-2 text-sm">
                    {createdAt ? new Date(createdAt).toLocaleDateString() : "—"}
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">
                    User ID
                  </label>
                  <div className="mt-1 truncate sm:truncate sm:rounded-md border border-border bg-background/60 px-3 py-2 text-xs font-mono text-muted-foreground break-all">
                    {user?.uid ?? "—"}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Password is managed by Pocket ID */}
        <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound className="size-4" /> Password
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Your password is managed by Pocket ID. Use Pocket ID to change or reset it.
          </p>
        </section>

        {/* Accessibility */}
        <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <EyeOff className="size-4" /> Accessibility
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Customize your viewing experience. Reduce motion disables animations and transitions.
          </p>
          <div className="mt-4 flex items-center justify-between gap-4 rounded-md border border-border bg-background/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Reduce Motion</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Disable animations, transitions, and auto-rotating carousels.
              </p>
            </div>
            <button
              onClick={() => setReduceMotion(!reduceMotion)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                reduceMotion ? "bg-primary" : "bg-muted"
              }`}
              role="switch"
              aria-checked={reduceMotion}
            >
              <span
                className={`pointer-events-none inline-block size-5 rounded-full bg-white shadow-lg ring-0 transition-transform ${
                  reduceMotion ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </section>

        {/* Desktop app (Electron only) */}
        {isElectron && (
          <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Monitor className="size-4" /> Desktop app
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  StreamFlix Desktop · Version {appVersion ?? "—"}
                </p>
              </div>
              <button
                onClick={checkForUpdates}
                disabled={updateBusy}
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-40"
              >
                {updateBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                Check for updates
              </button>
            </div>
            {updateStatus && updateStatus.state !== "dev" && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5">
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {updateStatus.state === "downloading" && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  {updateStatus.message}
                </span>
                {updateStatus.state === "downloaded" && (
                  <button
                    onClick={() => window.electronAPI?.installUpdate()}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    Restart &amp; install
                  </button>
                )}
              </div>
            )}
          </section>
        )}

        {/* Devices */}
        <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" /> Devices signed in
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Recently active devices on your account. Remove any you don't recognise.
              </p>
            </div>
            <button
              onClick={() => removeAllOthers.mutate()}
              disabled={removeAllOthers.isPending || (devicesQ.data?.length ?? 0) <= 1}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-40"
            >
              Sign out other devices
            </button>
          </div>

          <div className="mt-5 divide-y divide-border rounded-md border border-border bg-background/40">
            {devicesQ.isLoading && (
              <div className="divide-y divide-border">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-4">
                    <Skeleton className="size-10 rounded-md" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-40 rounded" />
                      <Skeleton className="h-3 w-56 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!devicesQ.isLoading && (devicesQ.data?.length ?? 0) === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No devices recorded yet.
              </div>
            )}
            {devicesQ.data?.map((d) => {
              const Icon = deviceIcon(d.device_label);
              const isCurrent = d.device_id === currentDeviceId;
              const lastSeen = d.last_seen_at ? new Date(d.last_seen_at) : null;
              return (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-md bg-accent">
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{d.device_label}</p>
                      {isCurrent && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                          <CheckCircle2 className="size-3" /> This device
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {d.ip_address ?? "IP unknown"} · Last active{" "}
                      {lastSeen ? formatDistanceToNow(lastSeen, { addSuffix: true }) : "unknown"}
                    </p>
                  </div>
                  {!isCurrent && (
                    <button
                      onClick={() => removeDevice.mutate(d)}
                      disabled={removeDevice.isPending}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0"
                      aria-label="Remove device"
                    >
                      <Trash2 className="size-3.5" /> Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Notifications */}
        <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className={`grid size-10 shrink-0 place-items-center rounded-md ${
                notifPermission === "granted" && hasToken
                  ? "bg-emerald-500/15 text-emerald-400"
                  : notifPermission === "denied"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-accent text-muted-foreground"
              }`}>
                {notifPermission === "denied" ? (
                  <BellOff className="size-5" />
                ) : notifPermission === "granted" && hasToken ? (
                  <BellRing className="size-5" />
                ) : (
                  <Bell className="size-5" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold">Push Notifications</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {notifPermission === "granted" && hasToken
                    ? "Enabled — you'll receive release reminders and updates"
                    : notifPermission === "denied"
                    ? "Blocked — enable in your browser settings and reload"
                    : "Not enabled yet — get notified about new releases"}
                </p>
              </div>
            </div>
            {notifPermission === "denied" ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                <BellOff className="size-3.5" /> Blocked
              </span>
            ) : hasToken ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400 font-medium">
                <CheckCircle2 className="size-3.5" /> Active
              </span>
            ) : (
              <button
                onClick={async () => {
                  if (notifBusy) return;
                  const prevHasToken = hasToken;
                  const prevNotifPermission = notifPermission;
                  setHasToken(true);
                  setNotifPermission("granted");
                  setNotifBusy(true);
                  try {
                    const { ensurePushSubscription } = await import("@/lib/push");
                    const status = await ensurePushSubscription();
                    if (status === "granted") {
                      setHasToken(true);
                      if (typeof Notification !== "undefined") {
                        setNotifPermission(Notification.permission);
                      }
                      toast.success("Notifications enabled!");
                    } else {
                      setHasToken(prevHasToken);
                      setNotifPermission(prevNotifPermission);
                      if (status === "denied") {
                        if (typeof Notification !== "undefined") {
                          setNotifPermission(Notification.permission);
                        }
                        toast.error("Permission denied — enable in browser settings");
                      } else if (status === "no-vapid") {
                        toast.error("Push not configured on this server");
                      } else {
                        toast.error("Notifications unavailable on this device");
                      }
                    }
                  } catch {
                    setHasToken(prevHasToken);
                    setNotifPermission(prevNotifPermission);
                    toast.error("Failed to enable notifications");
                  } finally {
                    setNotifBusy(false);
                  }
                }}
                disabled={notifBusy}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {notifBusy ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
                {notifBusy ? "Enabling..." : "Enable Notifications"}
              </button>
            )}
          </div>
        </section>

        {/* Danger */}
        <section className="mt-6 rounded-lg border border-border bg-card/40 p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Sign out</p>
              <p className="mt-1 text-xs text-muted-foreground">End this session on this device.</p>
            </div>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </section>

        <div className="mt-8 text-center">
          <Link to="/browse" className="text-xs text-muted-foreground hover:text-foreground">
            ← Back to browsing
          </Link>
        </div>
      </main>
      {cropSrc && (
        <AvatarCropModal
          src={cropSrc}
          onClose={() => setCropSrc(null)}
          onConfirm={saveUploadedAvatar}
        />
      )}
      <Footer />
    </div>
  );
}
