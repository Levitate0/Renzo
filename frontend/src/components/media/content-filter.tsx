"use client";

// ---------------------------------------------------------------------------
// Graduated "show up to" content filter — port of public/app.js:556-611.
// none < ecchi < erotica < hentai (cumulative): picking "erotica" shows ecchi
// + erotica but hides hentai. Persisted under the OLD localStorage key so an
// upgraded install keeps the user's choice; default "ecchi" (mainstream —
// erotica + hentai hidden by default). Filtering is client-side over the
// card's `content` tags (server-computed), falling back to genres for MAL
// fallback cards (old contentCatsOf).
// The chip ladder renders on every platform, including TV: old
// renderContentChips (app.js:583) has no TV branch, and the chips are plain
// <button>s so tvnav's D-pad focus discovery picks them up.
// ---------------------------------------------------------------------------

import React, { useCallback, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

const CONTENT_LEVEL_KEY = "renzo:contentLevel"; // same key as the old app

export const CONTENT_LADDER = ["none", "ecchi", "erotica", "hentai"] as const;
export type ContentLevel = (typeof CONTENT_LADDER)[number];

const CONTENT_LABELS: Record<ContentLevel, string> = {
  none: "Off",
  ecchi: "Ecchi",
  erotica: "Erotica",
  hentai: "Hentai",
};
const CAT_RANK: Record<string, number> = { ecchi: 1, erotica: 2, hentai: 3 };

/** none=0 … hentai=3 (old levelRank). */
export function levelRank(level: ContentLevel): number {
  return CONTENT_LADDER.indexOf(level);
}

// --- tiny external store so Discover + Library chips stay in sync ----------
let cached: ContentLevel | null = null;
const listeners = new Set<() => void>();

function readStored(): ContentLevel {
  try {
    const v = localStorage.getItem(CONTENT_LEVEL_KEY);
    return (CONTENT_LADDER as readonly string[]).includes(v ?? "")
      ? (v as ContentLevel)
      : "ecchi";
  } catch {
    return "ecchi";
  }
}

export function getContentLevel(): ContentLevel {
  if (cached === null) {
    cached = typeof window === "undefined" ? "ecchi" : readStored();
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
  const level = useSyncExternalStore(subscribe, getContentLevel, () => "ecchi" as ContentLevel);
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

/** True when the item sits ABOVE the chosen level (old isHidden). */
export function isHidden(item: ContentTagged, level: ContentLevel): boolean {
  const cats = contentCatsOf(item);
  if (!cats.length) return false; // non-adult always shown
  const itemRank = Math.max(...cats.map((c) => CAT_RANK[c] || 0));
  return itemRank > levelRank(level);
}

// --- the segmented chip ladder (old renderContentChips) --------------------

/**
 * "🔞 Show up to" chip ladder — doubles as the current-mode indicator.
 * Rendered on ALL platforms (TV included, matching old renderContentChips —
 * the plain <button> chips are D-pad focusable via tvnav).
 */
export function ContentChips({ className }: { className?: string }) {
  const [level, setLevel] = useContentLevel();
  return (
    <div
      className={cn(
        "content-chips my-1.5 flex flex-wrap items-center gap-2",
        className,
      )}
    >
      <span className="content-chips-label mr-0.5 text-xs font-semibold text-muted-foreground opacity-80">
        🔞 Show up to
      </span>
      {CONTENT_LADDER.map((l) => (
        <button
          key={l}
          type="button"
          title={
            l === "none"
              ? "Hide all adult content"
              : `Show up to ${CONTENT_LABELS[l]} (and everything milder)`
          }
          onClick={() => setLevel(l)}
          className={cn(
            // NOTE: not the literal `chip` class — globals.css already has an
            // unlayered Shiori `.chip` rule that would override these utilities.
            "content-chip cursor-pointer rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
            l === level
              ? "border-transparent bg-primary text-primary-foreground"
              : "border-border bg-card text-muted-foreground hover:border-ring hover:text-foreground",
          )}
        >
          {CONTENT_LABELS[l]}
        </button>
      ))}
    </div>
  );
}
