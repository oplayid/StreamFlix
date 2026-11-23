import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader } from "lucide-react";
import { movieById } from "@/lib/streamflix-data";
import { seoMetaFor } from "@/lib/seo";

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

  const goBack = () => {
    if (!mediaId) return;
    navigate({ to: "/movie/$id", params: { id: mediaId } });
  };

  const label = movie?.title ?? "Video";
  const episodeLabel = season != null && episode != null ? ` • S${season} E${episode}` : "";

  return (
    <main className="relative size-dvh overflow-hidden bg-black text-white">
      {playerUrl && (
        <iframe
          src={playerUrl}
          title="MediaFlow Player"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 size-full border-0 bg-black"
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/80 to-transparent px-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] sm:px-6">
        <button
          type="button"
          onClick={goBack}
          className="pointer-events-auto inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-white/90 transition hover:bg-white/10 hover:text-white"
        >
          <ArrowLeft className="size-6" />
          <span className="text-sm font-semibold drop-shadow-md sm:text-base">
            {label}
            <span className="ml-2 font-normal text-white/60">{episodeLabel}</span>
          </span>
        </button>
      </div>

      {!playerUrl && !error && (
        <div className="absolute inset-0 grid place-items-center bg-black text-sm text-white/60">
          <Loader className="size-6 animate-spin" aria-hidden="true" />
          <span className="sr-only">Menyiapkan player…</span>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 grid place-items-center bg-black px-6 text-center">
          <p className="max-w-lg text-sm text-red-300">{error}</p>
        </div>
      )}
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
