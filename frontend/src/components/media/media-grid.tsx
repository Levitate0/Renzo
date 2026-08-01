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

import { isHidden, useContentLevel } from "@/components/media/content-filter";
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

const GRID_COLS =
  "grid grid-cols-2 gap-3 min-[420px]:grid-cols-[repeat(auto-fill,minmax(148px,1fr))] sm:gap-[18px] sm:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]";

interface MediaGridProps {
  items: CardItem[] | undefined;
  /** Shown when the list is empty (old default: "Nothing here yet."). */
  empty?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

/** Wrapping cover grid with content filtering + empty state (old renderGrid). */
export function MediaGrid({ items, empty = "Nothing here yet.", loading, className }: MediaGridProps) {
  const [level] = useContentLevel();
  if (loading && !items) return <GridSkeleton className={className} />;
  const vis = (items || []).filter((it) => !isHidden(it, level));
  if (!vis.length) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className={cn("mt-4", GRID_COLS, className)}>
      {vis.map((it, i) => (
        <PosterCard key={`${it.id ?? it.malId ?? it.title}-${it.updKind ?? ""}-${i}`} item={it} />
      ))}
    </div>
  );
}

/** Pulse placeholders while a grid's first fetch is in flight. */
export function GridSkeleton({ count = 12, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("mt-4", GRID_COLS, className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="aspect-[2/3] w-full animate-pulse bg-muted" />
          <div className="space-y-2 p-3">
            <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
          </div>
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
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
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
        <div className="relative">
          {canLeft && (
            <button type="button" aria-label="Scroll left" className={cn(arrowCls, "-left-3")} onClick={() => page(-1)}>
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <div ref={scrollerRef} onScroll={syncArrows} className="browse-scroll gap-3 md:gap-[18px]">
            {vis.map((it, i) => (
              <PosterCard key={`${it.id ?? it.malId ?? it.title}-${i}`} item={it} />
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
