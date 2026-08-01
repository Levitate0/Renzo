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

function Ribbon({ item }: { item: CardItem }) {
  const base =
    "upd-ribbon absolute left-2 top-2 z-10 rounded-full px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.4px] text-white";
  if (item.updKind === "episode") {
    const sTag = item.season ? `S${item.season} ` : "";
    return (
      <span className={cn(base, "bg-gradient-to-br from-primary to-primary/70")}>
        New · {sTag}E{item.ep}
      </span>
    );
  }
  if (item.updKind === "season") {
    return (
      <span className={cn(base, "season bg-gradient-to-br from-indigo-500 to-indigo-400")}>
        {item.upcoming ? "Soon" : "New season"}
        {item.season ? ` · S${item.season}` : ""}
      </span>
    );
  }
  if (item.updKind === "movie") {
    return <span className={cn(base, "bg-gradient-to-br from-primary to-primary/70")}>Available</span>;
  }
  return (
    <span className="pill absolute left-2 top-2 z-10 rounded-full border border-white/10 bg-black/70 px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.4px] text-foreground backdrop-blur-sm">
      {item.type === "movie" ? "Movie" : "Series"}
    </span>
  );
}

export function PosterCard({ item, className }: { item: CardItem; className?: string }) {
  const router = useRouter();

  const open = async () => {
    if (item.source === "mal") {
      // AniList-down fallback card — resolve the id first (old makeCard).
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
  };

  const meta = [
    item.year,
    (item.genres || [])[0],
    (item.seasonCount ?? 0) > 1 ? `${item.seasonCount} seasons` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={cn(
        "card group relative cursor-pointer overflow-hidden rounded-xl border border-border bg-card transition-all duration-150 hover:-translate-y-1 hover:border-ring hover:shadow-lg",
        className,
      )}
      role="button"
      aria-label={item.title}
      onClick={() => void open()}
    >
      <Ribbon item={item} />
      {item.downloaded ? (
        <span
          className="dot absolute right-2 top-2 z-10 h-[9px] w-[9px] rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(61,220,132,0.2)]"
          title="downloaded episodes"
        />
      ) : null}
      <LazyImage
        src={item.poster || BLANK_POSTER}
        fallbackSrc={BLANK_POSTER}
        alt=""
        className="poster block aspect-[2/3] w-full bg-black/40 object-cover"
      />
      <div className="cap px-3 pb-3 pt-2">
        <div className="t line-clamp-2 text-[13px] font-semibold leading-[1.3]">{item.title}</div>
        {meta ? <div className="m mt-[3px] text-[11px] text-muted-foreground">{meta}</div> : null}
        {item.upNext ? (
          <div className="upnext mt-1 text-[11px] font-semibold text-primary">
            ▶ Up next · E{item.upNext}
          </div>
        ) : null}
      </div>
    </div>
  );
}
