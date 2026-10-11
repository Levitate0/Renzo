"use client";

// ---------------------------------------------------------------------------
// 18+ filter — Shiori's single switch (RenzoFrontend lib/utils/adult-filter.ts
// useHideAdult): adult titles are Hidden or Shown, and "adult" is everything
// the server tags ecchi, erotica or hentai. Owner direction 2026-10-11: the
// old four-step ladder (none < ecchi < erotica < hentai) is gone — erotica
// already includes pornographic titles, so the steps meant nothing.
//
// Stored under the OLD key so an upgraded install keeps its choice: "none" is
// Hidden, anything else (incl. a saved "ecchi"/"erotica" step) is Shown, and
// Shown is written as "hentai" so an older build reading the key shows all.
// Default Hidden — a FRESH user sees no adult content until they opt in. That
// default is a store-listing commitment as much as a taste call: the Play
// content-rating questionnaire asks what a user can reach, and "hidden until
// opted into" is the answer the listing is rated on. Filtering is client-side
// over the card's `content` tags (server-computed), falling back to genres
// for MAL fallback cards (old contentCatsOf). Hub twin: Common.kt isHidden /
// ContentChips.
// ---------------------------------------------------------------------------

import { Eye, EyeOff } from "lucide-react";
import React, { useCallback, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils";

const CONTENT_LEVEL_KEY = "renzo:contentLevel"; // same key as the old app

/** "none" = 18+ Hidden, "hentai" = 18+ Shown (the old key's top step). */
export type ContentLevel = "none" | "hentai";


// --- tiny external store so Discover + Library chips stay in sync ----------
let cached: ContentLevel | null = null;
const listeners = new Set<() => void>();

function readStored(): ContentLevel {
  try {
    const v = localStorage.getItem(CONTENT_LEVEL_KEY);
    // A saved old step (ecchi/erotica/hentai) means the user opted in: Shown.
    return v === "ecchi" || v === "erotica" || v === "hentai" ? "hentai" : "none";
  } catch {
    return "none";
  }
}

export function getContentLevel(): ContentLevel {
  if (cached === null) {
    cached = typeof window === "undefined" ? "none" : readStored();
  }
  return cached;
}

export function setContentLevel(level: ContentLevel): void {
  cached = level;
  try {
    localStorage.setItem(CONTENT_LEVEL_KEY, level);
  } catch {
    /* private mode — keep the in-memory value */
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive content level (shared across every chip ladder + grid). */
export function useContentLevel(): [ContentLevel, (l: ContentLevel) => void] {
  // Server snapshot must match the fresh-user default, or the first paint
  // would flash adult cards before hydration corrects it.
  const level = useSyncExternalStore(subscribe, getContentLevel, () => "none" as ContentLevel);
  const set = useCallback((l: ContentLevel) => setContentLevel(l), []);
  return [level, set];
}

// --- filtering (old contentCatsOf / isHidden) ------------------------------

interface ContentTagged {
  content?: string[];
  genres?: string[];
}

/** A card's adult categories: prefer server-computed `content`, else derive
 *  from genres (covers MAL fallback cards, which carry genres but no content). */
export function contentCatsOf(item: ContentTagged): string[] {
  if (item.content && item.content.length) return item.content;
  const g = (item.genres || []).map((x) => String(x).toLowerCase());
  const cats: string[] = [];
  if (g.includes("hentai")) cats.push("hentai");
  if (g.includes("ecchi")) cats.push("ecchi");
  return cats;
}

/** True when adult titles are hidden and this one is adult. */
export function isHidden(item: ContentTagged, level: ContentLevel): boolean {
  return level === "none" && contentCatsOf(item).length > 0;
}

/** Shiori's useHideAdult: [hidden, toggle] over the shared store. */
export function useHideAdult(): [boolean, () => void] {
  const [level, setLevel] = useContentLevel();
  const hidden = level === "none";
  const toggle = useCallback(() => setLevel(hidden ? "hentai" : "none"), [hidden, setLevel]);
  return [hidden, toggle];
}

/**
 * Shiori's 18+ button (RenzoFrontend app/library/page.tsx): outline when
 * hidden, an amber wash once adult titles are shown. Used on the Library and
 * Discover ribbons.
 */
export function AdultToggle({ className }: { className?: string }) {
  const [hidden, toggle] = useHideAdult();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={toggle}
      aria-pressed={!hidden}
      title={hidden ? "Adult (18+) titles are hidden" : "Adult (18+) titles are shown"}
      className={cn(
        "h-8 shrink-0 gap-1.5 px-2.5 text-xs",
        !hidden && "border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400",
        className,
      )}
    >
      {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      <span className="hidden sm:inline">{hidden ? "18+ Hidden" : "18+ Shown"}</span>
      <span className="sm:hidden">18+</span>
    </Button>
  );
}
