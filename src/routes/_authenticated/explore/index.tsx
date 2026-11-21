import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Compass, Sparkles } from "lucide-react";
import { Navbar } from "@/components/streamflix/Navbar";
import { Footer } from "@/components/streamflix/Footer";
import { MovieCard } from "@/components/streamflix/MovieCard";
import { Skeleton } from "@/components/ui/skeleton";
import { getGenres } from "@/lib/streamflix-data";
import { discoverByWatchProvider, fetchPopular, fetchWatchProviderCatalog } from "@/lib/api/tmdb";
import type { Movie } from "@/lib/types";
import { isKidsProfile, filterKidsContent } from "@/lib/kids-mode";

export const Route = createFileRoute("/_authenticated/explore/")({
  loader: async () => {
    const [genres, popular] = await Promise.all([getGenres(), fetchPopular()]);
    return { genres, items: popular };
  },
  head: () => ({ meta: [{ title: "Explore — OPLAY.ID" }] }),
  pendingComponent: () => (
    <div className="min-h-dvh bg-background">
      <Navbar />
      <section className="relative flex h-[38vh] items-end overflow-hidden sm:h-[46vh]">
        <Skeleton className="absolute inset-0 h-full w-full rounded-none opacity-60" />
        <div className="relative z-10 w-full px-4 pb-8 sm:px-8 md:px-16">
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="mt-2 h-10 w-64 rounded sm:h-14" />
          <Skeleton className="mt-3 h-4 w-72 rounded" />
        </div>
      </section>
      <main className="mx-auto max-w-[1800px] px-4 pb-16 sm:px-8">
        <div className="mt-8 flex flex-wrap gap-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>
        <div className="mt-10">
          <Skeleton className="h-5 w-44 rounded" />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="w-full aspect-[2/3] rounded-xl" />
            ))}
          </div>
        </div>
      </main>
    </div>
  ),
  component: ExplorePage,
});

function ExplorePage() {
  const { genres, items } = Route.useLoaderData() as {
    genres: { id: number; name: string }[];
    items: Movie[];
  };
  const [page, setPage] = useState(1);
  const [platforms, setPlatforms] = useState<
    { provider_id: number; provider_name: string; logo_path: string | null }[]
  >([]);
  const [selectedPlatformId, setSelectedPlatformId] = useState<number | null>(null);
  const [platformItems, setPlatformItems] = useState<Movie[]>([]);
  const [platformLoading, setPlatformLoading] = useState(false);
  const navigate = useNavigate();

  const kidsMode = isKidsProfile();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [movieProviders, tvProviders] = await Promise.all([
          fetchWatchProviderCatalog({ data: { type: "movie", watchRegion: "ID" } }),
          fetchWatchProviderCatalog({ data: { type: "tv", watchRegion: "ID" } }),
        ]);
        if (cancelled) return;
        const byId = new Map<
          number,
          {
            provider_id: number;
            provider_name: string;
            logo_path: string | null;
            display_priority: number;
          }
        >();
        for (const p of [...movieProviders, ...tvProviders]) {
          const prev = byId.get(p.provider_id);
          if (!prev || (p.display_priority ?? 999) < (prev.display_priority ?? 999))
            byId.set(p.provider_id, p);
        }
        const preferred = [8, 9, 337, 384, 15, 1899, 531, 2, 122, 283, 350, 11];
        const all = [...byId.values()].sort((a, b) => {
          const ai = preferred.indexOf(a.provider_id);
          const bi = preferred.indexOf(b.provider_id);
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          return (a.display_priority ?? 999) - (b.display_priority ?? 999);
        });
        setPlatforms(all.slice(0, 14));
      } catch {
        if (!cancelled) setPlatforms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedPlatformId) {
      setPlatformItems([]);
      setPlatformLoading(false);
      return;
    }
    let cancelled = false;
    setPlatformLoading(true);
    setPage(1);
    (async () => {
      try {
        const [movies, tv] = await Promise.all([
          discoverByWatchProvider({
            data: {
              type: "movie",
              providerId: selectedPlatformId,
              watchRegion: "ID",
              page: 1,
              sortBy: "popularity.desc",
            },
          }),
          discoverByWatchProvider({
            data: {
              type: "tv",
              providerId: selectedPlatformId,
              watchRegion: "ID",
              page: 1,
              sortBy: "popularity.desc",
            },
          }),
        ]);
        if (cancelled) return;
        const seen = new Set<string>();
        setPlatformItems(
          [...movies, ...tv].filter((m) => {
            if (seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          }),
        );
      } catch {
        if (!cancelled) setPlatformItems([]);
      } finally {
        if (!cancelled) setPlatformLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPlatformId]);

  const baseItems = selectedPlatformId ? platformItems : items;
  const safeGenres = genres;
  const safeItems: Movie[] = kidsMode ? filterKidsContent(baseItems) : baseItems;
  const pageCount = Math.max(1, Math.ceil(safeItems.length / 24));
  const visible = safeItems.slice((page - 1) * 24, page * 24);

  return (
    <div className="min-h-dvh bg-background">
      <Navbar />

      <section className="relative flex h-[38vh] items-end overflow-hidden sm:h-[46vh]">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-700/50 via-surface to-background" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent" />
        <div className="relative z-10 w-full px-4 pb-8 sm:px-8 md:px-16">
          <div className="flex items-center gap-2 text-purple-300">
            <Compass className="size-5" />
            <span className="text-sm font-semibold uppercase tracking-widest">Explore</span>
          </div>
          <h1 className="mt-1 text-4xl font-black tracking-tight sm:text-6xl">Pick a mood</h1>
          <p className="mt-2 max-w-xl text-sm text-foreground/80 sm:text-base">
            Jump into a curated mood or genre and discover something new.
          </p>
        </div>
      </section>

      <main className="mx-auto max-w-[1800px] px-4 pb-16 sm:px-8">
        <div className="mt-8 flex flex-wrap gap-2">
          {safeGenres.map((g) => (
            <Link
              key={g.id}
              to="/explore/$genreId"
              params={{ genreId: String(g.id) }}
              search={{ q: g.name }}
              className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:border-primary hover:text-foreground"
            >
              <Sparkles className="size-3.5 text-primary" /> {g.name}
            </Link>
          ))}
        </div>

        {platforms.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Platform Streaming
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {platforms.map((p) => {
                const active = selectedPlatformId === p.provider_id;
                return (
                  <button
                    key={p.provider_id}
                    type="button"
                    onClick={() => {
                      setSelectedPlatformId(active ? null : p.provider_id);
                      setPage(1);
                    }}
                    className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {p.logo_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w45${p.logo_path}`}
                        alt=""
                        className="size-5 rounded-sm object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <span>{p.provider_name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight">
            {selectedPlatformId
              ? (platforms.find((p) => p.provider_id === selectedPlatformId)?.provider_name ??
                "Platform")
              : "Popular right now"}
          </h2>
          {platformLoading ? (
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
              {Array.from({ length: 12 }).map((_, i) => (
                <Skeleton key={i} className="w-full aspect-[2/3] rounded-xl" />
              ))}
            </div>
          ) : safeItems.length > 0 ? (
            <>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                {visible.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => navigate({ to: "/movie/$id", params: { id: m.id } })}
                    className="w-full text-left"
                  >
                    <MovieCard movie={m} fluid />
                  </button>
                ))}
              </div>
              {pageCount > 1 && (
                <div className="mt-8 flex items-center justify-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    <ChevronLeft className="size-4" /> Previous
                  </button>
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`rounded-md px-3 py-2 text-sm ${
                        p === page
                          ? "bg-primary text-primary-foreground"
                          : "border border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page === pageCount}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    Next <ChevronRight className="size-4" />
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              Tidak ada judul ditemukan untuk platform ini.
            </p>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
