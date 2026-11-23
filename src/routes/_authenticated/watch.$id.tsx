import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
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

function PlayerPage() {
  const { movie } = Route.useLoaderData();
  const { season, episode } = Route.useSearch();
  const navigate = useNavigate();

  const [playerUrl, setPlayerUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastRecordRef = useRef(0);
  const lastDurationRef = useRef(0);

  const mediaId = movie?.id ?? "";

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
      .then((url) => setPlayerUrl(url))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Gagal menyiapkan player MediaFlow.");
      });

    return () => controller.abort();
  }, [mediaId, season, episode]);

  // mfp owns playback. Streamflix mirrors progress into the existing
  // continue-watching/watch-history stores and persists imported SubDL tracks.
  useEffect(() => {
    if (!mediaId || !movie) return;

    const itemId =
      season != null && episode != null ? `${movie.id}:S${season}E${episode}` : movie.id;
    lastRecordRef.current = 0;
    lastDurationRef.current = 0;

    function restoreShared() {
      sharedMfpSubtitles(mediaId)
        .then((tracks) => {
          const target = iframeRef.current?.contentWindow;
          if (!target || tracks.length === 0) return;
          target.postMessage({ type: "mfp:restoreSubtitles", tracks }, MEDIAFLOW_ORIGIN);
        })
        .catch(() => {});
    }

    function seekToSavedPosition() {
      const saved = getContinueWatching().find((item) => item.id === itemId);
      if (!saved || !Number.isFinite(saved.progress) || saved.progress <= 0) return;
      const target = iframeRef.current?.contentWindow;
      if (!target) return;
      target.postMessage({ type: "mfp:seek", time: saved.progress }, MEDIAFLOW_ORIGIN);
    }

    function record(cur: number, dur: number, force = false) {
      if (!Number.isFinite(cur) || !Number.isFinite(dur) || dur <= 0) return;
      const now = Date.now();
      if (!force && now - lastRecordRef.current < 5000) return;
      lastRecordRef.current = now;
      recordProgress(movie, cur, dur, season, episode);
      saveProgressToFirestore(movie, cur, dur, season, episode).catch(() => {});
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== MEDIAFLOW_ORIGIN) return;
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data as MfpMessage | null;
      if (!data || typeof data !== "object" || data.source !== "mfp-player") return;

      if (data.type === "ready") {
        restoreShared();
        seekToSavedPosition();
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

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mediaId, movie, season, episode]);

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
          {playerUrl && (
            <iframe
              ref={iframeRef}
              src={playerUrl}
              title="MediaFlow Player"
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              className="h-full w-full border-0 bg-black"
            />
          )}

          {!playerUrl && !error && (
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
