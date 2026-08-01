"use client";

// Episode grid — port of renderEpisodes (public/app.js:1082-1182). Literal
// classes `ep-card`, `ep-thumb-wrap`, `ep-title`, `ep-foot` are tvnav DOM
// contracts (activate() clicks .ep-thumb-wrap / .ep-title inside a focused
// .ep-card). Badges: Soon / Watched / ✓ Saved / download-state pct / runtime;
// live download progress overlaid from the jobs poll. Per-episode ⋮ menu:
// mark watched/unwatched, download / download-now (gated downloadsDenied),
// save-offline (NEVER on TV — offlineSupported is false there).

import React, { useEffect } from "react";
import { toast } from "sonner";

import type { DetailModel } from "./detail-model";
import { seasonNumber } from "./season-utils";

export interface EpJobOverlay {
  status: string;
  progress: number;
}

interface EpisodeGridProps {
  d: DetailModel;
  offline: boolean;
  denied: boolean;
  offlineSupported: boolean;
  offlineHas: (id: number, ep: number) => boolean;
  jobByEp: Map<number, EpJobOverlay>;
  openMenu: number | null;
  setOpenMenu: (ep: number | null) => void;
  onPlay: (ep: number) => void;
  onSetProgress: (ep: number) => void;
  onDownload: (ep: number, now?: boolean) => void;
  onToggleOffline: (ep: number, saved: boolean, label: string) => void;
  onSaveSeason: () => void;
}

export function EpisodeGrid({
  d,
  offline,
  denied,
  offlineSupported,
  offlineHas,
  jobByEp,
  openMenu,
  setOpenMenu,
  onPlay,
  onSetProgress,
  onDownload,
  onToggleOffline,
  onSaveSeason,
}: EpisodeGridProps) {
  // Close the open kebab menu on any click outside an .ep-foot (old app.js:1182).
  useEffect(() => {
    if (openMenu === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ep-foot")) setOpenMenu(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openMenu, setOpenMenu]);

  if (d.type === "movie") {
    return (
      <div className="mt-2">
        <button type="button" className="tp-primary movie-play" onClick={() => onPlay(1)}>
          ▶ Stream
        </button>
      </div>
    );
  }

  const aired = d.episodeList.filter((e) => e.aired !== false).length;
  const sn = seasonNumber(d);
  const seasonWatched = aired > 0 && (d.watchedThrough || 0) >= aired;
  const fallback = d.banner || d.poster || "";
  const series = d.english || d.romaji || "";

  return (
    <div>
      <div className="season-header">
        <span>
          Season {sn} <span className="cnt">{aired} of {d.episodeList.length} available</span>
        </span>
        <span className="season-header-actions">
          <button
            type="button"
            className={`tp-ghost mark-all${seasonWatched ? " on" : ""}`}
            onClick={() => onSetProgress(seasonWatched ? 0 : aired)}
          >
            {seasonWatched ? "✓ Season watched" : "Mark season watched"}
          </button>
          {offlineSupported && !offline && (
            <button type="button" className="tp-ghost" onClick={onSaveSeason}>
              ⤓ Save season offline
            </button>
          )}
        </span>
      </div>

      <div className="ep-grid">
        {d.episodeList.map((ep) => {
          const unaired = ep.aired === false;
          const job = jobByEp.get(ep.number);
          const status = job ? job.status : ep.status;
          const progress = job ? job.progress : ep.progress;
          const busy = ["downloading", "queued", "searching"].includes(status);
          const pct = Math.round((progress || 0) * 100);
          const watched = !unaired && ep.number <= (d.watchedThrough || 0);
          // Bottom-right badge: watched → Watched, else download state, else runtime.
          let badge = "";
          if (unaired) badge = "Soon";
          else if (watched) badge = "Watched";
          else if (ep.hasFile) badge = "✓ Saved";
          else if (busy) badge = `${status}${pct ? " " + pct + "%" : ""}`;
          else if (d.duration) badge = `${d.duration}m`;
          const saved = offlineHas(d.id, ep.number);
          const label = `${series} · E${ep.number}`;
          const openEp = () =>
            unaired ? toast(`Episode ${ep.number} hasn't aired yet`) : onPlay(ep.number);
          const menuOpen = openMenu === ep.number;

          return (
            <div
              key={ep.number}
              className={`ep-card${unaired ? " unaired" : ""}${watched ? " watched" : ""}`}
            >
              <div className="ep-thumb-wrap" onClick={openEp}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="ep-thumb"
                  loading="lazy"
                  src={ep.thumbnail || fallback}
                  alt=""
                  onError={(e) => {
                    const img = e.currentTarget as HTMLImageElement;
                    if (fallback && !img.src.endsWith(fallback)) img.src = fallback;
                  }}
                />
                {!unaired && <div className="ep-ov">{watched ? "↻" : "▶"}</div>}
                {badge && (
                  <span className={`ep-badge${watched ? " done" : ep.hasFile ? " saved" : ""}`}>
                    {badge}
                  </span>
                )}
                {saved && <span className="ep-off">⤓ Offline</span>}
                {pct > 0 && pct < 100 && (
                  <div className="ep-prog" style={{ width: `${pct}%` }} />
                )}
              </div>
              <div className="ep-series">{series}</div>
              <div className="ep-title" onClick={openEp}>
                E{ep.number} – {ep.epTitle || `Episode ${ep.number}`}
              </div>
              <div className="ep-foot">
                <span className="ep-sub">Subtitled</span>
                {!unaired && (
                  <button
                    type="button"
                    className="ep-kebab"
                    title="Episode options"
                    onClick={() => setOpenMenu(menuOpen ? null : ep.number)}
                  >
                    ⋮
                  </button>
                )}
                {menuOpen && !unaired && (
                  <div className="ep-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onSetProgress(watched ? ep.number - 1 : ep.number);
                      }}
                    >
                      {watched ? "Mark unwatched" : "Mark watched"}
                    </button>
                    {!ep.hasFile && !denied && !offline && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenu(null);
                            onDownload(ep.number);
                          }}
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenu(null);
                            onDownload(ep.number, true);
                          }}
                        >
                          Download now
                        </button>
                      </>
                    )}
                    {/* Offline copy: once the episode is in the library. Never on TV. */}
                    {ep.hasFile && offlineSupported && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMenu(null);
                          onToggleOffline(ep.number, saved, label);
                        }}
                      >
                        {saved ? "Remove offline copy" : "Save offline"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
