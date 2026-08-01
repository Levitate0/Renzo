// ---------------------------------------------------------------------------
// Season math — straight port of orderedSeasons / seasonNumber / seasonChip /
// seasonOrder / airedCount from public/app.js (~1344-1378). The id tiebreak in
// seasonOrder is what keeps the season row IDENTICAL no matter which entry
// you're viewing (see the comment in the old file).
// ---------------------------------------------------------------------------

export interface SeasonEntry {
  id: number;
  title: string;
  year: number | null;
  poster?: string | null;
  num: number | null;
  part: number | null;
  kind: string | null;
  format: string | null;
  current?: boolean;
}

/** The subset of a detail payload the season helpers need. */
export interface SeasonSource {
  id: number;
  type?: string;
  english?: string;
  romaji?: string;
  year?: number | null;
  poster?: string | null;
  seasonNum?: number | null;
  seasonPart?: number | null;
  seasonKind?: string | null;
  seasonFormat?: string | null;
  seasons?: Array<{
    id: number;
    title: string;
    year: number | null;
    poster?: string | null;
    num: number | null;
    part: number | null;
    kind: string | null;
    format: string | null;
  }>;
  episodeList?: Array<{ aired?: boolean }>;
}

const EXTRA_LABELS: Record<string, string> = { MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special" };

/** Compact chip label: "S2" or, for split-cours, "S2 Pt2". `word=true` spells it out. */
export function seasonChip(s: SeasonEntry, i: number, word = false): string {
  // Movies/OVAs/specials are part of the series but carry no season number.
  if (s.kind === "extra") return EXTRA_LABELS[s.format || ""] || "Special";
  const n = s.num || i + 1;
  const base = word ? `Season ${n}` : `S${n}`;
  return s.part ? `${base}${word ? " Part " : " Pt"}${s.part}` : base;
}

/** Seasons first, then extras; ties by part/year and finally id (stable row). */
export function seasonOrder(a: SeasonEntry, b: SeasonEntry): number {
  return (
    (a.num || 0) - (b.num || 0) ||
    (a.kind === "extra" ? 1 : 0) - (b.kind === "extra" ? 1 : 0) ||
    (a.part || 0) - (b.part || 0) ||
    (a.year || 0) - (b.year || 0) ||
    (a.id || 0) - (b.id || 0)
  );
}

/** Current entry + related prequel/sequel entries in canonical order. */
export function orderedSeasons(d: SeasonSource): SeasonEntry[] {
  return [
    {
      id: d.id,
      title: d.english || d.romaji || "",
      year: d.year ?? null,
      poster: d.poster,
      num: d.seasonNum ?? null,
      part: d.seasonPart ?? null,
      kind: d.seasonKind ?? null,
      format: d.seasonFormat ?? null,
      current: true,
    },
    ...(d.seasons || []).map((s) => ({
      id: s.id,
      title: s.title,
      year: s.year,
      poster: s.poster,
      num: s.num,
      part: s.part,
      kind: s.kind,
      format: s.format,
    })),
  ].sort(seasonOrder);
}

/** Real season number (backend chain if present, else position in the row). */
export function seasonNumber(d: SeasonSource): number {
  if (d.seasonNum) return d.seasonNum;
  const i = orderedSeasons(d).findIndex((s) => s.id === d.id);
  return i < 0 ? 1 : i + 1;
}

/** How many episodes have aired (movies count as 1). */
export function airedCount(d: SeasonSource): number {
  if (d.type === "movie") return 1;
  return (d.episodeList || []).filter((e) => e.aired !== false).length || 1;
}
