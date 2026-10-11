"use client";

// Seasons — a section of the title page's left rail, in the form of Shiori's
// rail sections (sources-section.tsx): a titled list with a count pill, one
// card-tinted row per entry (poster, "Season 2 · 2026", title), the current
// entry highlighted and the next one marked "Up next".
//
// tvnav contract: each row is a literal `season-card`. Clicking another
// entry REPLACES the history entry (old openDetail(id, true)) so the title
// stack stays flat and Back returns to the menu, not the previous season.

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
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-foreground">Seasons</h2>
        <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {seasons.length}
        </span>
      </div>
      <div className="seasons-row grid grid-cols-1 gap-2">
        {seasons.map((s, i) => (
          <div
            key={s.id}
            role={s.current ? undefined : "button"}
            onClick={() => {
              if (!s.current) router.replace(`/title/?id=${s.id}`); // flat stack → Back = menu
            }}
            className={cn(
              "season-card flex items-center gap-3 rounded-lg border p-2 transition-colors",
              s.current
                ? "current border-primary/50 bg-primary/10"
                : "cursor-pointer border-border/40 bg-card/50 hover:bg-card",
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              loading="lazy"
              src={s.poster || ""}
              alt=""
              className="h-[54px] w-9 shrink-0 rounded-md bg-muted object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = ".15";
              }}
            />
            <div className="min-w-0 flex-1">
              <div className={cn("truncate text-sm font-medium", s.current ? "text-primary" : "text-foreground")}>
                {seasonChip(s, i, true)}
                {s.year ? ` · ${s.year}` : ""}
              </div>
              {s.title && <div className="truncate text-[11px] text-muted-foreground">{s.title}</div>}
            </div>
            {s.current ? (
              <span className="shrink-0 text-[11px] font-medium text-primary">Viewing</span>
            ) : d.nextUpId === s.id ? (
              <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Up next
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
