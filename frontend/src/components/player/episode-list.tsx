"use client";

// Watch-page episode rows — old renderWatchShell's #watchEpList (app.js:1395).
// Row class `wep` is a tvnav DOM contract (D-pad focusable). The pinned
// "Up next" row spans the series chain (S1 -> continuation movie -> S2) and
// sits above the episodes, exactly like the old `.wep.upnext` row.

import React, { useEffect, useRef } from "react";
import { toast } from "sonner";

import { seasonChip } from "@/components/player/season-utils";
import { cn } from "@/lib/utils";
import type { SeasonRef } from "@/lib/types";

export interface WatchEpisode {
  number: number;
  epTitle?: string | null;
  thumbnail?: string | null;
  aired?: boolean;
  hasFile?: boolean;
}

export function EpisodeList({
  episodes,
  fallbackThumb,
  currentEp,
  nextUp,
  onSelect,
  onPlayTitle,
}: {
  episodes: WatchEpisode[];
  fallbackThumb: string;
  currentEp: number | null;
  /** Cross-chain "Up next" entry (detail.nextUp) — pinned above the episodes. */
  nextUp?: SeasonRef | null;
  onSelect: (ep: number) => void;
  /** Play another title in the chain (the up-next row). */
  onPlayTitle: (id: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the playing row in view (old highlightEp's scrollIntoView).
  useEffect(() => {
    if (currentEp == null) return;
    const cur = listRef.current?.querySelector<HTMLElement>(`.wep[data-ep="${currentEp}"]`);
    cur?.scrollIntoView({ block: "nearest" });
  }, [currentEp]);

  const thumbCls =
    "wep-thumb h-[54px] w-24 flex-none rounded-lg bg-muted object-cover sm:h-[72px] sm:w-32";

  return (
    <div id="watchEpList" ref={listRef} className="watch-eplist mt-6 flex flex-col gap-2">
      {nextUp ? (
        <div
          className="wep upnext flex cursor-pointer items-center gap-3 rounded-[10px] border border-primary/70 bg-primary/5 p-2 hover:bg-primary/10"
          role="button"
          tabIndex={0}
          onClick={() => onPlayTitle(nextUp.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onPlayTitle(nextUp.id);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={thumbCls}
            loading="lazy"
            src={nextUp.poster || fallbackThumb}
            onError={(e) => {
              (e.target as HTMLImageElement).src = fallbackThumb;
            }}
            alt=""
          />
          <div className="wep-main min-w-0 flex-1">
            <div className="wep-no truncate font-semibold text-primary">
              Up next · {seasonChip(nextUp, 0, true)}
              {nextUp.year ? ` · ${nextUp.year}` : ""}
            </div>
            <div className="wep-next-title truncate text-[13px] text-muted-foreground">
              {nextUp.title}
            </div>
          </div>
          <span className="ep-st shrink-0 text-sm text-muted-foreground">▶</span>
        </div>
      ) : null}

      {episodes.map((ep) => {
        const unaired = ep.aired === false;
        const playing = currentEp === ep.number;
        return (
          <div
            key={ep.number}
            data-ep={ep.number}
            className={cn(
              "wep flex items-center gap-3 rounded-[10px] border border-transparent p-2",
              unaired ? "unaired cursor-default opacity-55" : "cursor-pointer hover:bg-accent/50",
              playing && "playing border-primary bg-primary/10",
            )}
            role="button"
            tabIndex={0}
            onClick={() =>
              unaired ? toast(`Episode ${ep.number} hasn't aired yet`) : onSelect(ep.number)
            }
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (unaired) toast(`Episode ${ep.number} hasn't aired yet`);
              else onSelect(ep.number);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={thumbCls}
              loading="lazy"
              src={ep.thumbnail || fallbackThumb}
              onError={(e) => {
                (e.target as HTMLImageElement).src = fallbackThumb;
              }}
              alt=""
            />
            <div className="wep-main min-w-0 flex-1">
              <div className="wep-no truncate font-semibold">
                E{ep.number}
                {ep.epTitle ? ` · ${ep.epTitle}` : ""}
              </div>
            </div>
            {ep.hasFile ? (
              <span className="ep-st local shrink-0 text-sm font-semibold text-emerald-400">✓</span>
            ) : unaired ? (
              <span className="ep-st shrink-0 text-xs text-muted-foreground">Soon</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
