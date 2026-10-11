"use client";

// ---------------------------------------------------------------------------
// PosterCard — port of makeCard (public/app.js:616). One component renders
// every grid card: discover/search results, grouped library cards
// (seasonCount badge line, downloaded dot, "Up next" line), updates cards
// (New · S#E# / New season / Soon / Available ribbons) and history cards.
//
// tvnav contract: the root element carries the literal class `card` — tvnav
// sweeps `.card` for D-pad focus and clicks it on Enter/A. Posters load via
// the shared LazyImage (IntersectionObserver + pulse placeholder).
//
// Click behavior (exactly the old makeCard listener):
//   * MAL fallback card (source:"mal") — resolve the AniList id first, then
//     open the title page; toast when resolution fails.
//   * updates ribbon card for an episode/movie — jump straight into playback
//     (mint/reuse the per-series watch id, then /watch/?id=…&ep=…).
//   * anything else — open /title/?id=….
// ---------------------------------------------------------------------------

import { useRouter } from "next/navigation";
import React from "react";
import { toast } from "sonner";

import { markWatchFromTitle } from "@/components/player/play";
import { LazyImage } from "@/components/ui/lazy-image";
import { api, ApiError } from "@/lib/api";
import type { CardItem, ResolveResponse, WatchStart } from "@/lib/types";
import { cn } from "@/lib/utils";

import { useCardSize } from "./card-size";

/** Router-ish surface both next/navigation and tests can satisfy. */
interface PushRouter {
  push(href: string): void;
}

/**
 * Start playback: mint/reuse the per-series watch id then navigate to the
 * player (old play(), app.js:1290 — its offline branch lives with the player
 * agent; cards are only reachable online).
 */
export async function playTitle(router: PushRouter, id: number, ep?: number): Promise<void> {
  try {
    const r = await api<WatchStart>(`/titles/${id}/watch`, { method: "POST" });
    markWatchFromTitle(null); // straight from a grid — no title page behind us
    router.push(`/watch/?id=${encodeURIComponent(r.watchId)}&ep=${ep || 1}`);
  } catch (e) {
    // 401/402 already show the gate / settings pane via the api client.
    if (e instanceof ApiError && (e.status === 401 || e.status === 402)) return;
    toast(e instanceof Error ? e.message : "Playback failed");
  }
}

// 1x1 transparent GIF — emulates the old `onerror -> opacity:.15` broken-
// poster treatment: the card keeps its dim placeholder background.
const BLANK_POSTER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * What clicking a card does (exactly the old makeCard listener): MAL fallback
 * cards resolve their AniList id first; an updates card for an episode/movie
 * goes straight into playback; anything else opens the title page. Shared by
 * the poster cards and the Updates/History feed rows.
 */
export async function openCard(router: PushRouter, item: CardItem): Promise<void> {
  if (item.source === "mal") {
    try {
      const r = await api<ResolveResponse>(`/titles/resolve?mal=${item.malId}`);
      router.push(`/title/?id=${r.id}`);
    } catch {
      toast("Details unavailable right now — try again in a moment");
    }
    return;
  }
  if (item.id == null) return;
  if (item.updKind === "episode" || item.updKind === "movie") {
    await playTitle(router, item.id, item.ep || 1);
    return;
  }
  router.push(`/title/?id=${item.id}`);
}

/**
 * The top-left badge (Shiori's provider-badge slot): the updates feed's
 * "New · S2 E5" / "New season" / "Soon" / "Available" on the accent, else
 * "Movie" for films. Series carry no badge — it was on every card.
 */
function badgeOf(item: CardItem): { text: string; accent: boolean } | null {
  if (item.updKind === "episode") {
    const sTag = item.season ? `S${item.season} ` : "";
    return { text: `New · ${sTag}E${item.ep}`, accent: true };
  }
  if (item.updKind === "season") {
    return { text: `${item.upcoming ? "Soon" : "New season"}${item.season ? ` · S${item.season}` : ""}`, accent: true };
  }
  if (item.updKind === "movie") return { text: "Available", accent: true };
  return item.type === "movie" ? { text: "Movie", accent: false } : null;
}

/**
 * PosterCard — Shiori's library card (RenzoFrontend components/comp/series/
 * list-series/index.tsx): a 4:6 cover that scales on hover, a 2px status
 * strip across the top (green = episodes on your server), the badge top-left
 * on black/70, the up-next episode top-right on the accent, and the centred
 * semibold title on a black/60 bar. Sized by the shared card size; a row may
 * pass a fixed width. The literal `card` class is the tvnav contract.
 */
export function PosterCard({ item, className, width }: { item: CardItem; className?: string; width?: number }) {
  const router = useRouter();
  const size = useCardSize();

  const open = () => openCard(router, item);

  const badge = badgeOf(item);
  return (
    <div
      className={cn("card group relative cursor-pointer rounded-md", className)}
      style={width ? { width, flex: "none" } : undefined}
      role="button"
      aria-label={item.title}
      onClick={() => void open()}
    >
      <div
        className="relative w-full overflow-hidden rounded-md bg-muted shadow transition-transform duration-200 group-hover:scale-105"
        style={{ aspectRatio: "4/6" }}
      >
        <LazyImage
          src={item.poster || BLANK_POSTER}
          fallbackSrc={BLANK_POSTER}
          alt=""
          className="poster absolute inset-0 h-full w-full rounded-md object-cover"
        />
        {item.downloaded ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-green-500" title="Episodes on your server" />
        ) : null}
        {badge && (
          <div
            className={cn(
              "absolute left-1 top-1 z-10 max-w-[70%] truncate rounded px-2 py-0.5 font-semibold text-white shadow",
              badge.accent ? "bg-primary" : "bg-black/70",
              size.badge,
            )}
          >
            {badge.text}
          </div>
        )}
        {item.upNext ? (
          <div className={cn("absolute right-1 top-1 z-10 rounded bg-primary px-2 py-0.5 font-semibold text-white shadow", size.badge)}>
            E{item.upNext}
          </div>
        ) : null}
        <div
          className={cn(
            "absolute bottom-0 left-0 flex w-full items-center justify-center rounded-b-md bg-black/60 px-2 py-1 text-center font-semibold leading-tight text-white",
            size.text,
          )}
        >
          <span className="line-clamp-2">{item.title}</span>
        </div>
      </div>
    </div>
  );
}
