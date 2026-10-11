"use client";

// Title hero — Shiori's series hero (RenzoFrontend components/comp/series/
// detail/series-hero.tsx), the owner's direction (2026-10-11) being that Renzo
// look exactly like Shiori: blurred-cover backdrop with the gradient and pink
// tint, the 210×315 cover (click → lightbox), status pill, title, romaji
// byline, inline meta row, genre pills, description with Read more, and the
// action toolbar. Renzo's actions fill the toolbar: Play/Continue, Watchlist,
// Favourite, Library, Track (dialog) and Auto-download. Server-only
// affordances are hidden on the offline page. The banner-style hero this
// replaces is on branch backup/pre-shiori-restyle.

import { useQueryClient } from "@tanstack/react-query";
import { Heart, LibraryBig, Play, RefreshCw, Rss, Star } from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { TitleDetail } from "@/lib/types";

import type { DetailModel } from "./detail-model";
import { TrackingRow } from "./tracking-row";

interface HeroProps {
  d: DetailModel;
  offline: boolean;
  denied: boolean;
  onPlay: (ep: number) => void;
  onOpenLightbox: (src: string) => void;
}

/** Shiori's status pill config, from AniList's airing status. */
const STATUS: Record<string, { label: string; cls: string; dot: string; pulse?: boolean }> = {
  RELEASING: { label: "Ongoing", cls: "bg-green-500/10 border-green-500/25 text-green-400", dot: "bg-green-500", pulse: true },
  FINISHED: { label: "Completed", cls: "bg-blue-500/10 border-blue-500/25 text-blue-400", dot: "bg-blue-500" },
  NOT_YET_RELEASED: { label: "Upcoming", cls: "bg-yellow-500/10 border-yellow-500/25 text-yellow-400", dot: "bg-yellow-500" },
  HIATUS: { label: "On Hiatus", cls: "bg-yellow-500/10 border-yellow-500/25 text-yellow-400", dot: "bg-yellow-500" },
  CANCELLED: { label: "Cancelled", cls: "bg-red-500/10 border-red-500/25 text-red-400", dot: "bg-red-500" },
};

export function TitleHero({ d, offline, denied, onPlay, onOpenLightbox }: HeroProps) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [trackOpen, setTrackOpen] = useState(false);

  // Description clamp resets when navigating between seasons.
  useEffect(() => setExpanded(false), [d.id]);

  const patch = (p: Partial<TitleDetail>) => {
    qc.setQueryData<TitleDetail>(["title", d.id], (old) => (old ? { ...old, ...p } : old));
  };

  const isSeries = d.type === "series";
  const title = d.english || d.romaji || "";
  // Play → the next episode after what you've watched, else the first aired.
  const aired = d.episodeList.filter((e) => e.aired !== false);
  const next = aired.find((e) => e.number > (d.watchedThrough || 0)) || aired[0] || { number: 1 };
  const continuing = isSeries && (d.watchedThrough || 0) > 0 && next.number > 1;

  const inW = d.lists.includes("watchlist");
  const inF = d.lists.includes("favorites");

  const toggleList = async (listName: string) => {
    const on = !d.lists.includes(listName);
    try {
      const r = await api<{ lists: string[]; inLibrary?: boolean }>(`/titles/${d.id}/lists`, {
        method: "POST",
        body: JSON.stringify({ list: listName, on }),
      });
      patch({ lists: r.lists, ...(r.inLibrary !== undefined ? { inLibrary: r.inLibrary } : {}) });
      void qc.invalidateQueries({ queryKey: ["library"] });
      toast(on ? `Added to ${listName}` : `Removed from ${listName}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleLibrary = async () => {
    try {
      if (d.inLibrary) {
        await api(`/library/${d.id}`, { method: "DELETE" });
        patch({ inLibrary: false });
        toast("Removed from your library");
      } else {
        await api(`/library`, { method: "POST", body: JSON.stringify({ anilistId: d.id }) });
        patch({ inLibrary: true });
        toast("Added to your library");
      }
      void qc.invalidateQueries({ queryKey: ["library"] });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleAuto = async () => {
    try {
      const r = await api<{ autoDownload: boolean }>(`/titles/${d.id}/auto`, {
        method: "POST",
        body: JSON.stringify({ enabled: !d.autoDownload }),
      });
      patch({ autoDownload: r.autoDownload });
      toast(r.autoDownload ? "Auto-download on — new episodes grab automatically" : "Auto-download off");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const status = d.airingStatus ? STATUS[d.airingStatus.toUpperCase()] : undefined;
  const seasonWord =
    d.seasonKind === "extra"
      ? ({ MOVIE: "Movie", OVA: "OVA" } as Record<string, string>)[(d.seasonFormat || "").toUpperCase()] || "Special"
      : `Season ${d.seasonNum || 1}${d.seasonPart && d.seasonPart > 1 ? ` Part ${d.seasonPart}` : ""}`;
  const meta = [
    d.type === "movie" ? "Movie" : seasonWord,
    d.year ? String(d.year) : null,
    d.episodesTotal ? `${d.episodesTotal} episode${d.episodesTotal === 1 ? "" : "s"}` : null,
    d.duration ? `${d.duration}m` : null,
  ].filter(Boolean) as string[];

  return (
    <section className="relative isolate overflow-hidden border-b border-border/60">
      {/* Blurred banner layer */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 scale-110 bg-cover bg-center will-change-transform"
        style={{
          backgroundImage: `url(${d.poster || d.banner || ""})`,
          filter: "blur(28px) brightness(0.4) saturate(1.4)",
        }}
      />
      {/* Gradient overlay */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-background/30 via-background/70 to-background" />
      {/* Subtle pink tint */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(80%_60%_at_50%_0%,hsl(var(--primary)/0.10),transparent_70%)]"
      />

      <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:gap-8">
          {/* Cover — click to expand */}
          <div className="mx-auto shrink-0 sm:mx-0">
            {d.poster ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={d.poster}
                alt={title}
                loading="eager"
                style={{ aspectRatio: "4/6" }}
                onClick={() => onOpenLightbox(d.poster)}
                title="Click to expand"
                className="h-[225px] w-[150px] cursor-zoom-in rounded-xl object-cover shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7),0_0_80px_-20px_hsl(var(--primary)/0.25)] ring-1 ring-white/[0.06] transition-transform hover:scale-[1.02] sm:h-[315px] sm:w-[210px]"
              />
            ) : (
              <div className="h-[225px] w-[150px] rounded-xl bg-card ring-1 ring-white/[0.06] sm:h-[315px] sm:w-[210px]" />
            )}
          </div>

          {/* Info column */}
          <div className="min-w-0 flex-1 space-y-3 sm:space-y-4">
            {status && (
              <div>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${status.cls}`}
                >
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status.dot} ${status.pulse ? "animate-pulse" : ""}`} />
                  {status.label}
                </span>
              </div>
            )}

            <h1 className="line-clamp-3 text-2xl font-bold leading-[1.15] tracking-tight text-foreground sm:text-3xl md:text-[34px]">
              {title}
            </h1>

            {d.romaji && d.romaji !== title && <p className="text-sm text-muted-foreground">{d.romaji}</p>}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
              {meta.map((m, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="opacity-40">·</span>}
                  <span>{m}</span>
                </React.Fragment>
              ))}
            </div>

            {(d.genres.length > 0 || d.isAdult) && (
              <div className="flex flex-wrap gap-1.5">
                {d.isAdult && (
                  <span className="inline-flex items-center rounded-full border border-red-500/35 bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-400">
                    18+
                  </span>
                )}
                {d.genres.map((g) => (
                  <span
                    key={g}
                    className="inline-flex items-center rounded-full border border-border/40 bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/80"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {d.description && (
              <div className="max-w-[70ch]">
                <p className={`whitespace-pre-line text-sm text-muted-foreground ${expanded ? "" : "line-clamp-3"}`}>
                  {d.description}
                </p>
                {d.description.length > 240 && (
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                  >
                    {expanded ? "Show less" : "Read more"}
                  </button>
                )}
              </div>
            )}

            {/* Action toolbar */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button className="play-btn px-0 w-9 sm:w-auto sm:px-4" onClick={() => onPlay(isSeries ? next.number : 1)}>
                <Play className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">
                  {isSeries ? `${continuing ? "Continue" : "Play"} E${next.number}` : "Play"}
                </span>
              </Button>
              {!offline && (
                <>
                  <Button
                    variant="outline"
                    aria-pressed={inW}
                    onClick={() => void toggleList("watchlist")}
                    className={`px-0 w-9 sm:w-auto sm:px-4 ${inW ? "border-primary/50 text-primary" : ""}`}
                  >
                    <Star className={`h-4 w-4 sm:mr-2 ${inW ? "fill-current" : ""}`} />
                    <span className="hidden sm:inline">{inW ? "On watchlist" : "Watchlist"}</span>
                  </Button>
                  <Button
                    variant="outline"
                    aria-pressed={inF}
                    onClick={() => void toggleList("favorites")}
                    className={`px-0 w-9 sm:w-auto sm:px-4 ${inF ? "border-pink-500/60 bg-pink-500/15 text-pink-500 hover:bg-pink-500/20 hover:text-pink-500" : ""}`}
                  >
                    <Heart className={`h-4 w-4 sm:mr-2 ${inF ? "fill-current" : ""}`} />
                    <span className="hidden sm:inline">{inF ? "Favourited" : "Favourite"}</span>
                  </Button>
                  <Button
                    variant="outline"
                    aria-pressed={d.inLibrary}
                    onClick={() => void toggleLibrary()}
                    className={`px-0 w-9 sm:w-auto sm:px-4 ${d.inLibrary ? "border-primary/50 text-primary" : ""}`}
                  >
                    <LibraryBig className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">{d.inLibrary ? "In library" : "Add to library"}</span>
                  </Button>
                  <Button variant="outline" onClick={() => setTrackOpen(true)} className="px-0 w-9 sm:w-auto sm:px-4">
                    <Rss className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Track</span>
                  </Button>
                  {/* A saved per-title setting, so an on/off control with
                      visible state — Shiori's Hide Decimals / Prioritize Free. */}
                  {isSeries && !denied && (
                    <Button
                      variant={d.autoDownload ? "default" : "outline"}
                      aria-pressed={d.autoDownload}
                      onClick={() => void toggleAuto()}
                      className="px-0 w-9 sm:w-auto sm:px-4"
                    >
                      <RefreshCw className={`h-4 w-4 sm:mr-2 ${d.autoDownload ? "" : "opacity-70"}`} />
                      <span className="hidden sm:inline">{d.autoDownload ? "Auto-download on" : "Auto-download"}</span>
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Shiori's tracker control is a dialog behind the Track button. */}
      <Dialog open={trackOpen} onOpenChange={setTrackOpen}>
        <DialogContent className="w-[95vw] max-w-lg sm:w-full">
          <DialogHeader>
            <DialogTitle>Track</DialogTitle>
            <DialogDescription>Status, progress and score on your connected trackers.</DialogDescription>
          </DialogHeader>
          <TrackingRow id={d.id} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
