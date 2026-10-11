"use client";

// ---------------------------------------------------------------------------
// Grids — port of renderGrid + the browse-row layout (public/app.js:644,
// styles.css "cover grid" / "Browse rows"). MediaGrid is the wrapping cover
// grid used by search results, categories, library, updates and history;
// BrowseRowGrid is the Discover row that turns into a horizontal snap-scroll
// with a trailing "More" tile on phones (old ≤720px media query — the
// `.browse-scroll` rules are appended at the end of globals.css).
//
// Both apply the content filter client-side (old renderGrid filtered through
// isHidden); a level change re-renders instantly from the cached items.
// tvnav: MoreTile carries the literal `more-tile` class (focusable).
// ---------------------------------------------------------------------------

import { ChevronLeft, ChevronRight } from "lucide-react";
import React from "react";

import { isHidden, levelToShow, useContentLevel } from "@/components/media/content-filter";
import { useCardSize } from "@/components/media/card-size";
import { PosterCard } from "@/components/media/poster-card";
import type { CardItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty mt-4 rounded-xl border border-dashed border-border px-5 py-14 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// Shiori's library grid: columns of the shared card size, gap-2 on a phone
// and gap-4 from sm.
const GRID_COLS = "grid gap-2 sm:gap-4";
const gridStyle = (px: number): React.CSSProperties => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${px}px, 1fr))`,
});

interface MediaGridProps {
  items: CardItem[] | undefined;
  /** Shown when the list is empty (old default: "Nothing here yet."). */
  empty?: React.ReactNode;
  loading?: boolean;
  className?: string;
  /** Say how many items the 18+ filter is hiding, with a link to show them
   *  (Library and Search — owner, 2026-10-11: a saved series that vanished
   *  without a word looked like a bug). */
  hiddenNote?: boolean;
}

/**
 * "2 titles hidden by the 18+ filter — Show": raises the level just far
 * enough to show them. Hub twin: Common.kt HiddenByFilterNote.
 */
export function HiddenNote({ hidden }: { hidden: CardItem[] }) {
  const [, setLevel] = useContentLevel();
  if (!hidden.length) return null;
  const next = levelToShow(hidden);
  return (
    <p className="mb-3 mt-3 text-xs text-muted-foreground">
      {hidden.length} title{hidden.length === 1 ? "" : "s"} hidden by the 18+ filter ·{" "}
      <button type="button" className="font-medium text-primary hover:underline" onClick={() => setLevel(next)}>
        Show {next === "ecchi" ? "up to Ecchi" : next === "erotica" ? "up to Erotica" : "all"}
      </button>
    </p>
  );
}

/** Wrapping cover grid with content filtering + empty state (old renderGrid). */
export function MediaGrid({ items, empty = "Nothing here yet.", loading, className, hiddenNote }: MediaGridProps) {
  const [level] = useContentLevel();
  const size = useCardSize();
  if (loading && !items) return <GridSkeleton className={className} />;
  const vis = (items || []).filter((it) => !isHidden(it, level));
  const hidden = hiddenNote ? (items || []).filter((it) => isHidden(it, level)) : [];
  if (!vis.length)
    return hidden.length ? <HiddenNote hidden={hidden} /> : <EmptyState>{empty}</EmptyState>;
  return (
    <>
      <HiddenNote hidden={hidden} />
      <div className={cn("mt-4", GRID_COLS, className)} style={gridStyle(size.px)}>
        {vis.map((it, i) => (
          <PosterCard key={`${it.id ?? it.malId ?? it.title}-${it.updKind ?? ""}-${i}`} item={it} />
        ))}
      </div>
    </>
  );
}

/** Pulse placeholders while a grid's first fetch is in flight. */
export function GridSkeleton({ count = 12, className }: { count?: number; className?: string }) {
  const size = useCardSize();
  return (
    <div className={cn("mt-4", GRID_COLS, className)} style={gridStyle(size.px)}>
      {Array.from({ length: count }, (_, i) => (
        // Shiori's skeleton: a 4:6 shimmering cover.
        <div key={i} className="overflow-hidden rounded-md" style={{ aspectRatio: "4/6" }}>
          <div className="h-full w-full animate-pulse rounded-md bg-muted" />
        </div>
      ))}
    </div>
  );
}

/** Trailing "More ›" tile — phones only (desktop rows wrap and show all). */
function MoreTile({ onMore }: { onMore: () => void }) {
  return (
    <div
      className="more-tile flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-card/50 text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      role="button"
      aria-label="More"
      onClick={onMore}
    >
      <div className="more-ic text-3xl leading-none">›</div>
      <div className="more-lbl text-xs font-semibold">More</div>
    </div>
  );
}

interface BrowseRowProps {
  title: string;
  items: CardItem[] | undefined;
  loading?: boolean;
  /** Open the full-category view (old showCategory) — "See all ›" / More tile. */
  onMore: () => void;
}

/**
 * A Discover row (Trending / Recommended / New & this season): horizontal
 * snap-scroll with "See all ›" in the heading and a trailing More tile — the
 * same layout at every width (user request: desktop matches mobile). Child
 * sizing lives in the `.browse-scroll` rules at the end of globals.css.
 */
export function BrowseRowGrid({ title, items, loading, onMore }: BrowseRowProps) {
  const [level] = useContentLevel();
  const size = useCardSize();
  const vis = (items || []).filter((it) => !isHidden(it, level));
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  // Paging arrows (user request): desktop pointers have no natural horizontal
  // scroll on these rows. Hidden at either end; not rendered on TV (D-pad
  // centres the focused card) or on touch widths (native scrolling).
  const syncArrows = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);
  React.useEffect(() => {
    syncArrows();
    window.addEventListener("resize", syncArrows);
    return () => window.removeEventListener("resize", syncArrows);
  }, [syncArrows, vis.length]);
  const page = (dir: 1 | -1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.9), behavior: "smooth" });
  };
  const arrowCls =
    "row-arrow absolute top-1/2 z-10 hidden h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-black/70 text-foreground backdrop-blur-sm transition-colors hover:border-primary hover:text-primary md:flex";

  return (
    <div className="browse-row mb-6 md:mb-8">
      <div className="row-head mb-3 flex items-baseline justify-between gap-2.5">
        <h2 className="text-base font-semibold">{title}</h2>
        <button
          type="button"
          className="row-more whitespace-nowrap text-[13px] font-semibold text-primary hover:underline"
          onClick={onMore}
        >
          See all ›
        </button>
      </div>
      {loading && !items ? (
        <GridSkeleton count={6} className="mt-0" />
      ) : !vis.length ? (
        <EmptyState>Nothing here yet.</EmptyState>
      ) : (
        /* Horizontal snap-scroll row at EVERY width (user request: desktop
           matches the mobile layout) — child sizing lives in the appended
           `.browse-scroll` rules in globals.css. */
        /* `row-body`: the flex child that takes the row's leftover height when
           browse mode fills the window (see #browseWrap in globals.css). */
        <div className="row-body relative">
          {canLeft && (
            <button type="button" aria-label="Scroll left" className={cn(arrowCls, "-left-3")} onClick={() => page(-1)}>
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <div ref={scrollerRef} onScroll={syncArrows} className="browse-scroll gap-3 md:gap-[18px]">
            {vis.map((it, i) => (
              <PosterCard key={`${it.id ?? it.malId ?? it.title}-${i}`} item={it} width={size.px} />
            ))}
            <MoreTile onMore={onMore} />
          </div>
          {canRight && (
            <button type="button" aria-label="Scroll right" className={cn(arrowCls, "-right-3")} onClick={() => page(1)}>
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
