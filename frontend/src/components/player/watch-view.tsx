"use client";

// ---------------------------------------------------------------------------
// Watch page — full port of the old watch view (public/app.js ~1282-1766):
// enterWatch / renderWatchShell / goToEp / prefetchNext / setupCaptions /
// buildCcMenu / applyCaption / auto-next / watchJob / offline playback.
//
// Route: /watch/?id=<watchId>&ep=<n>  (watchId "offline:<titleId>" plays the
// saved copies with no server — old playOffline()). Episode switches swap the
// <video> source in place and history.replaceState the URL (no reload),
// Crunchyroll-style, exactly like the old goToEp.
//
// tvnav DOM contracts kept: #view-watch (blocking root while body.watching),
// #watchVideo, #watchBack, `wep` rows; body class "watching" via useTvBodyState.
// ---------------------------------------------------------------------------

import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { normCc } from "@/components/player/captions";
import { AutoNextCard, type AutoNextInfo } from "@/components/player/auto-next";
import { EpisodeList, type WatchEpisode } from "@/components/player/episode-list";
import { PlayerControls, type CcState } from "@/components/player/player-controls";
import { cameFromTitle, startWatch } from "@/components/player/play";
import {
  airedCount,
  orderedSeasons,
  seasonChip,
  seasonNumber,
  type WatchDetailLike,
} from "@/components/player/season-utils";
import { Topbar } from "@/components/shell/topbar";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import { getOffline, offlineDetail, playbackFor, queueWatched } from "@/lib/offline";
import { useTvBodyState } from "@/lib/tv";
import { cn } from "@/lib/utils";
import type { Job, SeasonRef, TitleDetail, WatchResolve } from "@/lib/types";

// What GET /titles/:id/play/:ep actually returns (ResolvedStream + the active
// job for this episode, downloader.ts:208 — lib/types' ResolvedStream omits it).
interface PlayResolve {
  source: string;
  url: string;
  subtitles?: Array<{ id?: string; label?: string; lang?: string; src?: string }>;
  downloading?: { id: string } | null;
  /** Set client-side when playing a saved offline copy. */
  offline?: boolean;
}

interface WatchDetail extends WatchDetailLike {
  description?: string;
  banner?: string;
  poster?: string;
  nextUp?: SeasonRef | null;
  duration?: number | null;
  episodeList: WatchEpisode[];
}

interface WatchState {
  watchId: string;
  titleId: number;
  detail: WatchDetail;
  /** Synthetic "offline:<id>" session (old playOffline). */
  offlineSession: boolean;
  ep: number | null;
}

interface CcTrackRef {
  lang: string;
  track: TextTrack;
}

function clearTracks(video: HTMLVideoElement): void {
  video.querySelectorAll("track").forEach((t) => t.remove());
}

export function WatchView() {
  const params = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, updateUser } = useAuth();

  const watchIdParam = params.get("id") || "";
  const epParam = Number(params.get("ep")) || null;

  // --- refs (imperative machinery, mirrors the old module-level state) ------
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ccBoxRef = useRef<HTMLDivElement | null>(null);
  const watchRef = useRef<WatchState | null>(null);
  const genRef = useRef(0); // out-of-order stream-resolve guard (old watch.gen)
  const prefetchRef = useRef<{ ep: number; p: Promise<PlayResolve | null> } | null>(null);
  const pollersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ccRef = useRef<{ tracks: CcTrackRef[]; active: number; handler: (() => void) | null }>({
    tracks: [],
    active: -1,
    handler: null,
  });
  const userRef = useRef(user);
  userRef.current = user;

  // --- render state ---------------------------------------------------------
  const [detail, setDetail] = useState<WatchDetail | null>(null);
  const [ep, setEp] = useState<number | null>(null);
  const [badge, setBadge] = useState<{ text: string; cls: "" | "local" | "rd" }>({
    text: "resolving…",
    cls: "",
  });
  const [note, setNote] = useState("");
  const [dlBtn, setDlBtn] = useState<{ label: string; disabled: boolean }>({
    label: "⬇ Download to library",
    disabled: false,
  });
  const [paused, setPaused] = useState(true);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [cc, setCc] = useState<CcState>({ tracks: [], active: -1 });
  const [ccMenuOpen, setCcMenuOpen] = useState(false);
  const [autoNext, setAutoNext] = useState<AutoNextInfo | null>(null);

  useTvBodyState({ watching: true });

  // --- controls auto-hide (old showControls, 3s) ----------------------------
  const showControls = useCallback(() => {
    setControlsHidden(false);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused) setControlsHidden(true);
    }, 3000);
  }, []);

  // --- captions: OUR-OWN cue rendering (old renderCues/applyCaption) --------
  const renderCues = useCallback((track: TextTrack) => {
    const box = ccBoxRef.current;
    if (!box) return;
    box.innerHTML = "";
    const cues = track.activeCues;
    if (!cues) return;
    for (let i = 0; i < cues.length; i++) {
      const line = document.createElement("div");
      line.className = "cc-line";
      const cue = cues[i] as VTTCue;
      try {
        line.appendChild(cue.getCueAsHTML());
      } catch {
        line.textContent = cue.text || "";
      }
      box.appendChild(line);
    }
  }, []);

  const applyCaption = useCallback(
    (idx: number) => {
      const st = ccRef.current;
      if (st.active >= 0 && st.tracks[st.active] && st.handler) {
        st.tracks[st.active]!.track.removeEventListener("cuechange", st.handler);
      }
      st.active = idx;
      if (ccBoxRef.current) ccBoxRef.current.innerHTML = "";
      setCc({ tracks: st.tracks.map((t) => ({ lang: t.lang })), active: idx });
      if (idx < 0 || !st.tracks[idx]) return;
      const track = st.tracks[idx]!.track;
      track.mode = "hidden"; // parse cues but let us render them
      const handler = () => renderCues(track);
      st.handler = handler;
      track.addEventListener("cuechange", handler);
      renderCues(track);
    },
    [renderCues],
  );

  const saveCcLang = useCallback(
    (lang: string) => {
      updateUser({ ccLang: lang });
      api("/account/add-defaults", {
        method: "POST",
        body: JSON.stringify({ ccLang: lang }),
      }).catch(() => {});
    },
    [updateUser],
  );

  const setupCaptions = useCallback(
    (video: HTMLVideoElement) => {
      const st = ccRef.current;
      if (st.active >= 0 && st.tracks[st.active] && st.handler) {
        st.tracks[st.active]!.track.removeEventListener("cuechange", st.handler);
      }
      st.tracks = [];
      st.active = -1;
      const tt = video.textTracks;
      for (let i = 0; i < tt.length; i++) {
        tt[i]!.mode = "hidden";
        const lang = (tt[i]!.language || "en").toLowerCase();
        // One entry per language — drop duplicates (a signs track that slipped
        // through, or the same language from two sources) so the menu stays clean.
        if (st.tracks.some((c) => normCc(c.lang) === normCc(lang))) continue;
        st.tracks.push({ lang, track: tt[i]! });
      }
      const prefRaw = userRef.current?.ccLang || "en";
      const pref = normCc(prefRaw);
      let idx = -1;
      if (prefRaw !== "off" && st.tracks.length) {
        idx = st.tracks.findIndex((t) => normCc(t.lang) === pref); // exact preferred language
        if (idx < 0) idx = st.tracks.findIndex((t) => normCc(t.lang) === "en"); // else English
        if (idx < 0) idx = 0; // else first available
      }
      applyCaption(idx);
    },
    [applyCaption],
  );

  // --- job polling for "Saved to library ✓" (old watchJob) ------------------
  const stopPoller = useCallback((iv: ReturnType<typeof setInterval>) => {
    clearInterval(iv);
    pollersRef.current.delete(iv);
  }, []);

  const watchJob = useCallback(
    (jobId: string) => {
      const jobTitleId = watchRef.current?.titleId;
      const iv = setInterval(async () => {
        try {
          const jobs = await api<Job[]>("/jobs");
          const j = jobs.find((x) => x.id === jobId);
          if (!j) return stopPoller(iv);
          if (j.status === "downloaded") {
            stopPoller(iv);
            if (watchRef.current) setNote("Saved to library ✓");
            toast("Download complete");
            void queryClient.invalidateQueries({ queryKey: ["jobs"] });
            // series page shows the new ✓ Saved on Back / live
            if (jobTitleId) void queryClient.invalidateQueries({ queryKey: ["title", jobTitleId] });
          } else if (j.status === "failed") {
            stopPoller(iv);
            setNote("Download failed: " + (j.message || ""));
          }
        } catch {
          stopPoller(iv);
        }
      }, 3000);
      pollersRef.current.add(iv);
    },
    [queryClient, stopPoller],
  );

  // --- prefetch the next episode's stream (old prefetchNext) ----------------
  const prefetchNext = useCallback((ep: number, max: number) => {
    prefetchRef.current = null;
    const w = watchRef.current;
    if (!w) return;
    const next = ep + 1;
    if (w.detail.type === "movie" || next > max) return;
    prefetchRef.current = {
      ep: next,
      p: api<PlayResolve>(`/titles/${w.titleId}/play/${next}`).catch(() => null),
    };
  }, []);

  // --- switch episode WITHOUT reloading (old goToEp) ------------------------
  const goToEp = useCallback(
    async (target: number) => {
      const w = watchRef.current;
      if (!w) return;
      const d = w.detail;
      const isMovie = d.type === "movie";
      const max = airedCount(d);
      const epN = Math.min(Math.max(1, target), Math.max(1, max));
      const meta = (d.episodeList || []).find((e) => e.number === epN) || { number: epN };
      if ((meta as WatchEpisode).aired === false) {
        toast("That episode hasn't aired yet");
        return;
      }
      w.ep = epN;
      const gen = ++genRef.current; // guard against out-of-order stream resolves
      setAutoNext(null);
      setEp(epN);
      window.history.replaceState(
        null,
        "",
        `/watch/?id=${encodeURIComponent(w.watchId)}&ep=${epN}`,
      ); // no reload / remount

      setBadge({ text: "resolving…", cls: "" });
      setNote("");
      setCcMenuOpen(false);
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      clearTracks(video);
      video.removeAttribute("src");

      try {
        // No network: play the saved offline copy if we have one, else say so.
        const off = getOffline(w.titleId, epN);
        let r: PlayResolve;
        if (typeof navigator !== "undefined" && !navigator.onLine) {
          if (!off) {
            setBadge({ text: "offline", cls: "" });
            setNote("Not saved for offline — download it while you have a connection.");
            return;
          }
          const pb = await playbackFor(off);
          r = { source: "local", url: pb.url, subtitles: pb.subtitles, offline: true };
        } else {
          const pf = prefetchRef.current;
          r =
            (pf && pf.ep === epN && (await pf.p)) ||
            (await api<PlayResolve>(`/titles/${w.titleId}/play/${epN}`));
        }
        if (!watchRef.current || genRef.current !== gen) return; // superseded — don't clobber
        setBadge({
          text: r.offline
            ? "● Offline copy"
            : r.source === "local"
              ? "● Local file"
              : r.source === "alldebrid"
                ? "● AllDebrid"
                : "● Real-Debrid",
          cls: r.source === "local" ? "local" : "rd",
        });
        video.src = r.url;
        (r.subtitles || []).forEach((s) => {
          const track = document.createElement("track");
          track.kind = "subtitles";
          track.label = s.label || s.lang || "Sub";
          track.srclang = s.lang || "en";
          track.src = s.src || `/api/captions/${s.id}.vtt`; // s.src set for offline (disk/cache)
          video.append(track);
        });
        video.load();
        video.play().catch(() => {});
        setupCaptions(video); // custom caption rendering + language menu + preferred language
        showControls();
        setDlBtn({
          label: r.source === "local" ? "✓ In library" : "⬇ Download to library",
          disabled: r.source === "local",
        });
        if (r.downloading) watchJob(r.downloading.id);
        prefetchNext(epN, max);
      } catch (e) {
        if (!watchRef.current || genRef.current !== gen) return;
        setBadge({ text: "failed", cls: "" });
        setNote((e as Error).message || String(e));
      }
    },
    [prefetchNext, setupCaptions, showControls, watchJob],
  );

  // --- enter/leave the watch session (old enterWatch/exitWatch) -------------
  useEffect(() => {
    if (!watchIdParam) return;
    // Same series -> just switch episode (old enterWatch fast path).
    const cur = watchRef.current;
    if (cur && cur.watchId === watchIdParam) {
      if (epParam && epParam !== cur.ep) void goToEp(epParam);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        let state: WatchState;
        if (watchIdParam.startsWith("offline:")) {
          // Offline session: no server round-trips (old playOffline).
          const titleId = Number(watchIdParam.slice("offline:".length));
          const d = offlineDetail(titleId) as unknown as WatchDetail;
          state = { watchId: watchIdParam, titleId, detail: d, offlineSession: true, ep: null };
          if (cancelled) return;
          watchRef.current = state;
          setDetail(d);
          void goToEp(epParam || 1);
        } else {
          const res = await api<WatchResolve>(`/watch/${encodeURIComponent(watchIdParam)}`);
          const d = (await api<TitleDetail>(`/titles/${res.titleId}`)) as unknown as WatchDetail;
          if (cancelled) return;
          state = {
            watchId: watchIdParam,
            titleId: res.titleId,
            detail: d,
            offlineSession: false,
            ep: null,
          };
          watchRef.current = state;
          setDetail(d);
          void goToEp(epParam || res.resumeEp || 1);
        }
      } catch (e) {
        if (cancelled) return;
        toast("Couldn't open player: " + ((e as Error).message || String(e)));
        router.push("/");
      }
    })();
    return () => {
      cancelled = true;
    };
    // epParam is intentionally read only on entry/URL change — goToEp
    // replaceStates the URL without re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchIdParam, epParam]);

  // Teardown on unmount (old exitWatch).
  useEffect(() => {
    const pollers = pollersRef.current;
    return () => {
      const st = ccRef.current;
      if (st.active >= 0 && st.tracks[st.active] && st.handler) {
        st.tracks[st.active]!.track.removeEventListener("cuechange", st.handler);
      }
      st.tracks = [];
      st.active = -1;
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        void document.exitFullscreen?.().catch(() => {});
      }
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      pollers.forEach((iv) => clearInterval(iv));
      pollers.clear();
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        clearTracks(video);
        video.load();
      }
      watchRef.current = null;
      void queryClient.invalidateQueries({ queryKey: ["library"] }); // refresh progress
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- video events: play/pause state + ended -> mark watched + auto-next ---
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => {
      setPaused(false);
      showControls();
    };
    const onPause = () => {
      setPaused(true);
      showControls();
    };
    const onEnded = async () => {
      const w = watchRef.current;
      if (!w || w.ep == null) return;
      const { titleId, ep: endedEp, detail: d } = w; // capture: watch may change during await
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        queueWatched(titleId, endedEp); // sync on reconnect
      } else {
        try {
          await api(`/titles/${titleId}/watched/${endedEp}`, { method: "POST" });
          void queryClient.invalidateQueries({ queryKey: ["updates"] });
          void queryClient.invalidateQueries({ queryKey: ["history"] });
          // series page reflects the new Watched state on Back / live
          void queryClient.invalidateQueries({ queryKey: ["title", titleId] });
        } catch {
          /* trackers optional */
        }
      }
      const cur = watchRef.current;
      if (!cur || cur.titleId !== titleId || cur.ep !== endedEp) return; // exited or moved on
      const max = airedCount(d);
      if (d.type !== "movie" && endedEp < max) {
        const nextEp = endedEp + 1;
        const meta = (d.episodeList || []).find((e) => e.number === nextEp);
        setAutoNext({
          ep: nextEp,
          title: `E${nextEp}${meta?.epTitle ? ` · ${meta.epTitle}` : ""}`,
          thumb: meta?.thumbnail || d.banner || d.poster || "",
        });
      }
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, [queryClient, showControls]);

  // --- fullscreen the STAGE (keeps our controls + captions) -----------------
  const enterVideoFullscreen = useCallback(() => {
    const stage = stageRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    const v = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      (doc.exitFullscreen || doc.webkitExitFullscreen || (() => {})).call(document);
      return;
    }
    try {
      if (stage?.requestFullscreen) stage.requestFullscreen().catch(() => {});
      else if (stage?.webkitRequestFullscreen) stage.webkitRequestFullscreen();
      else if (v?.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS: video-only
    } catch {
      /* ignore */
    }
    try {
      const orient = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      if (orient?.lock) orient.lock("landscape").catch(() => {});
    } catch {
      /* unsupported */
    }
  }, []);

  // --- keyboard shortcuts (old initPlayer document keydown) -----------------
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!watchRef.current) return;
      if (document.querySelector(".modal:not(.hidden)")) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        toggle();
      } else if (e.key === "f") enterVideoFullscreen();
      else if (e.key === "ArrowRight") v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5);
      else if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - 5);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle, enterVideoFullscreen]);

  // --- actions --------------------------------------------------------------
  const goBack = useCallback(() => {
    const tid = watchRef.current?.titleId;
    if (window.history.length > 1) router.back();
    else router.push(tid ? `/title/?id=${tid}` : "/"); // deep-linked → series page
  }, [router]);

  const downloadToLibrary = useCallback(async () => {
    const w = watchRef.current;
    if (!w || w.ep == null) return;
    try {
      const job = await api<Job>(`/titles/${w.titleId}/download/${w.ep}`, { method: "POST" });
      setDlBtn((b) => ({ ...b, disabled: true }));
      setNote("Downloading in background — will switch to local when done.");
      watchJob(job.id);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      toast((e as Error).message);
    }
  }, [queryClient, watchJob]);

  // --- derived render bits --------------------------------------------------
  const d = detail;
  const isMovie = d?.type === "movie";
  const max = d ? airedCount(d) : 1;
  const meta = d?.episodeList?.find((e) => e.number === ep);
  const seasons = d ? orderedSeasons(d) : [];
  const fallbackThumb = d?.banner || d?.poster || "";
  const denied = !!user?.downloadsDenied;
  const title = !d
    ? ""
    : isMovie
      ? d.english || d.romaji || ""
      : `E${ep ?? ""}${meta?.epTitle ? ` · ${meta.epTitle}` : ""}`;
  const epNo = !d
    ? ""
    : isMovie
      ? "Movie"
      : seasonChip(
          {
            num: seasonNumber(d),
            part: d.seasonPart,
            kind: d.seasonKind,
            format: d.seasonFormat,
          },
          0,
          true,
        );

  return (
    <div className="flex min-h-dvh flex-col">
      <Topbar />
      <main className="w-full flex-1 overflow-x-hidden">
        <div id="view-watch" className="view active watch flex flex-col">
          {/* ------- stage ------- */}
          <div
            id="watchStage"
            ref={stageRef}
            className={cn(
              "watch-stage relative aspect-video max-h-[60dvh] w-full flex-none bg-black sm:max-h-[78dvh]",
              paused && "paused",
              controlsHidden && "hide-controls",
            )}
            onMouseMove={showControls}
            onTouchStart={showControls}
            onClick={(e) => {
              const t = e.target as HTMLElement;
              if (!t.closest("#ccMenu") && !t.closest("#pcCc")) setCcMenuOpen(false);
            }}
          >
            <button
              id="watchBack"
              type="button"
              className="watch-back absolute left-3.5 top-3.5 z-[3] rounded-full border border-border bg-black/60 px-3.5 py-2 text-sm text-white backdrop-blur-md hover:bg-black/85"
              onClick={goBack}
            >
              ‹ Back
            </button>
            <video
              id="watchVideo"
              ref={videoRef}
              autoPlay
              playsInline
              className="block h-full w-full bg-black object-contain"
              onClick={toggle}
            />
            <div id="ccBox" ref={ccBoxRef} className="cc-box" />
            <PlayerControls
              videoRef={videoRef}
              paused={paused}
              onToggle={toggle}
              cc={cc}
              ccMenuOpen={ccMenuOpen}
              onCcMenuToggle={() => setCcMenuOpen((o) => !o)}
              onCcSelect={(idx) => {
                applyCaption(idx);
                setCcMenuOpen(false);
                saveCcLang(idx < 0 ? "off" : ccRef.current.tracks[idx]?.lang || "en");
              }}
              onFullscreen={enterVideoFullscreen}
            />
            {autoNext && (
              <AutoNextCard
                info={autoNext}
                onPlay={() => {
                  const n = autoNext.ep;
                  setAutoNext(null);
                  void goToEp(n);
                }}
                onCancel={() => setAutoNext(null)}
              />
            )}
          </div>

          {/* ------- info below the stage ------- */}
          <div className="watch-info mx-auto w-full max-w-[1100px] px-4 pb-16 pt-5 sm:px-6">
            <div className="watch-head flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="watch-headmeta min-w-0">
                <a
                  id="watchSeriesLink"
                  href={d ? `/title/?id=${d.id}` : "#"}
                  className="watch-series-link text-sm font-semibold text-primary hover:underline"
                  title="Back to series"
                  onClick={(e) => {
                    e.preventDefault();
                    const tid = watchRef.current?.titleId;
                    if (!tid) return;
                    // Old app.js:1566-1573: pop back to the series page (no
                    // duplicate entry) only when it is the entry behind us,
                    // else navigate (grid/deep-link case with no series page
                    // in history).
                    if (cameFromTitle(tid) && window.history.length > 1) router.back();
                    else router.push(`/title/?id=${tid}`);
                  }}
                >
                  {d ? d.english || d.romaji : ""}
                </a>
                <h1 className="watch-title m-0 truncate text-2xl font-semibold">{title}</h1>
                <div className="watch-epno mb-1 text-[13px] text-muted-foreground">{epNo}</div>
              </div>
              <span
                id="watchSource"
                className={cn(
                  "source-badge shrink-0 self-start rounded-full border px-2.5 py-1 text-[11px]",
                  badge.cls === "local" && "local border-emerald-400 bg-emerald-400/10 text-emerald-400",
                  badge.cls === "rd" && "rd border-sky-400 bg-sky-400/10 text-sky-400",
                  badge.cls === "" && "border-border text-muted-foreground",
                )}
              >
                {badge.text}
              </span>
            </div>

            <div className="watch-nav my-3.5 flex flex-wrap items-center gap-2.5">
              {!isMovie && (
                <>
                  <button
                    id="watchPrev"
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    disabled={(ep ?? 1) <= 1}
                    onClick={() => {
                      if (watchRef.current?.ep) void goToEp(watchRef.current.ep - 1);
                    }}
                  >
                    ‹ Prev
                  </button>
                  <button
                    id="watchNext"
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    disabled={(ep ?? 1) >= max}
                    onClick={() => {
                      if (watchRef.current?.ep) void goToEp(watchRef.current.ep + 1);
                    }}
                  >
                    Next ›
                  </button>
                </>
              )}
              {seasons.length > 1 && (
                <select
                  id="watchSeason"
                  className="watch-season w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm sm:w-auto"
                  value={d?.id}
                  onChange={(e) => void startWatch(router, Number(e.target.value), 1)}
                  aria-label="Season"
                >
                  {seasons.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {seasonChip(s, i, true)}
                      {s.year ? ` · ${s.year}` : ""}
                    </option>
                  ))}
                </select>
              )}
              {!denied && (
                <button
                  id="watchDownload"
                  type="button"
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
                  disabled={dlBtn.disabled}
                  onClick={() => void downloadToLibrary()}
                >
                  {dlBtn.label}
                </button>
              )}
              {note && (
                <span id="watchNote" className="note text-[13px] text-muted-foreground">
                  {note}
                </span>
              )}
            </div>

            <p className="watch-desc max-w-[760px] leading-relaxed text-muted-foreground">
              {d?.description || ""}
            </p>

            {/* Old renderWatchShell built #watchEpList for every title type —
                movies keep the pinned "Up next" chain row (S1 -> movie -> S2)
                and their own single E1 row when episodeList is non-empty. */}
            {d && (
              <EpisodeList
                episodes={d.episodeList || []}
                fallbackThumb={fallbackThumb}
                currentEp={ep}
                nextUp={d.nextUp || null}
                onSelect={(n) => void goToEp(n)}
                onPlayTitle={(id) => void startWatch(router, id, 1)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
