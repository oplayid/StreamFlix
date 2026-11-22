import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState, useCallback, type MouseEvent, type TouchEvent } from "react";
import {
  ArrowLeft,
  Settings,
  Loader,
  RotateCw,
  ShieldOff,
  Minimize2,
  Maximize2,
} from "lucide-react";
import Hls from "hls.js";
import { movieById } from "@/lib/streamflix-data";
import { getContinueWatching, recordProgress } from "@/lib/continue-watching";
import { saveProgressToFirestore } from "@/lib/continue-watching-firestore";
import { fetchTvSeason } from "@/lib/api/tmdb";
import { isPipSupported, enterPictureInPicture, isMobileApp } from "@/lib/mobile";
import { startSession, endSession } from "@/lib/session-tracking";
import { toast } from "sonner";
import { SeasonEpisodePicker } from "@/components/streamflix/SeasonEpisodePicker";
import { seoMetaFor } from "@/lib/seo";
import { isKidsProfile, isRatingBlockedForKids, isGenreBlockedForKids } from "@/lib/kids-mode";
import {
  addSubtitleFromUrl,
  cueAtTime,
  deleteSubtitle,
  importSubdlSubtitle,
  languageLabel,
  listSubtitles,
  parseVttCues,
  pickInitialSubtitle,
  searchSubdlSubtitles,
  updateSubtitleTiming,
  uploadSubtitle,
  validateSubtitle,
  type SubdlSubtitleResult,
  type SubtitleCue,
  type SubtitleTrack,
} from "@/lib/subtitles";

interface NetworkInformation {
  effectiveType: "slow-2g" | "2g" | "3g" | "4g";
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}
declare global {
  interface Navigator {
    connection?: NetworkInformation;
  }
}

const watchSearchSchema = z.object({
  season: z.number().optional(),
  episode: z.number().optional(),
  autoplay: z.boolean().optional(),
});

function fmt(t: number) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 66)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

// MediaFlow is a signed JSON gateway now; Streamflix fetches a stream URL and
// plays it in a native <video> element (with hls.js where needed).
const MEDIAFLOW_GATEWAY_BASE = "https://mfp.oplay.id";

type GatewaySource = { id: string; label: string; url: string };
type GatewaySubtitle = {
  id: string;
  label: string;
  language: string;
  format?: string;
  url: string;
};
type GatewayResult = {
  streamUrl: string;
  sources: GatewaySource[];
  subtitles: GatewaySubtitle[];
  expiresIn: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseGatewayResponse(payload: unknown): GatewayResult {
  if (!isRecord(payload)) throw new Error("Respons gateway MediaFlow tidak valid.");
  const streamUrl = payload.stream_url;
  if (typeof streamUrl !== "string" || !streamUrl.trim()) {
    throw new Error("MediaFlow tidak mengembalikan URL stream.");
  }
  const sources: GatewaySource[] = Array.isArray(payload.sources)
    ? payload.sources.filter(
        (item): item is GatewaySource =>
          isRecord(item) &&
          typeof item.id === "string" &&
          typeof item.label === "string" &&
          typeof item.url === "string",
      )
    : [];
  const subtitles: GatewaySubtitle[] = Array.isArray(payload.subtitles)
    ? payload.subtitles.filter(
        (item): item is GatewaySubtitle =>
          isRecord(item) &&
          typeof item.id === "string" &&
          typeof item.label === "string" &&
          typeof item.language === "string" &&
          typeof item.url === "string",
      )
    : [];
  const rawExpiry = payload.expires_in;
  const expiresIn =
    typeof rawExpiry === "number" && Number.isFinite(rawExpiry) && rawExpiry > 0
      ? rawExpiry
      : null;
  return { streamUrl: streamUrl.trim(), sources, subtitles, expiresIn };
}

function buildGatewayUrl(
  movieId: string,
  season: number | undefined,
  episode: number | undefined,
  forceRetry: boolean,
) {
  const isTv = movieId.startsWith("tv-");
  const tmdbId = isTv ? movieId.slice(3) : movieId;
  const path = isTv
    ? `/gateway/resolve/tv/${encodeURIComponent(tmdbId)}/${String(season ?? 1)}/${String(episode ?? 1)}`
    : `/gateway/resolve/movie/${encodeURIComponent(tmdbId)}`;
  return `${MEDIAFLOW_GATEWAY_BASE}${path}${forceRetry ? "?retry=1" : ""}`;
}

function isDefaultGatewaySubtitle(
  subtitle: GatewaySubtitle,
  index: number,
  subtitles: GatewaySubtitle[],
) {
  const language = subtitle.language.trim().toLowerCase();
  const hasIndonesian = subtitles.some((item) => item.language.trim().toLowerCase().startsWith("id"));
  const isPreferred = hasIndonesian ? language.startsWith("id") : language.startsWith("en");
  return (
    isPreferred &&
    subtitles.findIndex((item) => {
      const candidate = item.language.trim().toLowerCase();
      return hasIndonesian ? candidate.startsWith("id") : candidate.startsWith("en");
    }) === index
  );
}

function PlayerPage() {
  const data = Route.useLoaderData();
  const movie = data?.movie;
  const { season, episode, autoplay } = Route.useSearch();

  const kidsMode = isKidsProfile();

  const [streamUrl, setStreamUrl] = useState("");
  const [gatewaySubtitles, setGatewaySubtitles] = useState<GatewaySubtitle[]>([]);
  const [gatewaySources, setGatewaySources] = useState<GatewaySource[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(true);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [reloadRequest, setReloadRequest] = useState<{ nonce: number; force: boolean }>({
    nonce: 0,
    force: false,
  });
  const reloadGateway = useCallback((force: boolean) => {
    setReloadRequest((prev) => ({ nonce: prev.nonce + 1, force }));
  }, []);

  const [currentTime, setCurrentTime] = useState(0);
  const pendingSeekRef = useRef<number | null>(null);
  const playbackPositionRef = useRef(0);
  const wasPlayingRef = useRef(false);
  const shouldAutoplayRef = useRef(false);
  const resumeAppliedRef = useRef(false);
  const lastMediaKeyRef = useRef<string | null>(null);
  const lastRecordRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [savedPosition, setSavedPosition] = useState<number | null>(null);
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;

  const navigate = useNavigate();
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const lastTimeUpdateRef = useRef(0);

  const [ended, setEnded] = useState(false);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [newSubLang, setNewSubLang] = useState("id");
  const [newSubLabel, setNewSubLabel] = useState("Bahasa Indonesia");
  const [newSubUrl, setNewSubUrl] = useState("");
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [subtitlePreview, setSubtitlePreview] = useState<SubtitleCue[]>([]);
  const [subtitleWarnings, setSubtitleWarnings] = useState<string[]>([]);
  const [subtitleInvalid, setSubtitleInvalid] = useState(false);
  const [subdlResults, setSubdlResults] = useState<SubdlSubtitleResult[]>([]);
  const [subdlBusy, setSubdlBusy] = useState(false);
  const [subdlOpen, setSubdlOpen] = useState(false);
  const [subdlError, setSubdlError] = useState<string | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [showRotateHint, setShowRotateHint] = useState(false);
  const [isPortrait, setIsPortrait] = useState(
    typeof window !== "undefined" &&
      window.innerWidth < 768 &&
      window.innerHeight > window.innerWidth,
  );
  const [activeSubtitle, setActiveSubtitle] = useState<string | null>(null);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [timing, setTiming] = useState({ offset: 0, scale: 1 });
  const timingRef = useRef(timing);
  const [syncAnchors, setSyncAnchors] = useState<Array<{ t: number; cueStart: number }>>([]);
  const [syncHint, setSyncHint] = useState("");
  const [activeCue, setActiveCue] = useState<SubtitleCue | null>(null);
  const subtitleCuesRef = useRef<SubtitleCue[]>([]);
  const [connectionQuality, setConnectionQuality] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const isTv = movie.id.startsWith("tv-");
  const [autoplayNext, setAutoplayNext] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("sf:autoplayNext") === "1";
    } catch {
      return false;
    }
  });
  const [nextEp, setNextEp] = useState<{ season: number; episode: number } | null>(null);

  const toggleAutoplayNext = useCallback(() => {
    setAutoplayNext((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sf:autoplayNext", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const [pipSupported, setPipSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const checkPipSupport = useCallback(async () => {
    // First check: browser API
    const browserSupports = isPipSupported();
    if (!browserSupports) {
      setPipSupported(false);
      return;
    }
    // Second check: actually try to request PiP on a dummy video to verify it works
    // (only on web, not Capacitor where we use native PiP)
    const inNativeApp = isMobileApp();
    if (inNativeApp) {
      // On Capacitor, trust the native bridge
      const { enterPipModeNative } = await import("@/lib/mobile");
      const nativeSupports = window.NativeBridge?.isPipSupported?.() ?? false;
      setPipSupported(nativeSupports);
      return;
    }
    // On web, test with a hidden video element
    try {
      const testVideo = document.createElement("video");
      testVideo.src =
        "data:video/mp4;base64,AAAAIGZ0eXBtcDQyAAAAAG1wNDJpc21vbXAyAAAAHG1vb2YAAABsbXZoZAAAAPNtZGF0YQ==";
      testVideo.muted = true;
      testVideo.playsInline = true;
      await testVideo.requestPictureInPicture();
      await document.exitPictureInPicture();
      setPipSupported(true);
    } catch {
      setPipSupported(false);
    }
  }, []);

  useEffect(() => {
    checkPipSupport();
  }, [checkPipSupport]);

  useEffect(() => {
    if (!isTv || season == null || episode == null) {
      setNextEp(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const tmdbId = movie.id.replace(/^tv-/, "");
      let epsInSeason = 0;
      try {
        const seasonData = await fetchTvSeason({ data: { id: tmdbId, season } });
        epsInSeason = (seasonData.episodes || []).length;
      } catch {}
      if (cancelled) return;
      if (epsInSeason > 0 && episode < epsInSeason) {
        setNextEp({ season, episode: episode + 1 });
      } else if (
        epsInSeason > 0 &&
        episode >= epsInSeason &&
        season < (movie.numberOfSeasons ?? season)
      ) {
        setNextEp({ season: season + 1, episode: 1 });
      } else {
        setNextEp(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [movie.id, movie.numberOfSeasons, season, episode, isTv]);

  const goToNextEpisode = useCallback(() => {
    if (!nextEp) return;
    navigate({
      to: "/watch/$id",
      params: { id: movie.id },
      search: { season: nextEp.season, episode: nextEp.episode, autoplay: true },
    });
  }, [nextEp, movie.id, navigate]);

  const handleVideoEnded = useCallback(() => {
    setEnded(true);
    if (autoplayNext && isTv) goToNextEpisode();
  }, [autoplayNext, isTv, goToNextEpisode]);

  const goBack = useCallback(() => {
    try {
      screen.orientation?.unlock();
    } catch {}
    navigate({ to: "/movie/$id", params: { id: movie.id } });
  }, [navigate, movie.id]);

  const wake = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    // The native player owns its control bar; keep the page controls visible so
    // the full-screen wake overlay never covers native play/seek controls.
    if (!showSettings && !streamUrl) {
      hideTimer.current = window.setTimeout(() => setShowControls(false), 3000);
    }
  }, [showSettings, streamUrl]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await containerRef.current?.requestFullscreen();
      }
    } catch {}
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const handleWakeTap = useCallback(
    (event: MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      wake();
    },
    [wake],
  );

  useEffect(() => {
    wake();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [wake]);

  useEffect(() => {
    if (typeof window === "undefined" || !("navigation" in window)) return;
    const nav = (window as any).navigation;
    const handler = (e: any) => {
      try {
        const dest = new URL(e.destination.url, window.location.href);
        if (dest.origin !== window.location.origin) {
          e.preventDefault();
          toast.error("Redirect blocked");
        }
      } catch {}
    };
    nav.addEventListener("navigate", handler);
    return () => nav.removeEventListener("navigate", handler);
  }, []);

  const lastSaveErrorAtRef = useRef(0);
  const notifySaveError = useCallback((err?: unknown) => {
    const now = Date.now();
    if (now - lastSaveErrorAtRef.current < 30_000) return;
    lastSaveErrorAtRef.current = now;
    const message =
      err instanceof Error && err.message
        ? err.message
        : "Couldn't save your progress. Check your connection.";
    toast.error(message);
  }, []);

  const doRecord = useCallback(
    (cur: number, dur: number) => {
      recordProgress(movie, cur, dur, season, episode);
      saveProgressToFirestore(movie, cur, dur, season, episode).catch(notifySaveError);
    },
    [movie, season, episode, notifySaveError],
  );

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  const lastTapRef = useRef(0);
  const lastTapXRef = useRef(0);

  const onContainerTouch = useCallback(
    (e: React.TouchEvent) => {
      if (!containerRef.current || !videoRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.touches[0].clientX - rect.left;
      const now = Date.now();
      const timeSince = now - lastTapRef.current;
      const distSince = Math.abs(x - lastTapXRef.current);

      if (timeSince < 300 && distSince < 40) {
        e.preventDefault();
        if (x < rect.width / 2) {
          videoRef.current.currentTime -= 10;
        } else {
          videoRef.current.currentTime += 10;
        }
        lastTapRef.current = 0;
      } else {
        setShowControls((v) => !v);
        lastTapRef.current = now;
        lastTapXRef.current = x;
      }
      wake();
    },
    [wake],
  );

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const targetTotal = (Number(e.target.value) / 100) * v.duration;
    v.currentTime = targetTotal;
  }, []);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setVolume(v);
    setMuted(v === 0);
    if (videoRef.current) {
      videoRef.current.volume = v;
      videoRef.current.muted = v === 0;
    }
  };

  const updateSubtitleTracks = useCallback((lang: string | null, enabled: boolean) => {
    const tracks = videoRef.current?.textTracks;
    if (!tracks) return;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!enabled) {
        track.mode = "disabled";
      } else {
        track.mode = lang && track.language === lang ? "showing" : "disabled";
      }
    }
  }, []);

  const persistSubtitleChoice = (lang: string | null) => {
    if (!movie?.id) return;
    try {
      if (lang) localStorage.setItem(`sf:subtitle:${movie.id}`, lang);
      else localStorage.removeItem(`sf:subtitle:${movie.id}`);
    } catch {}
  };

  const handleSubtitleChange = (lang: string | null) => {
    setActiveSubtitle(lang);
    persistSubtitleChoice(lang);
    if (lang === null) {
      setCaptionsEnabled(false);
      updateSubtitleTracks(null, false);
      return;
    }
    if (!captionsEnabled) setCaptionsEnabled(true);
    updateSubtitleTracks(lang, true);
  };

  useEffect(() => {
    updateSubtitleTracks(activeSubtitle, captionsEnabled);
  }, [activeSubtitle, captionsEnabled, updateSubtitleTracks]);

  const toggleCaptions = useCallback(() => {
    setCaptionsEnabled((prev) => {
      const next = !prev;
      updateSubtitleTracks(activeSubtitle, next);
      return next;
    });
  }, [activeSubtitle, updateSubtitleTracks]);

  // --- Custom subtitles (own uploads and third-party URLs) ---
  const clampTiming = (value: { offset: number; scale: number }) => ({
    offset: Math.max(-600, Math.min(600, value.offset)),
    scale: Math.max(0.9, Math.min(1.1, value.scale)),
  });

  const persistTiming = useCallback(
    async (next: { offset: number; scale: number }) => {
      const clean = clampTiming(next);
      timingRef.current = clean;
      setTiming(clean);
      const active = subtitles.find((track) => track.lang === activeSubtitle);
      setSubtitles((prev) =>
        prev.map((track) => (track.id === active?.id ? { ...track, ...clean } : track)),
      );
      if (!active?.isOwner) return;
      try {
        await updateSubtitleTiming({ id: active.id, ...clean });
      } catch {
        toast.error("Could not save subtitle timing");
      }
    },
    [subtitles, activeSubtitle],
  );

  useEffect(() => {
    if (!movie?.id) return;
    let cancelled = false;
    const mediaId = movie.id;
    listSubtitles(mediaId)
      .then(async (tracks) => {
        let saved: string | null = null;
        let legacyOffset: number | null = null;
        try {
          saved = localStorage.getItem(`sf:subtitle:${mediaId}`);
        } catch {}
        try {
          const raw = localStorage.getItem(`sf:subtitleOffset:${mediaId}`);
          if (raw != null && Number.isFinite(Number(raw))) legacyOffset = Number(raw);
        } catch {}
        const initial = pickInitialSubtitle(tracks, saved);
        if (cancelled) return;
        setSubtitles(tracks);
        setActiveSubtitle(initial);
        setCaptionsEnabled(initial !== null);

        // Migrate the old single global offset into the selected track once.
        if (legacyOffset && legacyOffset !== 0 && initial) {
          const track = tracks.find((item) => item.lang === initial);
          if (track?.isOwner && track.offset === 0) {
            try {
              await updateSubtitleTiming({ id: track.id, offset: legacyOffset, scale: 1 });
              if (!cancelled) {
                setSubtitles((prev) =>
                  prev.map((item) =>
                    item.id === track.id ? { ...item, offset: legacyOffset!, scale: 1 } : item,
                  ),
                );
                localStorage.removeItem(`sf:subtitleOffset:${mediaId}`);
              }
            } catch {}
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [movie?.id]);

  useEffect(() => {
    const selected = subtitles.find((track) => track.lang === activeSubtitle);
    subtitleCuesRef.current = selected ? parseVttCues(selected.content) : [];
  }, [subtitles, activeSubtitle]);

  useEffect(() => {
    const selected = subtitles.find((track) => track.lang === activeSubtitle);
    const next = { offset: selected?.offset ?? 0, scale: selected?.scale ?? 1 };
    timingRef.current = next;
    setTiming(next);
    setSyncAnchors([]);
    setSyncHint("");
  }, [activeSubtitle, subtitles]);

  const subtitleClockTime = currentTime;

  useEffect(() => {
    // Reverse-transform the playback clock so timing corrections apply to cues.
    const sourceTime = (subtitleClockTime - timing.offset) / timing.scale;
    setActiveCue(captionsEnabled ? cueAtTime(subtitleCuesRef.current, sourceTime) : null);
  }, [subtitleClockTime, timing.offset, timing.scale, captionsEnabled, subtitles, activeSubtitle]);

  const changeOffset = (delta: number) => {
    void persistTiming({ ...timingRef.current, offset: timingRef.current.offset + delta });
  };

  const nearestCueTo = (time: number) => {
    const cues = subtitleCuesRef.current;
    const { offset, scale } = timingRef.current;
    return cues.reduce<SubtitleCue | null>((best, cue) => {
      if (!best) return cue;
      return Math.abs(cue.start * scale + offset - time) <
        Math.abs(best.start * scale + offset - time)
        ? cue
        : best;
    }, null);
  };

  const alignNearestCue = () => {
    const cue = nearestCueTo(subtitleClockTime);
    if (!cue) {
      toast.error("Pilih subtitle terlebih dahulu");
      return;
    }
    const offset = subtitleClockTime - cue.start * timingRef.current.scale;
    setSyncHint(`Diselaraskan ke: "${cue.text.slice(0, 48)}"`);
    void persistTiming({ ...timingRef.current, offset });
  };

  const setDriftAnchor = () => {
    const cue = nearestCueTo(subtitleClockTime);
    if (!cue) {
      toast.error("Pilih subtitle terlebih dahulu");
      return;
    }
    const next = [...syncAnchors, { t: subtitleClockTime, cueStart: cue.start }];
    if (next.length < 2) {
      setSyncAnchors(next);
      setSyncHint("Titik A tersimpan. Tekan lagi saat mencapai cue berikutnya.");
      return;
    }
    const [a, b] = next;
    const cueDelta = b.cueStart - a.cueStart;
    if (cueDelta <= 0 || b.t - a.t <= 0) {
      toast.error("Pilih dua cue yang berbeda untuk titik A dan B");
      setSyncAnchors([next[1]]);
      return;
    }
    const scale = (b.t - a.t) / cueDelta;
    const clean = clampTiming({ offset: a.t - a.cueStart * scale, scale });
    setSyncAnchors([]);
    setSyncHint(`Drift dikoreksi: ${clean.scale.toFixed(3)}×`);
    void persistTiming(clean);
  };

  const resetDrift = () => {
    const cue = nearestCueTo(subtitleClockTime);
    const offset = cue ? subtitleClockTime - cue.start : timingRef.current.offset;
    setSyncAnchors([]);
    setSyncHint("Drift dikembalikan ke 1.000×");
    void persistTiming({ offset, scale: 1 });
  };

  const onSubtitleFileChange = (file?: File) => {
    setSubtitleFile(file ?? null);
    setSubtitlePreview([]);
    setSubtitleWarnings([]);
    setSubtitleInvalid(false);
    if (!file) return;
    void file.text().then((text) => {
      try {
        const result = validateSubtitle(text);
        setSubtitlePreview(result.cues.slice(0, 3));
        setSubtitleWarnings(result.warnings);
      } catch (error) {
        setSubtitleInvalid(true);
        setSubtitleWarnings([error instanceof Error ? error.message : "Invalid subtitle file"]);
      }
    });
  };

  const refreshSubtitles = async (preferredLang: string) => {
    if (!movie?.id) return;
    const tracks = await listSubtitles(movie.id);
    setSubtitles(tracks);
    subtitleCuesRef.current = tracks.length
      ? parseVttCues(tracks.find((t) => t.lang === preferredLang)?.content ?? tracks[0].content)
      : [];
    setActiveSubtitle(pickInitialSubtitle(tracks, preferredLang));
    setCaptionsEnabled(true);
    persistSubtitleChoice(preferredLang);
  };

  const addUploadedSubtitle = async () => {
    if (!movie?.id || !subtitleFile) return;
    setSubtitleBusy(true);
    try {
      const content = await subtitleFile.text();
      const track = await uploadSubtitle({
        mediaId: movie.id,
        lang: newSubLang.trim(),
        label: newSubLabel.trim() || newSubLang.trim(),
        content,
      });
      await refreshSubtitles(track.lang);
      setSubtitleFile(null);
      toast.success("Subtitle uploaded");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not upload subtitle");
    } finally {
      setSubtitleBusy(false);
    }
  };

  const addRemoteSubtitle = async () => {
    if (!movie?.id || !newSubUrl.trim()) return;
    setSubtitleBusy(true);
    try {
      const track = await addSubtitleFromUrl({
        mediaId: movie.id,
        lang: newSubLang.trim(),
        label: newSubLabel.trim() || newSubLang.trim(),
        url: newSubUrl.trim(),
      });
      await refreshSubtitles(track.lang);
      setNewSubUrl("");
      toast.success("Subtitle added from URL");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load subtitle URL");
    } finally {
      setSubtitleBusy(false);
    }
  };

  const searchSubdl = async () => {
    if (!movie?.id) return;
    setSubdlOpen(true);
    setSubdlBusy(true);
    setSubdlError(null);
    try {
      const results = await searchSubdlSubtitles({
        mediaId: movie.id,
        season: typeof season === "number" ? season : undefined,
        episode: typeof episode === "number" ? episode : undefined,
        languages: "ID,EN",
      });
      setSubdlResults(results);
      if (results.length === 0)
        setSubdlError("Tidak ada subtitle ditemukan di SubDL untuk judul ini.");
    } catch (error) {
      setSubdlResults([]);
      setSubdlError(error instanceof Error ? error.message : "Gagal mencari subtitle di SubDL");
    } finally {
      setSubdlBusy(false);
    }
  };

  const importSubdl = async (result: SubdlSubtitleResult) => {
    if (!movie?.id) return;
    setSubtitleBusy(true);
    try {
      const track = await importSubdlSubtitle({
        mediaId: movie.id,
        lang: result.lang,
        label: result.releaseName.slice(0, 60),
        downloadPath: result.downloadPath,
        releaseName: result.releaseName,
      });
      await refreshSubtitles(track.lang);
      toast.success("Subtitle SubDL berhasil ditambahkan");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Gagal mengimpor subtitle SubDL");
    } finally {
      setSubtitleBusy(false);
    }
  };

  const removeSubtitle = async (track: SubtitleTrack) => {
    if (!track.isOwner) {
      toast.error("You can only remove subtitles you added");
      return;
    }
    setSubtitleBusy(true);
    try {
      await deleteSubtitle(track.id);
      const tracks = await listSubtitles(movie?.id ?? "");
      setSubtitles(tracks);
      if (activeSubtitle === track.lang) {
        const fallback = pickInitialSubtitle(tracks, null);
        setActiveSubtitle(fallback);
        setCaptionsEnabled(fallback !== null);
        persistSubtitleChoice(fallback);
      }
      toast.success("Subtitle removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove subtitle");
    } finally {
      setSubtitleBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.connection) return;
    const conn = navigator.connection;
    const update = () => setConnectionQuality(conn.effectiveType ?? null);
    update();
    conn.addEventListener("change", update);
    return () => conn.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let sid: string | null = null;
    startSession(movie.id).then((id) => {
      sid = id;
      setSessionId(id);
    });
    return () => {
      if (sid) endSession(sid).catch(() => {});
    };
  }, [movie.id]);

  // Restore the saved position (or the position held before a URL refresh) and
  // honour ?autoplay exactly once for each resolved stream.
  const applyResumeAndAutoplay = useCallback(() => {
    const video = videoRef.current;
    if (!video || resumeAppliedRef.current) return;
    resumeAppliedRef.current = true;
    const target = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (target != null && Number.isFinite(target) && target > 0) {
      const limit =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 1 : target;
      try {
        video.currentTime = Math.min(target, Math.max(0, limit));
      } catch {}
    }
    if (shouldAutoplayRef.current) void video.play().catch(() => {});
  }, []);

  useEffect(() => {
    const mediaKey = `${movie.id}:${season ?? 1}:${episode ?? 1}`;
    const isMediaChange = lastMediaKeyRef.current !== mediaKey;
    lastMediaKeyRef.current = mediaKey;

    const controller = new AbortController();
    let cancelled = false;
    let expiryTimer: number | null = null;

    if (isMediaChange) {
      setStreamUrl("");
      setGatewaySubtitles([]);
      setGatewaySources([]);
      setGatewayError(null);
      setBuffering(true);
      setCurrentTime(0);
      setProgress(0);
      setDuration(0);
      setPlaying(false);
      setEnded(false);
      playbackPositionRef.current = 0;
      wasPlayingRef.current = false;
      lastRecordRef.current = 0;

      const itemId =
        season != null && episode != null ? `${movie.id}:S${season}E${episode}` : movie.id;
      const saved = getContinueWatching().find((item) => item.id === itemId);
      const initialPosition =
        saved && Number.isFinite(saved.progress) && saved.progress > 0 ? saved.progress : null;
      setSavedPosition(initialPosition);
      pendingSeekRef.current = initialPosition;
      shouldAutoplayRef.current = Boolean(autoplayRef.current);
    } else {
      // The signed URL is being refreshed/retried: keep the viewer's position.
      shouldAutoplayRef.current = wasPlayingRef.current;
      if (playbackPositionRef.current > 0) pendingSeekRef.current = playbackPositionRef.current;
    }
    resumeAppliedRef.current = false;
    setGatewayLoading(true);

    (async () => {
      try {
        const response = await fetch(
          buildGatewayUrl(movie.id, season, episode, reloadRequest.force),
          { method: "GET", signal: controller.signal },
        );
        if (!response.ok) {
          let detail = response.statusText || `HTTP ${response.status}`;
          try {
            const body: unknown = await response.json();
            if (isRecord(body)) {
              const message = body.message ?? body.error ?? body.detail;
              if (typeof message === "string" && message.trim()) detail = message;
            }
          } catch {}
          throw new Error(`MediaFlow gateway error (${response.status}): ${detail}`);
        }
        const result = parseGatewayResponse(await response.json());
        if (cancelled) return;
        setGatewaySubtitles(result.subtitles);
        setGatewaySources(result.sources);
        setGatewayError(null);
        setBuffering(true);
        setStreamUrl(result.streamUrl);

        if (result.expiresIn != null) {
          const delay = Math.max(result.expiresIn * 1000 - 60_000, 30_000);
          expiryTimer = window.setTimeout(() => {
            const video = videoRef.current;
            if (video && !video.paused && !video.ended) reloadGateway(false);
          }, delay);
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Gagal memuat stream dari MediaFlow.";
        setGatewayError(message);
        toast.error(message);
      } finally {
        if (!cancelled) setGatewayLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (expiryTimer != null) window.clearTimeout(expiryTimer);
    };
  }, [movie.id, season, episode, reloadRequest, reloadGateway]);

  useEffect(() => {
    const video = videoRef.current;
    if (!streamUrl || !video) return;
    resumeAppliedRef.current = false;
    let hls: Hls | null = null;

    if (/\.m3u8(?:$|[?#])/i.test(streamUrl) && Hls.isSupported()) {
      hls = new Hls();
      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, applyResumeAndAutoplay);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        const message = `Stream gagal diputar (${data.details || data.type}).`;
        toast.error(message);
        setGatewayError(message);
      });
      hls.loadSource(streamUrl);
    } else {
      video.src = streamUrl;
      video.load();
    }

    return () => {
      if (hls) {
        hls.off(Hls.Events.MANIFEST_PARSED, applyResumeAndAutoplay);
        hls.destroy();
        if (hlsRef.current === hls) hlsRef.current = null;
      } else {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [streamUrl, applyResumeAndAutoplay]);

  const handleGatewayRetry = useCallback(() => {
    setGatewayError(null);
    reloadGateway(true);
  }, [reloadGateway]);

  useEffect(() => {
    const onBlocked = (e: Event) => {
      const url = (e as CustomEvent).detail;
      if (url) toast.info(`Blocked redirect: ${new URL(url).hostname}`);
    };
    window.addEventListener("blocked-redirect", onBlocked);
    return () => window.removeEventListener("blocked-redirect", onBlocked);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      videoRef.current?.pause();
      try {
        screen.orientation?.unlock();
      } catch {}
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    };
  }, []);

  if (!movie) {
    return (
      <div className="grid min-h-dvh place-items-center gap-4 bg-black text-white">
        <p className="text-red-400">Movie not available</p>
        <Link to="/" className="text-sm text-white/60 hover:text-white underline">
          Go home
        </Link>
      </div>
    );
  }

  if (
    kidsMode &&
    (isRatingBlockedForKids(movie.rating) || isGenreBlockedForKids(movie.genreIds ?? []))
  ) {
    return (
      <div className="grid min-h-dvh place-items-center gap-4 bg-black px-4 text-center">
        <div className="grid size-24 place-items-center rounded-full bg-amber-500/15">
          <ShieldOff className="size-12 text-amber-400" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-white">Content not available for kids</h2>
          <p className="max-w-sm text-sm text-white/50">
            This title isn't suitable for kids profiles. Switch to a regular profile to watch it.
          </p>
        </div>
        <Link
          to="/browse"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Back to Browse
        </Link>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative h-dvh w-screen overflow-hidden bg-black select-none"
      onMouseMove={wake}
      onTouchEnd={onContainerTouch}
    >
      {streamUrl && (
        <video
          ref={videoRef}
          controls
          playsInline
          crossOrigin="anonymous"
          preload="metadata"
          poster={movie.backdrop}
          onPlay={() => {
            setPlaying(true);
            wasPlayingRef.current = true;
            setEnded(false);
          }}
          onPause={(e) => {
            setPlaying(false);
            wasPlayingRef.current = false;
            doRecord(e.currentTarget.currentTime, e.currentTarget.duration || 0);
          }}
          onTimeUpdate={(e) => {
            const cur = e.currentTarget.currentTime;
            const dur = e.currentTarget.duration || 1;
            playbackPositionRef.current = cur;
            const now = Date.now();
            if (now - lastTimeUpdateRef.current >= 1000) {
              lastTimeUpdateRef.current = now;
              setProgress(dur > 0 ? (cur / dur) * 100 : 0);
              setDuration(dur);
              setCurrentTime(cur);
            }
            if (now - lastRecordRef.current >= 5000 || cur === 0) {
              lastRecordRef.current = now;
              doRecord(cur, dur);
            }
          }}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            applyResumeAndAutoplay();
          }}
          onCanPlay={() => setBuffering(false)}
          onVolumeChange={(e) => {
            setVolume(e.currentTarget.volume);
            setMuted(e.currentTarget.muted);
          }}
          onEnded={(e) => {
            const dur = e.currentTarget.duration || 0;
            doRecord(dur, dur);
            handleVideoEnded();
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => setBuffering(false)}
          className="size-full bg-black object-contain"
        >
          {gatewaySubtitles.map((sub, index) => (
            <track
              key={`gateway-${sub.id}`}
              kind="subtitles"
              src={sub.url}
              srcLang={sub.language}
              label={sub.label}
              default={isDefaultGatewaySubtitle(sub, index, gatewaySubtitles)}
            />
          ))}
          {subtitles.map((sub) => (
            <track
              key={`custom-${sub.id}`}
              kind="subtitles"
              src={sub.url}
              srcLang={sub.lang}
              label={sub.label}
            />
          ))}
        </video>
      )}

      {gatewayError && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center">
          <p className="max-w-lg text-sm text-red-300">{gatewayError}</p>
          <button
            type="button"
            onClick={handleGatewayRetry}
            className="inline-flex items-center gap-2 rounded bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-white/90"
          >
            <RotateCw className="size-4" /> Coba lagi
          </button>
        </div>
      )}

      {/* Custom subtitle overlay (uploads / SubDL); gateway tracks use native <track>. */}
      {captionsEnabled && activeSubtitle && activeCue && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-[16%] z-20 flex justify-center px-6 sm:bottom-[12%]"
          aria-live="polite"
        >
          <div className="max-w-[85%] rounded bg-black/70 px-4 py-2 text-center text-base font-medium leading-snug text-white shadow-lg sm:max-w-[75%] sm:text-xl">
            {activeCue.text}
          </div>
        </div>
      )}

      {!showControls && (
        <button
          type="button"
          onClick={handleWakeTap}
          onTouchEnd={handleWakeTap}
          className="absolute inset-0 z-10 bg-transparent"
          aria-hidden="true"
        />
      )}

      {/* Top gradient overlay */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black via-black/60 to-transparent pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="pointer-events-auto flex flex-col gap-2 px-2 sm:px-6">
          <div className="flex items-center justify-between">
            <div className="group/topbtn rounded-lg transition-colors duration-200 hover:bg-white/10 hover:backdrop-blur-sm -ml-1 sm:-ml-2 px-1 sm:px-2 py-2 sm:py-1">
              <button
                onClick={goBack}
                className="inline-flex items-center gap-1 sm:gap-2 text-white/90 hover:text-white min-h-10"
              >
                <ArrowLeft className="size-6 sm:size-6" />
                <span className="text-sm sm:text-base font-semibold drop-shadow-md">
                  {movie.title}
                  {season != null && episode != null && (
                    <span className="ml-2 text-sm font-normal text-white/60">
                      S{season} E{episode}
                    </span>
                  )}
                </span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              {pipSupported && (
                <button
                  onClick={() => videoRef.current && enterPictureInPicture(videoRef.current)}
                  aria-label="Picture in Picture"
                  className="hover:text-white/70 transition min-h-11 min-w-11 flex items-center justify-center"
                >
                  <Minimize2 className="size-5 sm:size-5" />
                </button>
              )}
              <button
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="hover:text-white/70 transition min-h-11 min-w-11 flex items-center justify-center"
              >
                {isFullscreen ? (
                  <Minimize2 className="size-5 sm:size-5" />
                ) : (
                  <Maximize2 className="size-5 sm:size-5" />
                )}
              </button>
              <div className="relative">
                <button
                  onClick={() => setShowSettings((v) => !v)}
                  aria-label="Settings"
                  className="hover:text-white/70 transition min-h-11 min-w-11 flex items-center justify-center"
                >
                  <Settings className="size-6 sm:size-6" />
                </button>
                {showSettings && (
                  <div
                    className={`absolute top-full right-0 mt-2 ${isTv ? "w-80" : "w-56"} max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border border-white/10 bg-black/90 p-3 text-sm shadow-2xl backdrop-blur-xl scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent`}
                  >
                    {isTv && (
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/50">
                            Autoplay next episode
                          </p>
                          <p className="text-[11px] text-white/50">
                            Automatically start the next episode when one ends.
                          </p>
                        </div>
                        <button
                          onClick={toggleAutoplayNext}
                          className={`rounded px-3 py-1.5 text-xs transition ${autoplayNext ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
                        >
                          {autoplayNext ? "On" : "Off"}
                        </button>
                      </div>
                    )}
                    {isTv && movie.numberOfSeasons && movie.numberOfSeasons > 0 && (
                      <div className="mb-3">
                        <SeasonEpisodePicker
                          movieId={movie.id}
                          numberOfSeasons={movie.numberOfSeasons}
                          currentSeason={season}
                          currentEpisode={episode}
                        />
                      </div>
                    )}
                    <div className="mb-3 border-t border-white/10 pt-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-white/50">
                          Subtitles
                        </p>
                        <button
                          onClick={toggleCaptions}
                          disabled={!activeSubtitle}
                          className={`rounded px-3 py-1.5 text-xs transition disabled:opacity-40 ${captionsEnabled ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
                        >
                          Captions {captionsEnabled ? "On" : "Off"}
                        </button>
                      </div>

                      <div className="mb-2 flex flex-wrap gap-1">
                        <button
                          onClick={() => handleSubtitleChange(null)}
                          className={`rounded px-3 py-1.5 text-xs transition ${activeSubtitle === null ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
                        >
                          Off
                        </button>
                        {subtitles.map((sub) => (
                          <button
                            key={sub.id}
                            onClick={() => handleSubtitleChange(sub.lang)}
                            className={`rounded px-3 py-1.5 text-xs transition ${activeSubtitle === sub.lang ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
                          >
                            <span className="font-semibold">{languageLabel(sub.lang)}</span>
                            {sub.label !== languageLabel(sub.lang) && (
                              <span className="ml-1 text-white/50">{sub.label}</span>
                            )}
                          </button>
                        ))}
                      </div>

                      {subtitles.length === 0 && (
                        <p className="mb-2 text-[11px] text-white/50">
                          No subtitles yet. Upload a .vtt/.srt file or add a third-party subtitle
                          URL below.
                        </p>
                      )}

                      <div className="mb-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white/60">Timing offset</span>
                          <span className="text-xs tabular-nums text-white/80">
                            {timing.offset.toFixed(1)}s
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <button
                            onClick={() => changeOffset(-5)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            -5s
                          </button>
                          <button
                            onClick={() => changeOffset(-1)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            -1s
                          </button>
                          <button
                            onClick={() => changeOffset(-0.5)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            -0.5s
                          </button>
                          <button
                            onClick={() => changeOffset(0.5)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            +0.5s
                          </button>
                          <button
                            onClick={() => changeOffset(1)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            +1s
                          </button>
                          <button
                            onClick={() => changeOffset(5)}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            +5s
                          </button>
                          <button
                            onClick={() => void persistTiming({ offset: 0, scale: 1 })}
                            className="rounded px-2 py-1 text-[11px] text-white/50 hover:text-white"
                          >
                            reset
                          </button>
                        </div>
                      </div>

                      <div className="mb-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white/60">Pencocokan waktu</span>
                          <span className="text-xs tabular-nums text-white/80">
                            {timing.scale.toFixed(3)}×
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <button
                            onClick={alignNearestCue}
                            className="rounded bg-white/15 px-2 py-1 text-xs text-white hover:bg-white/25"
                          >
                            Sinkron di sini
                          </button>
                          <button
                            onClick={setDriftAnchor}
                            className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                          >
                            {syncAnchors.length ? "Titik B" : "Titik A"}
                          </button>
                          <button
                            onClick={resetDrift}
                            className="rounded px-2 py-1 text-[11px] text-white/50 hover:text-white"
                          >
                            Reset drift
                          </button>
                        </div>
                        <p className="mt-1 text-[10px] leading-tight text-white/40">
                          Tekan &quot;Sinkron di sini&quot; saat dialog muncul. Untuk selisih
                          kecepatan, tekan Titik A lalu Titik B pada dialog berikutnya.
                        </p>
                        {syncHint && (
                          <p className="mt-1 text-[10px] leading-tight text-emerald-400/80">
                            {syncHint}
                          </p>
                        )}
                      </div>

                      <div className="mb-2 rounded border border-white/10 bg-white/5 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-semibold text-white/80">SubDL</p>
                            <p className="text-[10px] text-white/45">
                              Cari subtitle ID/EN otomatis dari SubDL
                            </p>
                          </div>
                          <button
                            onClick={() => void searchSubdl()}
                            disabled={subdlBusy}
                            className="rounded bg-white/15 px-2 py-1.5 text-xs text-white hover:bg-white/25 disabled:opacity-40"
                          >
                            {subdlBusy ? "Mencari..." : "Cari subtitle"}
                          </button>
                        </div>
                        {subdlError && (
                          <p className="mt-2 text-[11px] text-amber-400/90">{subdlError}</p>
                        )}
                        {subdlOpen && subdlResults.length > 0 && (
                          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
                            {subdlResults.map((result) => {
                              const alreadyAdded = subtitles.some(
                                (s) =>
                                  s.origin === "subdl.com" &&
                                  s.label.includes(result.releaseName.slice(0, 30)),
                              );
                              return (
                                <div
                                  key={result.id}
                                  className="flex items-start gap-2 rounded bg-black/30 px-2 py-1.5"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[11px] text-white/80">
                                      <span className="font-semibold">
                                        {languageLabel(result.lang)}
                                      </span>
                                      {result.hi && <span className="ml-1 text-white/45">HI</span>}
                                      <span className="ml-1 text-white/45">
                                        {result.format.toUpperCase()}
                                      </span>
                                    </p>
                                    <p
                                      className="truncate text-[10px] text-white/45"
                                      title={result.releaseName}
                                    >
                                      {result.releaseName}
                                      {result.author ? ` · ${result.author}` : ""}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => void importSubdl(result)}
                                    disabled={subtitleBusy || alreadyAdded}
                                    className="shrink-0 rounded bg-white/10 px-2 py-1 text-[11px] text-white hover:bg-white/20 disabled:opacity-40"
                                  >
                                    {alreadyAdded ? "Ada" : "Pakai"}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="space-y-2 rounded border border-white/10 bg-white/5 p-2">
                        <div className="flex gap-2">
                          <input
                            value={newSubLang}
                            onChange={(e) => {
                              setNewSubLang(e.target.value);
                              setNewSubLabel(languageLabel(e.target.value));
                            }}
                            placeholder="id / en"
                            className="w-14 rounded bg-black/50 px-2 py-1 text-xs outline-none"
                          />
                          <input
                            value={newSubLabel}
                            onChange={(e) => setNewSubLabel(e.target.value)}
                            placeholder="Label"
                            className="min-w-0 flex-1 rounded bg-black/50 px-2 py-1 text-xs outline-none"
                          />
                        </div>
                        <input
                          value={newSubUrl}
                          onChange={(e) => setNewSubUrl(e.target.value)}
                          placeholder="Subtitle URL (.vtt / .srt)"
                          className="w-full rounded bg-black/50 px-2 py-1 text-xs outline-none"
                        />
                        <button
                          onClick={addRemoteSubtitle}
                          disabled={subtitleBusy || !newSubUrl.trim()}
                          className="w-full rounded bg-white/15 px-2 py-1.5 text-xs text-white hover:bg-white/25 disabled:opacity-40"
                        >
                          Add subtitle from URL
                        </button>
                        <div className="flex items-center gap-2">
                          <input
                            type="file"
                            accept=".vtt,.srt,text/vtt,application/x-subrip"
                            onChange={(e) => onSubtitleFileChange(e.target.files?.[0])}
                            className="min-w-0 flex-1 text-[11px] text-white/60 file:mr-2 file:rounded file:bg-white/10 file:px-2 file:py-1 file:text-xs file:text-white"
                          />
                          <button
                            onClick={addUploadedSubtitle}
                            disabled={subtitleBusy || !subtitleFile || subtitleInvalid}
                            className="rounded bg-white/15 px-2 py-1.5 text-xs text-white hover:bg-white/25 disabled:opacity-40"
                          >
                            Upload
                          </button>
                        </div>
                        {(subtitlePreview.length > 0 || subtitleWarnings.length > 0) && (
                          <div className="rounded border border-white/10 bg-black/40 p-2">
                            {subtitleWarnings.map((warning) => (
                              <p
                                key={warning}
                                className="text-[10px] leading-tight text-amber-400/90"
                              >
                                {warning}
                              </p>
                            ))}
                            {subtitlePreview.map((cue, i) => (
                              <p key={i} className="mt-0.5 truncate text-[10px] text-white/50">
                                {Math.floor(cue.start / 60)}:
                                {String(Math.floor(cue.start % 60)).padStart(2, "0")} · {cue.text}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {subtitles.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {subtitles.map((sub) => (
                            <div
                              key={sub.id}
                              className="flex items-center gap-2 text-[11px] text-white/60"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {languageLabel(sub.lang)}
                                {sub.label !== languageLabel(sub.lang) && ` · ${sub.label}`}{" "}
                                <span className="text-white/35">
                                  ({sub.source}
                                  {sub.offset !== 0 || sub.scale !== 1
                                    ? `, ${sub.offset.toFixed(1)}s ${sub.scale.toFixed(3)}×`
                                    : ""}
                                  )
                                </span>
                              </span>
                              {sub.isOwner && (
                                <button
                                  onClick={() => removeSubtitle(sub)}
                                  disabled={subtitleBusy}
                                  className="text-white/40 hover:text-red-400 disabled:opacity-40"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Center play/pause overlay removed */}

      {/* Rotate device hint */}
      {showRotateHint && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 gap-4 pointer-events-none">
          <RotateCw className="size-16 text-white/70 animate-[spin_2s_linear_infinite]" />
          <p className="text-sm text-white/70 text-center px-8">
            Rotate your device to landscape for a better viewing experience
          </p>
        </div>
      )}

      {/* Loading spinner */}
      {(gatewayLoading || (buffering && !gatewayError)) && !ended && (
        <div className="absolute inset-0 z-15 flex items-center justify-center pointer-events-none">
          <Loader className="size-10 text-white/60 animate-spin" />
        </div>
      )}

      {/* Post-play overlay */}
      {ended && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70">
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-lg text-white/70">You've finished watching</p>
            <h2 className="text-2xl font-bold text-white">{movie.title}</h2>
            <div className="flex items-center gap-3">
              {isTv && nextEp && (
                <button
                  onClick={() => {
                    setEnded(false);
                    goToNextEpisode();
                  }}
                  className="rounded bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition"
                >
                  Next Episode
                </button>
              )}
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) {
                    v.currentTime = 0;
                    v.play().catch(() => {});
                    setPlaying(true);
                    setEnded(false);
                  }
                }}
                className="rounded bg-white px-6 py-2 text-sm font-semibold text-black hover:bg-white/90 transition"
              >
                Play Again
              </button>
              <button
                onClick={goBack}
                className="rounded bg-white/10 px-6 py-2 text-sm font-semibold text-white hover:bg-white/20 transition"
              >
                Back to Movie
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/watch/$id")({
  ssr: false,
  validateSearch: watchSearchSchema,
  loader: async ({ params }) => {
    let movie: any = null;
    try {
      movie = await movieById(params.id);
    } catch {}
    return { movie };
  },
  head: ({ loaderData }) => {
    const movie = loaderData?.movie;
    const title = `Watching ${movie?.title ?? "Video"} — OPLAY.ID`;
    const description = movie?.description
      ? `${movie.description.slice(0, 200)}`
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
      <p className="whitespace-pre font-mono text-xs text-white/40">
        {(error as Error).stack?.split("\n").slice(0, 3).join("\n")}
      </p>
      <Link to="/" className="text-sm text-white/60 hover:text-white underline">
        Go home
      </Link>
    </div>
  ),
});
