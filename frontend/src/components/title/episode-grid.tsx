"use client";

// Episodes — Shiori's chapters section (RenzoFrontend components/comp/series/
// detail/chapters-section.tsx + chapter-row.tsx): the "N episodes" header
// with its "N downloaded · N upcoming" summary, the action chips, then one
// bordered card-tinted row per episode — status icon, "E3  Title", the
// on-server / streams / not-aired line, and the row actions (save offline,
// watched toggle, download). Replaces the thumbnail grid (branch
// backup/pre-shiori-restyle).
//
// tvnav contract (CONTRACTS.md): each row is a literal `ep-card` and carries an
// `ep-title`, which activate() clicks to play.

import {
  CheckCircle2,
  ChevronDown,
  Circle,
  CloudDownload,
  Download,
  ListChecks,
  PlayCircle,
  Smartphone,
  Timer,
} from "lucide-react";
import React from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/** Shiori's 32px square icon action. */
function RowAction({
  icon: Icon,
  label,
  className,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
        className,
      )}
    >
      <Icon className="h-4 w-4" />
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
}: EpisodeGridProps) {
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
      <div className="flex flex-wrap gap-2 py-2.5">
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
      </div>

      {/* Rows */}
      <div className="space-y-2">
        {d.episodeList.map((ep) => {
          const unaired = ep.aired === false;
          const job = jobByEp.get(ep.number);
          const status = job ? job.status : ep.status;
          const progress = job ? job.progress : ep.progress;
          const busy = ["downloading", "queued", "searching"].includes(status);
          const pct = Math.round((progress || 0) * 100);
          const watched = !unaired && ep.number <= (d.watchedThrough || 0);
          const saved = offlineHas(d.id, ep.number);
          const label = `${series} · E${ep.number}`;
          const openEp = () => (unaired ? toast(`Episode ${ep.number} hasn't aired yet`) : onPlay(ep.number));
          const dur = d.duration ? ` · ${d.duration}m` : "";

          return (
            <div
              key={ep.number}
              onClick={openEp}
              className={cn(
                "ep-card group relative flex cursor-pointer flex-wrap items-center gap-2.5 overflow-hidden rounded-lg border border-border/40 bg-card/50 px-3 py-2.5 transition-colors hover:bg-card",
                unaired && "unaired cursor-default opacity-60",
                watched && "watched",
              )}
            >
              {ep.hasFile ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-label="Downloaded" />
              ) : unaired ? (
                <Timer className="h-4 w-4 shrink-0 text-amber-500" aria-label="Not yet aired" />
              ) : busy ? (
                <Download className="h-4 w-4 shrink-0 text-primary" aria-label="Downloading" />
              ) : (
                <PlayCircle className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Streams on demand" />
              )}

              <div className={cn("min-w-0 flex-1", watched && "opacity-50")}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="ep-title shrink-0 text-sm font-medium text-foreground">E{ep.number}</span>
                  {ep.epTitle && <span className="truncate text-sm text-muted-foreground">{ep.epTitle}</span>}
                  {busy && (
                    <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-[10px] font-medium text-primary">
                      {pct > 0 ? `${pct}%` : status}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {unaired ? (
                    <span className="font-medium text-amber-500">Not yet aired</span>
                  ) : ep.hasFile ? (
                    `On your server · Subtitled${dur}`
                  ) : busy ? (
                    `Downloading · ${status}`
                  ) : (
                    `Streams on demand · Subtitled${dur}`
                  )}
                  {watched && <span className="opacity-70"> · Watched</span>}
                  {saved && <span className="text-emerald-500"> · On this device</span>}
                </div>
              </div>

              {!unaired && (
                <div className="flex shrink-0 items-center gap-1">
                  {offlineSupported && !offline && (saved || ep.hasFile) && (
                    <RowAction
                      icon={saved ? Smartphone : CloudDownload}
                      label={saved ? "Saved on this device — remove" : "Save to this device"}
                      className={saved ? "text-emerald-500" : undefined}
                      onClick={() => onToggleOffline(ep.number, saved, label)}
                    />
                  )}
                  <RowAction
                    icon={watched ? CheckCircle2 : Circle}
                    label={watched ? "Mark unwatched" : "Mark watched"}
                    className={watched ? "text-emerald-500" : undefined}
                    onClick={() => onSetProgress(watched ? ep.number - 1 : ep.number)}
                  />
                  {!ep.hasFile && !denied && !offline && !busy && (
                    // Shiori's split download button: the main half queues it,
                    // the chevron offers "Download now" (front of the queue).
                    <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => onDownload(ep.number)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-l-md border border-border/60 bg-foreground/[0.03] px-2.5 text-xs font-medium text-foreground hover:bg-foreground/[0.06]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Download</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="More download options"
                            className="inline-flex h-8 items-center rounded-r-md border border-l-0 border-border/60 bg-foreground/[0.03] px-1.5 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => onDownload(ep.number, true)}>
                            Download now (front of the queue)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
              )}

              {busy && pct > 0 && pct < 100 && (
                <div className="absolute bottom-0 left-0 h-0.5 bg-primary" style={{ width: `${pct}%` }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
