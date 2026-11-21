import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState, useCallback, type MouseEvent, type TouchEvent } from "react";
import { ArrowLeft, Settings, Loader, RotateCw, ShieldOff, Minimize2 } from "lucide-react";
import { movieById } from "@/lib/streamflix-data";
import { recordProgress } from "@/lib/continue-watching";
import { saveProgressToFirestore } from "@/lib/continue-watching-firestore";
import { probeEmbedUrl, fetchTvSeason } from "@/lib/api/tmdb";
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
  languageLabel,
  listSubtitles,
  parseVttCues,
  pickInitialSubtitle,
  updateSubtitleTiming,
  uploadSubtitle,
  validateSubtitle,
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

interface EmbedServer {
  id: string;
  name: string;
  urls: {
    movie: string;
    tv: string;
  };
}

// Kept deliberately small: these two were the most reliable in direct probes.
const availableEmbedServers: EmbedServer[] = [
  {
    id: "vsembed",
    name: "VSEmbed",
    urls: {
      movie: "https://vsembed.su/embed/movie/{id}",
      tv: "https://vsembed.su/embed/tv/{id}/{season}/{episode}",
    },
  },
  {
    id: "2embed",
    name: "2Embed",
    urls: {
      movie: "https://www.2embed.cc/embed/{id}",
      tv: "https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}",
    },
  },
];

const embedHostnames = new Set(
  availableEmbedServers.map((server) => {
    try {
      return new URL(server.urls.movie).hostname;
    } catch {
      return server.urls.movie;
    }
  }),
);

function buildEmbedUrl(
  serverId: string,
  movieId: string,
  season: number | undefined,
  episode: number | undefined,
) {
  const server =
    availableEmbedServers.find((item) => item.id === serverId) ?? availableEmbedServers[0];
  const isTv = movieId.startsWith("tv-");
  const tmdbId = isTv ? movieId.slice(3) : movieId;
  const template = isTv ? server.urls.tv : server.urls.movie;
  return template
    .replace("{id}", tmdbId)
    .replace("{season}", String(season ?? 1))
    .replace("{episode}", String(episode ?? 1));
}

function isEmbedUrl(url: string) {
  try {
    const hostname = new URL(url).hostname;
    return embedHostnames.has(hostname);
  } catch {
    return false;
  }
}

type EmbedPlaybackCommand = "handshake" | "play" | "pause" | "seek" | "requestProgress";

type EmbedPlaybackMessage = {
  type: "STREAMFLIX_EMBED_PLAYBACK";
  command: EmbedPlaybackCommand;
  time?: number;
};

type EmbedPlaybackResponse = {
  type: "STREAMFLIX_EMBED_PROGRESS" | "STREAMFLIX_EMBED_READY";
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
};

function sendEmbedPlaybackCommand(
  iframe: HTMLIFrameElement | null,
  command: EmbedPlaybackCommand,
  time?: number,
) {
  if (!iframe?.contentWindow) return;
  const message: EmbedPlaybackMessage = {
    type: "STREAMFLIX_EMBED_PLAYBACK",
    command,
  };
  if (typeof time === "number") message.time = time;
  iframe.contentWindow.postMessage(message, "*");
}

function PlayerPage() {
  const data = Route.useLoaderData();
  const movie = data?.movie;
  const { season, episode } = Route.useSearch();

  const kidsMode = isKidsProfile();

  const [videoUrl, setVideoUrl] = useState<string>("");
  const mainVideoUrlRef = useRef<string>("");
  const [mainVideoUrl, setMainVideoUrl] = useState("");
  const [selectedServerId, setSelectedServerId] = useState<string>(() => {
    if (typeof window === "undefined") return "vsembed";
    try {
      const savedId = localStorage.getItem("sf:embedServer");
      return availableEmbedServers.some((server) => server.id === savedId) ? savedId! : "vsembed";
    } catch {
      return "vsembed";
    }
  });
  const selectedServer =
    availableEmbedServers.find((server) => server.id === selectedServerId) ??
    availableEmbedServers[0];

  const [currentTime, setCurrentTime] = useState(0);
  const [mainSourceReady, setMainSourceReady] = useState(false);
  const resumedRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [embedSyncSupported, setEmbedSyncSupported] = useState(false);
  const lastEmbedProgressRef = useRef(0);
  const [savedPosition, setSavedPosition] = useState<number | null>(null);


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
  // Third-party embeds cannot report playback time, so the subtitle overlay uses
  // a local clock that the viewer starts/pauses alongside the embed player.
  const [manualClockRunning, setManualClockRunning] = useState(false);
  const [manualClockTime, setManualClockTime] = useState(0);
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
  const embedEndedFiredRef = useRef(false);

  const handleServerSelect = useCallback((id: string) => {
    setSelectedServerId(id);
    try {
      localStorage.setItem("sf:embedServer", id);
    } catch {}
  }, []);

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
      testVideo.src = "data:video/mp4;base64,AAAAIGZ0eXBtcDQyAAAAAG1wNDJpc21vbXAyAAAAHG1vb2YAAABsbXZoZAAAAPNtZGF0YQ==";
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
    embedEndedFiredRef.current = false;
  }, [movie.id, season, episode]);

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
    if (!showSettings) {
      hideTimer.current = window.setTimeout(() => setShowControls(false), 3000);
    }
  }, [showSettings]);

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

  const persistTiming = useCallback(async (next: { offset: number; scale: number }) => {
    const clean = clampTiming(next);
    timingRef.current = clean;
    setTiming(clean);
    const active = subtitles.find((track) => track.lang === activeSubtitle);
    setSubtitles((prev) => prev.map((track) =>
      track.id === active?.id ? { ...track, ...clean } : track,
    ));
    if (!active?.isOwner) return;
    try {
      await updateSubtitleTiming({ id: active.id, ...clean });
    } catch {
      toast.error("Could not save subtitle timing");
    }
  }, [subtitles, activeSubtitle]);

  useEffect(() => {
    if (!movie?.id) return;
    let cancelled = false;
    const mediaId = movie.id;
    listSubtitles(mediaId)
      .then(async (tracks) => {
        let saved: string | null = null;
        let legacyOffset: number | null = null;
        try { saved = localStorage.getItem(`sf:subtitle:${mediaId}`); } catch {}
        try {
          const raw = localStorage.getItem(`sf:subtitleOffset:${mediaId}`);
          if (raw != null && Number.isFinite(Number(raw))) legacyOffset = Number(raw);
        } catch {}
        const initial = pickInitialSubtitle(tracks, saved);
        if (cancelled) return;
        setSubtitles(tracks);
        setActiveSubtitle(initial);
        setCaptionsEnabled(initial !== null);
        setManualClockTime(0);
        setManualClockRunning(false);

        // Migrate the old single global offset into the selected track once.
        if (legacyOffset && legacyOffset !== 0 && initial) {
          const track = tracks.find((item) => item.lang === initial);
          if (track?.isOwner && track.offset === 0) {
            try {
              await updateSubtitleTiming({ id: track.id, offset: legacyOffset, scale: 1 });
              if (!cancelled) {
                setSubtitles((prev) => prev.map((item) =>
                  item.id === track.id ? { ...item, offset: legacyOffset!, scale: 1 } : item,
                ));
                localStorage.removeItem(`sf:subtitleOffset:${mediaId}`);
              }
            } catch {}
          }
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
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

  const subtitleClockTime = embedSyncSupported ? currentTime : manualClockTime;

  useEffect(() => {
    if (!manualClockRunning) return;
    let last = Date.now();
    const timer = window.setInterval(() => {
      const tick = Date.now();
      setManualClockTime((time) => time + (tick - last) / 1000);
      last = tick;
    }, 250);
    return () => window.clearInterval(timer);
  }, [manualClockRunning]);

  useEffect(() => {
    // Reverse-transform the playback clock so timing corrections apply to cues.
    const sourceTime = (subtitleClockTime - timing.offset) / timing.scale;
    setActiveCue(
      captionsEnabled ? cueAtTime(subtitleCuesRef.current, sourceTime) : null,
    );
  }, [subtitleClockTime, timing.offset, timing.scale, captionsEnabled, subtitles, activeSubtitle]);

  const changeOffset = (delta: number) => {
    void persistTiming({ ...timingRef.current, offset: timingRef.current.offset + delta });
  };

  const nearestCueTo = (time: number) => {
    const cues = subtitleCuesRef.current;
    const { offset, scale } = timingRef.current;
    return cues.reduce<SubtitleCue | null>((best, cue) => {
      if (!best) return cue;
      return Math.abs(cue.start * scale + offset - time) < Math.abs(best.start * scale + offset - time)
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

  // server fallback: probe embed servers only when user opens the server picker
  const probedRef = useRef(false);
  const probeServers = useCallback(async () => {
    if (probedRef.current) return;
    probedRef.current = true;
    const results = await Promise.all(
      availableEmbedServers.map(async (s) => ({
        id: s.id,
        ok: await probeEmbedUrl({
          data: { url: buildEmbedUrl(s.id, movie.id, season, episode) },
        }),
      })),
    );
    const live = results.find((r) => r.ok);
    const currentOk = results.find((r) => r.id === selectedServerId)?.ok;
    if (live && !currentOk) {
      const liveServer = availableEmbedServers.find((s) => s.id === live.id);
      setSelectedServerId(live.id);
      toast.warning(
        `"${selectedServer.name}" was unreachable — switched to ${liveServer?.name ?? live.id}`,
      );
    } else if (!currentOk) {
      toast.error(`${selectedServer.name} is unreachable. Try a different server below.`);
    }
  }, [movie.id, season, episode, selectedServerId, selectedServer.name]);

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

  useEffect(() => {
    const url = buildEmbedUrl(selectedServerId, movie.id, season, episode);
    setVideoUrl(url);
    setMainVideoUrl(url);
    mainVideoUrlRef.current = url;
    setEmbedSyncSupported(false);
  }, [selectedServerId, movie.id, season, episode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as EmbedPlaybackResponse | null;
      if (!data?.type) return;

      if (data.type === "STREAMFLIX_EMBED_READY") {
        setEmbedSyncSupported(true);
        return;
      }

      if (data.type === "STREAMFLIX_EMBED_PROGRESS") {
        if (typeof data.currentTime !== "number" || typeof data.duration !== "number") return;
        setCurrentTime(data.currentTime);
        setDuration(data.duration);

        const elapsed = Math.abs(data.currentTime - lastEmbedProgressRef.current);
        if (elapsed >= 5 || data.currentTime === 0) {
          lastEmbedProgressRef.current = data.currentTime;
          recordProgress(movie, data.currentTime, data.duration, season, episode);
          saveProgressToFirestore(movie, data.currentTime, data.duration, season, episode).catch(
            notifySaveError,
          );
        }

        if (
          embedSyncSupported &&
          autoplayNext &&
          isTv &&
          data.duration > 0 &&
          data.currentTime / data.duration >= 0.98 &&
          !embedEndedFiredRef.current
        ) {
          embedEndedFiredRef.current = true;
          goToNextEpisode();
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    movie,
    season,
    episode,
    embedSyncSupported,
    autoplayNext,
    isTv,
    goToNextEpisode,
    notifySaveError,
  ]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!embedSyncSupported || !iframe) return;
    const intervalId = window.setInterval(() => {
      sendEmbedPlaybackCommand(iframe, "requestProgress");
    }, 5000);
    return () => window.clearInterval(intervalId);
  }, [embedSyncSupported]);

  const handleEmbedLoad = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    sendEmbedPlaybackCommand(iframe, "handshake");
    sendEmbedPlaybackCommand(iframe, "requestProgress");
  };

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

  if (kidsMode && (isRatingBlockedForKids(movie.rating) || isGenreBlockedForKids(movie.genreIds ?? []))) {
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
        <Link to="/browse" className="rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
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
      {videoUrl ? (
        isEmbedUrl(videoUrl) ? (
          <iframe
            ref={iframeRef}
            src={videoUrl}
            title={`Embed Player — ${movie.title}`}
            allow="autoplay; fullscreen; encrypted-media"
            allowFullScreen
            onLoad={handleEmbedLoad}
            className="size-full border-0"
          />
        ) : (
          <video
            ref={videoRef}
            src={videoUrl}
            playsInline
            poster={movie.backdrop}
            onPlay={() => setPlaying(true)}
            onPause={(e) => {
              setPlaying(false);
              doRecord(e.currentTarget.currentTime, e.currentTarget.duration || 0);
            }}
            onTimeUpdate={(e) => {
              const cur = e.currentTarget.currentTime;
              const dur = e.currentTarget.duration || 1;
              const now = Date.now();
              if (now - lastTimeUpdateRef.current >= 1000) {
                lastTimeUpdateRef.current = now;
                setProgress(dur > 0 ? (cur / dur) * 100 : 0);
                setDuration(dur);
                setCurrentTime(cur);
              }
              if (Math.floor(cur) % 5 === 0) doRecord(cur, dur);
            }}
             onLoadedMetadata={(e) => {
              const dur = e.currentTarget.duration;
              setDuration(dur);
              if (pendingSeekRef.current != null) {
                const t = pendingSeekRef.current;
                pendingSeekRef.current = null;
                e.currentTarget.currentTime = t;
              }
            }}
            onCanPlay={(e) => {
              setBuffering(false);
            }}
            onVolumeChange={(e) => {
              setVolume(e.currentTarget.volume);
              setMuted(e.currentTarget.muted);
            }}
            onEnded={handleVideoEnded}
            onWaiting={() => setBuffering(true)}
            onPlaying={() => setBuffering(false)}
            className="size-full object-contain"
          >
            {subtitles.map((sub) => (
              <track
                key={sub.lang}
                kind="subtitles"
                src={sub.url}
                srcLang={sub.lang}
                label={sub.label}
              />
            ))}
          </video>
        )
      ) : null}

      {/* Subtitle overlay for embed players (native video uses <track> elements). */}
      {isEmbedUrl(videoUrl) && captionsEnabled && activeSubtitle && activeCue && (
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
              <div className="relative">
                <button
                  onClick={() => { setShowSettings((v) => !v); probeServers(); }}
                  aria-label="Settings"
                  className="hover:text-white/70 transition min-h-11 min-w-11 flex items-center justify-center"
                >
                  <Settings className="size-6 sm:size-6" />
                </button>
                {showSettings && (
                  <div
                    className={`absolute top-full right-0 mt-2 ${isTv ? "w-80" : "w-56"} max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border border-white/10 bg-black/90 p-3 text-sm shadow-2xl backdrop-blur-xl scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent`}
                  >
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
                      Server
                    </p>
                    <div className="grid grid-cols-2 gap-1 mb-3 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent">
                      {availableEmbedServers.map((server) => (
                        <button
                          key={server.id}
                          onClick={() => handleServerSelect(server.id)}
                          className={`rounded px-3 py-1.5 text-xs text-left transition ${selectedServerId === server.id ? "bg-white/20 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
                        >
                          {server.name}
                        </button>
                      ))}
                    </div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">
                      Selected
                    </p>
                    <div className="mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/80">
                      {selectedServer.name}
                    </div>
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
                          No subtitles yet. Upload a .vtt/.srt file or add a third-party subtitle URL
                          below.
                        </p>
                      )}

                      <div className="mb-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white/60">Timing offset</span>
                          <span className="text-xs tabular-nums text-white/80">{timing.offset.toFixed(1)}s</span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <button onClick={() => changeOffset(-5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">-5s</button>
                          <button onClick={() => changeOffset(-1)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">-1s</button>
                          <button onClick={() => changeOffset(-0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">-0.5s</button>
                          <button onClick={() => changeOffset(0.5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">+0.5s</button>
                          <button onClick={() => changeOffset(1)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">+1s</button>
                          <button onClick={() => changeOffset(5)} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">+5s</button>
                          <button onClick={() => void persistTiming({ offset: 0, scale: 1 })} className="rounded px-2 py-1 text-[11px] text-white/50 hover:text-white">reset</button>
                        </div>
                      </div>

                      <div className="mb-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white/60">Pencocokan waktu</span>
                          <span className="text-xs tabular-nums text-white/80">{timing.scale.toFixed(3)}×</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <button onClick={alignNearestCue} className="rounded bg-white/15 px-2 py-1 text-xs text-white hover:bg-white/25">Sinkron di sini</button>
                          <button onClick={setDriftAnchor} className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20">
                            {syncAnchors.length ? "Titik B" : "Titik A"}
                          </button>
                          <button onClick={resetDrift} className="rounded px-2 py-1 text-[11px] text-white/50 hover:text-white">Reset drift</button>
                        </div>
                        <p className="mt-1 text-[10px] leading-tight text-white/40">
                          Tekan &quot;Sinkron di sini&quot; saat dialog muncul. Untuk selisih kecepatan, tekan Titik A lalu Titik B pada dialog berikutnya.
                        </p>
                        {syncHint && <p className="mt-1 text-[10px] leading-tight text-emerald-400/80">{syncHint}</p>}
                      </div>

                      {isEmbedUrl(videoUrl) && !embedSyncSupported && activeSubtitle && (
                        <div className="mb-2 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] text-white/60">
                              Subtitle clock {Math.floor(manualClockTime / 60)}:
                              {String(Math.floor(manualClockTime % 60)).padStart(2, "0")}
                            </span>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => setManualClockRunning((v) => !v)}
                                className="rounded bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
                              >
                                {manualClockRunning ? "Pause" : "Start"}
                              </button>
                              <button
                                onClick={() => {
                                  setManualClockRunning(false);
                                  setManualClockTime(0);
                                }}
                                className="rounded px-2 py-1 text-[11px] text-white/50 hover:text-white"
                              >
                                Reset
                              </button>
                            </div>
                          </div>
                          <p className="mt-1 text-[10px] leading-tight text-white/40">
                            Embed players don&apos;t share playback time. Start this clock when the
                            movie starts, then use &quot;Sinkron di sini&quot; or the timing offset.
                          </p>
                        </div>
                      )}

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
                              <p key={warning} className="text-[10px] leading-tight text-amber-400/90">{warning}</p>
                            ))}
                            {subtitlePreview.map((cue, i) => (
                              <p key={i} className="mt-0.5 truncate text-[10px] text-white/50">
                                {Math.floor(cue.start / 60)}:{String(Math.floor(cue.start % 60)).padStart(2, "0")} · {cue.text}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {subtitles.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {subtitles.map((sub) => (
                            <div key={sub.id} className="flex items-center gap-2 text-[11px] text-white/60">
                              <span className="min-w-0 flex-1 truncate">
                                {languageLabel(sub.lang)}{sub.label !== languageLabel(sub.lang) && ` · ${sub.label}`}{" "}
                                <span className="text-white/35">({sub.source}{sub.offset !== 0 || sub.scale !== 1 ? `, ${sub.offset.toFixed(1)}s ${sub.scale.toFixed(3)}×` : ""})</span>
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
      {buffering && !ended && (
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
    const title = `Watching ${movie?.title ?? "Video"} — StreamFlix`;
    const description = movie?.description
      ? `${movie.description.slice(0, 200)}`
      : "Watch movies and TV shows on StreamFlix.";
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
