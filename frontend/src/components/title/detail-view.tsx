"use client";

// Title page orchestrator — port of enterDetail/renderDetail/paintDetail plus
// the page-level plumbing around them (public/app.js:780-930):
//   * fetch GET /titles/:id (react-query key ["title", id] — the player and
//     downloads agents invalidate this key to live-refresh the page)
//   * cache the payload for offline (Offline.setMeta) and fall back to the
//     cached offline detail when the server is unreachable
//   * poll active jobs while visible (old watchJob) to live-update episode
//     badges/progress and refetch the detail when a download lands
//   * Escape cascade: lightbox → open episode menu → Back (tvnav's Back
//     dispatches Escape while body.detailing — useTvBodyState keeps that set)

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { markWatchFromTitle } from "@/components/player/play";
import { useJobsQuery } from "@/components/shell/queries";
import { useAuth } from "@/contexts/auth-context";
import { api, ApiError, emitAppEvent, OPEN_DOWNLOADS_EVENT } from "@/lib/api";
import { useOffline } from "@/lib/offline-react";
import { useTvBodyState } from "@/lib/tv";
import type { ProgressResult, TitleDetail, WatchStart } from "@/lib/types";

import { modelFromOffline, modelFromOnline } from "./detail-model";
import { EpisodeGrid, type EpJobOverlay } from "./episode-grid";
import { TitleHero } from "./hero";
import { SeasonRow } from "./season-row";

export function TitleDetailView({ id }: { id: number }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, loading: authLoading, gate } = useAuth();
  const offline = useOffline();
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<number | null>(null);

  // tvnav contract: Back → Escape cascade while the title page is open.
  useTvBodyState({ detailing: true });

  const online = !offline.ready || offline.online;
  const detailQuery = useQuery({
    queryKey: ["title", id],
    queryFn: () => api<TitleDetail>(`/titles/${id}`),
    enabled: !!id && !!user && online,
    retry: false,
  });

  // Offline page: the device is offline, our own fetch failed at network level,
  // or boot found the server unreachable (auth "offline" gate → Downloads gate
  // opened this page). Rendered from cached metadata, exactly like the old
  // openOfflineDetail. Never on TV (offline features are off there).
  const networkFail = detailQuery.error instanceof ApiError && detailQuery.error.network;
  const offlineMode =
    offline.ready &&
    !offline.tv &&
    !detailQuery.data &&
    (!online || networkFail || gate.kind === "offline");

  // Cache banner/info/episodes so offline looks identical (old Offline.setMeta).
  useEffect(() => {
    if (detailQuery.data) offline.setMeta(detailQuery.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQuery.data]);

  // Reset transient UI + scroll to top when switching titles (old enterDetail).
  useEffect(() => {
    setLightbox(null);
    setOpenMenu(null);
    window.scrollTo(0, 0);
  }, [id]);

  const d = useMemo(() => {
    if (detailQuery.data) return modelFromOnline(detailQuery.data);
    if (offlineMode) return modelFromOffline(offline.detail(id));
    return null;
    // offline.detail re-reads localStorage; the offline hook re-renders us on
    // any manifest/meta change, so this stays fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailQuery.data, offlineMode, id, offline]);

  // --- jobs poll (old watchJob): overlay live download state on the episode
  // grid and refetch the detail when a job for this title completes/fails.
  const { data: jobs } = useJobsQuery();
  const jobByEp = useMemo(() => {
    const m = new Map<number, EpJobOverlay>();
    for (const j of jobs || []) {
      if (j.titleId !== id) continue;
      if (["queued", "searching", "downloading"].includes(j.status)) {
        m.set(j.episode, { status: j.status, progress: j.progress });
      }
    }
    return m;
  }, [jobs, id]);
  const prevJobs = useRef<Map<string, { titleId: number; status: string }>>(new Map());
  useEffect(() => {
    if (!jobs) return;
    const prev = prevJobs.current;
    const next = new Map(jobs.map((j) => [j.id, { titleId: j.titleId, status: j.status }]));
    let refresh = false;
    next.forEach((v, k) => {
      const p = prev.get(k);
      if (v.titleId === id && p && p.status !== v.status && v.status === "downloaded") {
        refresh = true;
        toast("Download complete");
      }
    });
    // A busy job for this title vanished from the list — it finished and was
    // pruned between polls; refresh so ✓ Saved appears.
    prev.forEach((v, k) => {
      if (v.titleId === id && !next.has(k) && v.status !== "failed") refresh = true;
    });
    prevJobs.current = next;
    if (refresh) void qc.invalidateQueries({ queryKey: ["title", id] });
  }, [jobs, id, qc]);

  // --- navigation --------------------------------------------------------
  const goBack = useCallback(() => {
    // The offline page was opened from the Downloads gate — reopen it (old
    // detailBack's offlineDetailOpen branch).
    if (offlineMode) emitAppEvent(OPEN_DOWNLOADS_EVENT);
    if (window.history.length > 1) router.back();
    else router.push("/");
  }, [offlineMode, router]);

  // Escape cascade: lightbox → episode menu → back (old app.js:1913).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (lightbox) return setLightbox(null);
      if (openMenu !== null) return setOpenMenu(null);
      if (document.querySelector(".modal:not(.hidden), .auth-gate:not(.hidden)")) return;
      goBack();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox, openMenu, goBack]);

  // --- actions ------------------------------------------------------------
  const play = useCallback(
    async (ep: number) => {
      // Offline: no server to mint a watch link — the player plays the saved
      // copy directly from the offline watch id (old playOffline scheme).
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        markWatchFromTitle(id); // player's series link pops back here
        router.push(`/watch/?id=${encodeURIComponent(`offline:${id}`)}&ep=${ep}`);
        return;
      }
      try {
        const r = await api<WatchStart>(`/titles/${id}/watch`, { method: "POST" });
        markWatchFromTitle(id); // player's series link pops back here
        router.push(`/watch/?id=${encodeURIComponent(r.watchId)}&ep=${ep}`);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [id, router],
  );

  // Set the exact watched-through episode (mark / un-watch / mark season).
  const setProgress = useCallback(
    async (ep: number) => {
      if (typeof navigator !== "undefined" && !navigator.onLine && ep > 0) {
        offline.queueWatched(id, ep); // sync on reconnect
        toast(`Watched through E${ep} — will sync when back online`);
        return;
      }
      try {
        const r = await api<ProgressResult>(`/titles/${id}/progress`, {
          method: "POST",
          body: JSON.stringify({ ep }),
        });
        qc.setQueryData<TitleDetail>(["title", id], (old) =>
          old ? { ...old, watchedThrough: r.watchedThrough } : old,
        );
        void qc.invalidateQueries({ queryKey: ["title", id, "tracking"] });
        toast(r.watchedThrough > 0 ? `Watched through E${r.watchedThrough}` : "Marked unwatched");
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [id, qc, offline],
  );

  const downloadEp = useCallback(
    async (ep: number, now?: boolean) => {
      try {
        const job = await api<{ id?: string }>(`/titles/${id}/download/${ep}`, {
          method: "POST",
        });
        if (now && job?.id) {
          try {
            await api(`/jobs/${job.id}/prioritize`, { method: "POST" });
          } catch {
            /* still queued */
          }
        }
        toast(now ? `Downloading E${ep} now…` : `Downloading E${ep}…`);
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [id, qc],
  );

  // Save/remove an episode for offline viewing (auto-purged on reconnect).
  const toggleOffline = useCallback(
    async (ep: number, saved: boolean, label: string) => {
      try {
        if (saved) {
          await offline.remove(id, ep);
          toast("Removed offline copy");
        } else {
          if (!(await offline.ensureDownloadFolder())) {
            toast("Pick a download folder to save offline");
            return;
          }
          toast("Saving for offline…");
          await offline.saveEpisode(id, ep, label);
          toast("Saved — available offline until you reconnect");
        }
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [id, offline],
  );

  // Batch: save every downloaded, not-yet-saved episode of the season.
  const saveSeasonOffline = useCallback(async () => {
    if (!d) return;
    const eps = d.episodeList.filter((e) => e.aired !== false);
    const todo = eps.filter((e) => e.hasFile && !offline.has(d.id, e.number));
    const notLib = eps.filter((e) => !e.hasFile).length;
    if (!todo.length) {
      toast(
        notLib
          ? "Download these episodes to your library first"
          : "Season already saved offline",
      );
      return;
    }
    if (!(await offline.ensureDownloadFolder())) {
      toast("Pick a download folder to save offline");
      return;
    }
    toast(`Saving ${todo.length} episode${todo.length === 1 ? "" : "s"} offline…`);
    let ok = 0;
    for (const e of todo) {
      try {
        await offline.saveEpisode(d.id, e.number, `${d.english || d.romaji} · E${e.number}`);
        ok++;
      } catch {
        /* skip a failed episode, keep going */
      }
    }
    toast(`Saved ${ok} offline${notLib ? ` · ${notLib} not in library yet` : ""}`);
  }, [d, offline]);

  // --- render -------------------------------------------------------------
  if (!id) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        No title selected.
      </div>
    );
  }
  if (!d) {
    if (!authLoading && detailQuery.isError && !networkFail) {
      return (
        <div className="py-16 text-center">
          <p className="text-sm text-muted-foreground">
            Detail failed: {(detailQuery.error as Error).message}
          </p>
          <button type="button" className="tp-ghost mt-4" onClick={goBack}>
            ‹ Back
          </button>
        </div>
      );
    }
    return (
      <div className="title-hero-skel">
        <div className="skeleton-shimmer h-[320px] w-full rounded-xl" />
      </div>
    );
  }

  const denied = !!user?.downloadsDenied;

  return (
    <div className="title-page">
      <button type="button" className="page-back" onClick={goBack}>
        ‹ Back
      </button>
      <TitleHero
        d={d}
        offline={offlineMode}
        denied={denied}
        onPlay={(ep) => void play(ep)}
        onOpenLightbox={(src) => src && setLightbox(src)}
      />
      <div className="title-body">
        <div className="detail-episodes">
          <SeasonRow d={d} />
          <EpisodeGrid
            d={d}
            offline={offlineMode}
            denied={denied}
            offlineSupported={offline.ready && offline.supported}
            offlineHas={offline.has}
            jobByEp={jobByEp}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
            onPlay={(ep) => void play(ep)}
            onSetProgress={(ep) => void setProgress(ep)}
            onDownload={(ep, now) => void downloadEp(ep, now)}
            onToggleOffline={(ep, saved, label) => void toggleOffline(ep, saved, label)}
            onSaveSeason={() => void saveSeasonOffline()}
          />
        </div>
      </div>

      {/* Cover lightbox — click the poster to expand it (old #imgLightbox). */}
      {lightbox && (
        <div
          id="imgLightbox"
          className="img-lightbox"
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest(".img-lightbox-img")) setLightbox(null);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="img-lightbox-img" src={lightbox} alt="" />
          <button
            type="button"
            className="img-lightbox-close"
            aria-label="Close"
            onClick={() => setLightbox(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
