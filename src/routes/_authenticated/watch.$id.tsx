import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader } from "lucide-react";
import { movieById } from "@/lib/streamflix-data";
import { seoMetaFor } from "@/lib/seo";
import { getContinueWatching, recordProgress } from "@/lib/continue-watching";
import { saveProgressToFirestore } from "@/lib/continue-watching-firestore";
import { saveMfpSubtitle, sharedMfpSubtitles } from "@/lib/subtitles";

const watchSearchSchema = z.object({
  season: z.number().optional(),
  episode: z.number().optional(),
  autoplay: z.boolean().optional(),
});

// MediaFlow is the only player. Streamflix resolves the media ID, asks the
// gateway for one opaque iframe URL, and gets out of the way.
const MEDIAFLOW_ORIGIN = "https://mfp.oplay.id";
const EARNVIDS_PROGRESS_TIMEOUT_MS = 12_000;

function buildGatewayUrl(
  id: string,
  season: number | undefined,
  episode: number | undefined,
): string {
  if (id.startsWith("tv-")) {
    const tmdbId = encodeURIComponent(id.slice(3));
    return `${MEDIAFLOW_ORIGIN}/gateway/resolve/tv/${tmdbId}/${String(season ?? 1)}/${String(episode ?? 1)}`;
  }
  return `${MEDIAFLOW_ORIGIN}/gateway/resolve/movie/${encodeURIComponent(id)}`;
}

type MfpMessage = {
  source?: unknown;
  type?: unknown;
  currentTime?: unknown;
  duration?: unknown;
  track?: {
    lang?: unknown;
    label?: unknown;
    downloadPath?: unknown;
    url?: unknown;
  };
};

type EarnvidsAsset = {
  status?: string;
  player_url?: string;
};

type NormalizedPlayerMessage =
  | { type: "ready" }
  | { type: "ended" }
  | { type: "timeupdate"; currentTime: number; duration: number };

function parsePlayerUrl(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Respons gateway MediaFlow tidak valid.");
  }
  const value = (payload as Record<string, unknown>).player_url;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("MediaFlow tidak mengembalikan URL player.");
  }
  const url = new URL(value.trim());
  if (url.origin !== MEDIAFLOW_ORIGIN || !url.pathname.startsWith("/_token_")) {
    throw new Error("URL player MediaFlow tidak dikenali.");
  }
  return url.toString();
}

function parseEarnvidsPlayerUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/\.html?$/.test(url.pathname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function savedProgress(itemKey: string): number {
  const saved = getContinueWatching().find((item) => item.id === itemKey);
  if (!saved || !Number.isFinite(saved.progress) || saved.progress <= 0) return 0;
  return saved.progress;
}

function withStartParam(url: string, seconds: number): string {
  if (!url || seconds <= 0) return url;
  try {
    const target = new URL(url);
    target.searchParams.set("start", String(Math.floor(seconds)));
    return target.toString();
  } catch {
    return url;
  }
}

function numeric(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

/** EarnVids has no documented player API, so accept several common shapes. */
function normalizeEarnvidsMessage(raw: unknown): NormalizedPlayerMessage | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;

  const top = value as Record<string, unknown>;
  const nested =
    top.data && typeof top.data === "object" ? (top.data as Record<string, unknown>) : top;
  const outerName = String(top.type ?? top.event ?? top.action ?? "").toLowerCase();
  const innerName = String(nested.type ?? nested.event ?? nested.action ?? "").toLowerCase();
  const name = innerName || outerName;

  if (name.includes("timeupdate") || name === "time" || name === "currenttime") {
    return {
      type: "timeupdate",
      currentTime: numeric(nested.currentTime ?? nested.time ?? nested.value ?? nested.position),
      duration: numeric(nested.duration),
    };
  }
  if (name === "ended" || name.includes("complete")) return { type: "ended" };
  if (name === "ready" || name.includes("loadedmetadata")) return { type: "ready" };
  return null;
}

function PlayerPage() {
  const { movie } = Route.useLoaderData();
  const { season, episode } = Route.useSearch();
  const navigate = useNavigate();

  const [mfpPlayerUrl, setMfpPlayerUrl] = useState("");
  const [earnvidsUrl, setEarnvidsUrl] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const telemetryRef = useRef<HTMLIFrameElement | null>(null);
  const lastRecordRef = useRef(0);
  const lastDurationRef = useRef(0);
  const progressSeenRef = useRef(false);

  const mediaId = movie?.id ?? "";
  const isTv = mediaId.startsWith("tv-");
  const itemKey =
    isTv && season != null && episode != null ? `${mediaId}:S${season}E${episode}` : mediaId;

  useEffect(() => {
    if (!mediaId) return;
    const controller = new AbortController();
    setError(null);

    fetch(buildGatewayUrl(mediaId, season, episode), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`MediaFlow gateway error (${response.status}): ${detail.slice(0, 160)}`);
        }
        return parsePlayerUrl(await response.json());
      })
      .then((url) => setMfpPlayerUrl(url))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Gagal menyiapkan player MediaFlow.");
      });

    return () => controller.abort();
  }, [mediaId, season, episode]);

  // One asset lookup on mount. A verified EarnVids player replaces the mfp
  // iframe; anything else keeps the normal mfp fallback.
  useEffect(() => {
    if (!mediaId) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      type: isTv ? "tv" : "movie",
      id: mediaId.replace(/^tv-/i, ""),
    });
    if (season != null) params.set("season", String(season));
    if (episode != null) params.set("episode", String(episode));

    fetch(`/api/earnvids-upload?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) =>
        response.ok ? ((await response.json()) as { asset?: EarnvidsAsset }) : null,
      )
      .then((payload) => {
        const asset = payload?.asset;
        setEarnvidsUrl(
          asset?.status === "uploaded" ? parseEarnvidsPlayerUrl(asset.player_url) : "",
        );
      })
      .catch(() => setEarnvidsUrl(""));

    return () => controller.abort();
  }, [mediaId, isTv, season, episode]);

  const earnvidsOrigin = useMemo(() => {
    if (!earnvidsUrl) return "";
    try {
      return new URL(earnvidsUrl).origin;
    } catch {
      return "";
    }
  }, [earnvidsUrl]);

  const visibleSrc = useMemo(
    () => (earnvidsUrl ? withStartParam(earnvidsUrl, savedProgress(itemKey)) : mfpPlayerUrl),
    [earnvidsUrl, itemKey, mfpPlayerUrl],
  );

  // If the EarnVids player never reports progress, keep a silent, low-profile
  // mfp iframe as the progress authority. It reuses the URL already resolved
  // above — no extra server check and no automatic failover.
  useEffect(() => {
    progressSeenRef.current = false;
    if (!earnvidsUrl) {
      setTelemetryEnabled(false);
      return;
    }
    setTelemetryEnabled(false);
    const timer = window.setTimeout(() => {
      if (!progressSeenRef.current) setTelemetryEnabled(true);
    }, EARNVIDS_PROGRESS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [earnvidsUrl]);

  // Streamflix mirrors progress into the existing continue-watching/watch-history
  // stores. The same bridge works for mfp and for EarnVids messages.
  useEffect(() => {
    if (!mediaId || !movie) return;

    lastRecordRef.current = 0;
    lastDurationRef.current = 0;

    function record(cur: number, dur: number, force = false) {
      if (!Number.isFinite(cur) || !Number.isFinite(dur) || dur <= 0) return;
      const now = Date.now();
      if (!force && now - lastRecordRef.current < 5000) return;
      lastRecordRef.current = now;
      recordProgress(movie, cur, dur, season, episode);
      saveProgressToFirestore(movie, cur, dur, season, episode).catch(() => {});
    }

    function restoreShared() {
      sharedMfpSubtitles(mediaId)
        .then((tracks) => {
          const target = iframeRef.current?.contentWindow;
          if (!target || tracks.length === 0) return;
          target.postMessage({ type: "mfp:restoreSubtitles", tracks }, MEDIAFLOW_ORIGIN);
        })
        .catch(() => {});
    }

    function seekEarnvids(target: Window, origin: string) {
      const seconds = savedProgress(itemKey);
      if (seconds <= 0) return;
      // Different themes use different verbs; harmless if the player ignores them.
      target.postMessage({ type: "seek", time: seconds }, origin);
      target.postMessage({ method: "seek", value: seconds }, origin);
      target.postMessage({ type: "setPosition", value: seconds }, origin);
    }

    function handleTelemetry(target: Window, data: MfpMessage) {
      if (data.type === "ready") {
        target.postMessage({ type: "mfp:mute" }, MEDIAFLOW_ORIGIN);
        const seconds = savedProgress(itemKey);
        if (seconds > 0) {
          target.postMessage({ type: "mfp:seek", time: seconds }, MEDIAFLOW_ORIGIN);
        }
        target.postMessage({ type: "mfp:play" }, MEDIAFLOW_ORIGIN);
        return;
      }
      if (data.type === "timeupdate") {
        const cur = typeof data.currentTime === "number" ? data.currentTime : 0;
        const dur = typeof data.duration === "number" ? data.duration : 0;
        lastDurationRef.current = dur;
        record(cur, dur);
        return;
      }
      if (data.type === "ended") {
        record(lastDurationRef.current, lastDurationRef.current, true);
      }
    }

    function handleMfpVisible(target: Window, data: MfpMessage) {
      if (data.type === "ready") {
        restoreShared();
        const seconds = savedProgress(itemKey);
        if (seconds > 0) {
          target.postMessage({ type: "mfp:seek", time: seconds }, MEDIAFLOW_ORIGIN);
        }
        return;
      }
      if (data.type === "timeupdate") {
        const cur = typeof data.currentTime === "number" ? data.currentTime : 0;
        const dur = typeof data.duration === "number" ? data.duration : 0;
        lastDurationRef.current = dur;
        record(cur, dur);
        return;
      }
      if (data.type === "ended") {
        record(lastDurationRef.current, lastDurationRef.current, true);
        return;
      }
      if (data.type !== "subdlImported" || !data.track) return;

      const track = data.track;
      const lang = typeof track.lang === "string" ? track.lang : "en";
      const label = typeof track.label === "string" ? track.label : "SubDL";
      const downloadPath = typeof track.downloadPath === "string" ? track.downloadPath : "";
      const url = typeof track.url === "string" ? track.url : "";
      if (!downloadPath || !url) return;

      saveMfpSubtitle({ mediaId, lang, label, downloadPath, url }).catch(() => {});
    }

    function onMessage(event: MessageEvent) {
      const visibleWindow = iframeRef.current?.contentWindow;
      const telemetryWindow = telemetryRef.current?.contentWindow;
      const fromTelemetry = Boolean(telemetryWindow && event.source === telemetryWindow);
      const fromVisible = Boolean(visibleWindow && event.source === visibleWindow);
      if (!fromTelemetry && !fromVisible) return;

      if (earnvidsUrl && fromVisible) {
        if (!earnvidsOrigin || event.origin !== earnvidsOrigin || !visibleWindow) return;
        const message = normalizeEarnvidsMessage(event.data);
        if (!message) return;
        if (message.type === "ready") {
          seekEarnvids(visibleWindow, earnvidsOrigin);
          return;
        }
        progressSeenRef.current = true;
        if (telemetryEnabled) setTelemetryEnabled(false);
        if (message.type === "timeupdate") {
          lastDurationRef.current = message.duration;
          record(message.currentTime, message.duration);
          return;
        }
        record(lastDurationRef.current, lastDurationRef.current, true);
        return;
      }

      if (event.origin !== MEDIAFLOW_ORIGIN) return;
      const data = event.data as MfpMessage | null;
      if (!data || typeof data !== "object" || data.source !== "mfp-player") return;

      if (fromTelemetry && telemetryWindow) {
        handleTelemetry(telemetryWindow, data);
        return;
      }
      if (fromVisible && visibleWindow) {
        handleMfpVisible(visibleWindow, data);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mediaId, movie, season, episode, itemKey, earnvidsUrl, earnvidsOrigin, telemetryEnabled]);

  const goBack = () => {
    if (!mediaId) return;
    navigate({ to: "/movie/$id", params: { id: mediaId } });
  };

  const label = movie?.title ?? "Video";
  const episodeLabel = season != null && episode != null ? ` • S${season} E${episode}` : "";

  return (
    <main className="relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-[1800px] flex-col gap-3 p-3 sm:gap-4 sm:p-6">
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-foreground/90 transition hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-6" />
            <span className="text-sm font-semibold sm:text-base">
              {label}
              <span className="ml-2 font-normal text-muted-foreground">{episodeLabel}</span>
            </span>
          </button>
        </div>

        <section className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl">
          {visibleSrc && (
            <iframe
              ref={iframeRef}
              src={visibleSrc}
              title={earnvidsUrl ? "EarnVids Player" : "MediaFlow Player"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              className="h-full w-full border-0 bg-black"
            />
          )}

          {earnvidsUrl && telemetryEnabled && mfpPlayerUrl && (
            <iframe
              ref={telemetryRef}
              src={mfpPlayerUrl}
              title="Progress telemetry"
              aria-hidden="true"
              tabIndex={-1}
              allow="autoplay"
              className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
            />
          )}

          {!visibleSrc && !error && (
            <div className="absolute inset-0 grid place-items-center gap-3 bg-black text-sm text-white/60">
              <Loader className="size-6 animate-spin" aria-hidden="true" />
              <span>Menyiapkan player…</span>
            </div>
          )}

          {error && (
            <div className="absolute inset-0 grid place-items-center bg-black px-6 text-center">
              <p className="max-w-lg text-sm text-red-300">{error}</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export const Route = createFileRoute("/_authenticated/watch/$id")({
  ssr: false,
  validateSearch: watchSearchSchema,
  loader: async ({ params }) => {
    let movie: Awaited<ReturnType<typeof movieById>> = null;
    try {
      movie = await movieById(params.id);
    } catch {
      movie = null;
    }
    return { movie };
  },
  head: ({ loaderData }) => {
    const movie = loaderData?.movie;
    const title = `Watching ${movie?.title ?? "Video"} — OPLAY.ID`;
    const description = movie?.description
      ? movie.description.slice(0, 200)
      : "Watch movies and TV shows on OPLAY.ID.";
    const image = movie?.backdropSm || movie?.poster || "";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        ...seoMetaFor(
          title,
          description,
          image,
          movie?.id?.startsWith("tv-") ? "video.tv_show" : "video.movie",
          "",
        ),
      ],
    };
  },
  component: PlayerPage,
  errorComponent: ({ error }) => (
    <div className="grid min-h-dvh place-items-center gap-4 bg-black p-8 text-white">
      <p className="text-red-400">Error: {(error as Error).message}</p>
      <Link to="/" className="text-sm text-white/60 underline hover:text-white">
        Go home
      </Link>
    </div>
  ),
});
