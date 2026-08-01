"use client";

// Season row — port of renderSeasons (public/app.js:930). Literal classes
// `seasons-row` / `season-card` are tvnav DOM contracts. Clicking a related
// entry REPLACES the history entry (old openDetail(id, true)) so the title
// stack stays flat and Back returns to the menu, not the previous season.

import { useRouter } from "next/navigation";
import React from "react";

import type { DetailModel } from "./detail-model";
import { orderedSeasons, seasonChip } from "./season-utils";

export function SeasonRow({ d }: { d: DetailModel }) {
  const router = useRouter();
  const seasons = orderedSeasons(d);
  if (seasons.length < 2) return null;
  return (
    <div className="seasons-row">
      {seasons.map((s, i) => (
        <div
          key={s.id}
          className={`season-card${s.current ? " current" : ""}`}
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
            {s.current ? " (this)" : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
