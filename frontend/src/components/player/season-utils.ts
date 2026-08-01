// ---------------------------------------------------------------------------
// Season-chain helpers — ports of airedCount / orderedSeasons / seasonNumber /
// seasonChip / seasonOrder from public/app.js (~1344-1378). Pure functions,
// shared by the watch page (season select, up-next row, "Season N" label).
// ---------------------------------------------------------------------------

import type { SeasonRef } from "@/lib/types";

/** The detail subset the player needs (works for online + offline details). */
export interface WatchDetailLike {
  id: number;
  type: string;
  english?: string;
  romaji?: string;
  year?: number | null;
  seasonNum?: number | null;
  seasonPart?: number | null;
  seasonKind?: string | null;
  seasonFormat?: string | null;
  seasons?: SeasonRef[];
  episodeList?: Array<{ number: number; aired?: boolean }>;
}

export interface SeasonEntry {
  id: number;
  title: string;
  year: number | null;
  num: number | null;
  part: number | null;
  kind: string | null;
  format: string | null;
  current?: boolean;
}

export function airedCount(d: WatchDetailLike): number {
  if (d.type === "movie") return 1;
  return (d.episodeList || []).filter((e) => e.aired !== false).length || 1;
}

// Seasons first, then the specials/movies that follow them; ties broken by
// part/year and finally by id (the id tiebreak keeps the row IDENTICAL no
// matter which entry you're viewing — see old app.js seasonOrder comment).
function seasonOrder(a: SeasonEntry, b: SeasonEntry): number {
  return (
    (a.num || 0) - (b.num || 0) ||
    (a.kind === "extra" ? 1 : 0) - (b.kind === "extra" ? 1 : 0) ||
    (a.part || 0) - (b.part || 0) ||
    (a.year || 0) - (b.year || 0) ||
    (a.id || 0) - (b.id || 0)
  );
}

export function orderedSeasons(d: WatchDetailLike): SeasonEntry[] {
  const current: SeasonEntry = {
    id: d.id,
    title: d.english || d.romaji || "",
    year: d.year ?? null,
    num: d.seasonNum ?? null,
    part: d.seasonPart ?? null,
    kind: d.seasonKind ?? null,
    format: d.seasonFormat ?? null,
    current: true,
  };
  const rest: SeasonEntry[] = (d.seasons || []).map((s) => ({
    id: s.id,
    title: s.title,
    year: s.year,
    num: s.num,
    part: s.part,
    kind: s.kind,
    format: s.format,
  }));
  return [current, ...rest].sort(seasonOrder);
}

export function seasonNumber(d: WatchDetailLike): number {
  if (d.seasonNum) return d.seasonNum; // authoritative number from the backend chain
  const i = orderedSeasons(d).findIndex((s) => s.id === d.id);
  return i < 0 ? 1 : i + 1;
}

/** Compact chip label: "S2" / "S2 Pt2"; `word=true` spells it out. */
const EXTRA_LABELS: Record<string, string> = { MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special" };
export function seasonChip(
  s: { num?: number | null; part?: number | null; kind?: string | null; format?: string | null },
  i: number,
  word = false,
): string {
  // Movies/OVAs/specials are part of the series but carry no season number.
  if (s.kind === "extra") return EXTRA_LABELS[s.format || ""] || "Special";
  const n = s.num || i + 1;
  const base = word ? `Season ${n}` : `S${n}`;
  return s.part ? `${base}${word ? " Part " : " Pt"}${s.part}` : base;
}

/** mm:ss / h:mm:ss — old fmtTime (app.js:1588). */
export function fmtTime(s: number): string {
  s = Math.max(0, s | 0);
  const h = (s / 3600) | 0;
  const m = ((s % 3600) / 60) | 0;
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
