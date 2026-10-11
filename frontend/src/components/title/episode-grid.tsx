"use client";

// Episodes — Shiori's chapters-section header (RenzoFrontend components/comp/
// series/detail/chapters-section.tsx): "N episodes", the "N downloaded · N
// upcoming" summary and the action chips; then Renzo's own episode grid,
// kept at the owner's direction (2026-10-11, "keep renzo's original episode
// display") — the port of renderEpisodes (public/app.js:1082-1182).
//
// Literal classes `ep-card`, `ep-thumb-wrap`, `ep-title`, `ep-foot` are tvnav
// DOM contracts (activate() clicks .ep-thumb-wrap / .ep-title inside a focused
// .ep-card). Badges: Soon / Watched / ✓ Saved / download-state pct / runtime;
// live download progress overlaid from the jobs poll. Per-episode ⋮ menu:
// mark watched/unwatched, download / download-now (gated downloadsDenied),
// save-offline (NEVER on TV — offlineSupported is false there).

import { CloudDownload, Download, ListChecks, PlayCircle } from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

import type { DetailModel } from "./detail-model";

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
  onPlay: (ep: number) => void;
  onSetProgress: (ep: number) => void;
  onDownload: (ep: number, now?: boolean) => void;
  onToggleOffline: (ep: number, saved: boolean, label: string) => void;
  onSaveSeason: () => void;
  onDownloadSeason: () => void;
  /** The series' download settings, pushed right on the chip row. */
  settings?: React.ReactNode;
}

/** Shiori's RenzoChip — a pill with icon, label and "(count)". */
function Chip({
  icon: Icon,
  label,
  count,
  tone,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  tone?: "primary" | "emerald";
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
        tone === "primary" && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
        tone === "emerald" && "border-emerald-400/40 bg-emerald-400/10 text-emerald-400 hover:bg-emerald-400/15",
        !tone && active && "border-primary/40 bg-primary/15 text-primary",
        !tone && !active && "border-border/40 bg-foreground/[0.04] text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {count !== undefined && <span className="opacity-80">({count})</span>}
    </button>
  );
}

export function EpisodeGrid({
  d,
  offline,
  denied,
  offlineSupported,
  offlineHas,
  jobByEp,
  onPlay,
  onSetProgress,
  onDownload,
  onToggleOffline,
  onSaveSeason,
  onDownloadSeason,
  settings,
}: EpisodeGridProps) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  // Close the open kebab menu on any click outside an .ep-foot (old
  // app.js:1182), and on Escape before the page's own Back handler sees it.
  useEffect(() => {
    if (openMenu === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".ep-foot")) setOpenMenu(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpenMenu(null);
      }
    };
    document.addEventListener("click", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [openMenu]);

  if (d.type === "movie") {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <div className="ep-card flex items-center gap-3" onClick={() => onPlay(1)}>
          <PlayCircle className="h-5 w-5 text-primary" />
          <span className="ep-title flex-1 text-sm font-medium">Stream the movie</span>
        </div>
      </div>
    );
  }

  const total = d.episodeList.length;
  const airedCount = d.episodeList.filter((e) => e.aired !== false).length;
  const onServer = d.episodeList.filter((e) => e.hasFile).length;
  const upcoming = total - airedCount;
  const seasonWatched = airedCount > 0 && (d.watchedThrough || 0) >= airedCount;
  const series = d.english || d.romaji || "";
  const fallback = d.banner || d.poster || "";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center px-1 py-3">
        <h2 className="flex-1 text-base font-semibold text-foreground">
          {total} episode{total === 1 ? "" : "s"}
        </h2>
        <span className="text-xs text-muted-foreground">
          {onServer} downloaded
          {upcoming > 0 && (
            <>
              {" · "}
              <span className="font-medium text-amber-500">{upcoming} upcoming</span>
            </>
          )}
        </span>
      </div>
      <div className="h-px bg-border/60" />

      {/* Action chips */}
      <div className="flex flex-wrap items-center gap-2 py-2.5">
        {!offline && !denied && onServer < airedCount && (
          <Chip icon={Download} label="Download season" count={airedCount - onServer} tone="primary" onClick={onDownloadSeason} />
        )}
        {offlineSupported && !offline && onServer > 0 && (
          <Chip icon={CloudDownload} label="Save season offline" count={onServer} tone="emerald" onClick={onSaveSeason} />
        )}
        {airedCount > 0 && (
          <Chip
            icon={ListChecks}
            label={seasonWatched ? "Season watched" : "Mark season watched"}
            active={seasonWatched}
            onClick={() => onSetProgress(seasonWatched ? 0 : airedCount)}
          />
        )}
        {settings && <div className="ml-auto">{settings}</div>}
      </div>

      {/* Renzo's episode grid */}
      <div className="ep-grid mt-3">
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
          const openEp = () => (unaired ? toast(`Episode ${ep.number} hasn't aired yet`) : onPlay(ep.number));
          const menuOpen = openMenu === ep.number;

          return (
            <div key={ep.number} className={cn("ep-card", unaired && "unaired", watched && "watched")}>
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
                {badge && <span className={cn("ep-badge", watched ? "done" : ep.hasFile && "saved")}>{badge}</span>}
                {saved && <span className="ep-off">⤓ Offline</span>}
                {pct > 0 && pct < 100 && <div className="ep-prog" style={{ width: `${pct}%` }} />}
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
