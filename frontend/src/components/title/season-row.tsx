"use client";

// Seasons — Renzo's horizontal poster strip (port of renderSeasons,
// public/app.js:930), Crunchyroll-style, brought back over the Shiori rail
// list at the owner's direction (2026-10-11). Sits above the episodes under a
// Shiori-style "Seasons  N" heading; this title is outlined in the accent and
// the next season is marked "Up next". Hub twin: TitleScreen.kt SeasonBar.
//
// tvnav contract: `seasons-row` / `season-card` are literal DOM classes.
// Clicking another entry REPLACES the history entry (old openDetail(id, true))
// so the title stack stays flat and Back returns to the menu, not the
// previous season.

import { useRouter } from "next/navigation";
import React from "react";

import { cn } from "@/lib/utils";

import type { DetailModel } from "./detail-model";
import { orderedSeasons, seasonChip } from "./season-utils";

export function SeasonRow({ d }: { d: DetailModel }) {
  const router = useRouter();
  const seasons = orderedSeasons(d);
  if (seasons.length < 2) return null;
  return (
    <section className="mb-2 space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">Seasons</h2>
        <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {seasons.length}
        </span>
      </div>
      <div className="seasons-row">
        {seasons.map((s, i) => (
          <div
            key={s.id}
            className={cn("season-card", s.current && "current")}
            role={s.current ? undefined : "button"}
            onClick={() => {
              if (!s.current) router.replace(`/title/?id=${s.id}`); // flat stack → Back = menu
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              loading="lazy"
              src={s.poster || ""}
              alt=""
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = ".15";
              }}
            />
            <div className="lbl">
              {seasonChip(s, i)}
              {s.year ? ` · ${s.year}` : ""}
              {s.current ? " (this)" : d.nextUpId === s.id ? " · Up next" : ""}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
