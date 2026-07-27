import { logger } from "../logger.js";

// MAL fallback for the browse rows via Jikan (MAL's public REST API — no auth).
// Used only when AniList is unavailable, so the Discover page still populates.
// Cards carry `malId` + source:"mal"; the client resolves them to an AniList id
// on click (see GET /titles/resolve), since the rest of the app is AniList-keyed.
const log = logger("mal");
const JIKAN = "https://api.jikan.moe/v4";

export interface MalCard {
  malId: number;
  source: "mal";
  type: "movie" | "series";
  title: string;
  year: number | null;
  poster: string | null;
  genres: string[];
  content: string[]; // adult categories (hentai/ecchi/erotica) for the content filter
}

const cache = new Map<string, { at: number; data: MalCard[] }>();
const TTL_MS = 10 * 60_000;

async function jikan(path: string): Promise<{ data?: unknown[] }> {
  const res = await fetch(`${JIKAN}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jikan ${res.status}`);
  return (await res.json()) as { data?: unknown[] };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Adult categories from Jikan. Jikan keeps Hentai/Erotica in a separate
// `explicit_genres` field (never in `genres`), plus a `rating` like "Rx - Hentai",
// so derive the filter tags from the FULL set — not the display genres (sliced to 3).
function malContent(a: any): string[] {
  const names = [...(a.genres ?? []), ...(a.explicit_genres ?? [])]
    .map((g: any) => String(g?.name || "").toLowerCase());
  const rating = String(a.rating || "").toLowerCase();
  const tags: string[] = [];
  const hentai = names.includes("hentai") || rating.includes("hentai");
  if (hentai) tags.push("hentai");
  if (names.includes("ecchi")) tags.push("ecchi");
  if (!hentai && (names.includes("erotica") || rating.startsWith("rx"))) tags.push("erotica");
  return tags;
}
function toCard(a: any): MalCard | null {
  if (!a || !a.mal_id) return null;
  return {
    malId: a.mal_id,
    source: "mal",
    type: a.type === "Movie" ? "movie" : "series",
    title: a.title_english || a.title || a.title_japanese || "Untitled",
    year: a.year ?? a.aired?.prop?.from?.year ?? null,
    poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
    genres: (a.genres ?? []).map((g: any) => g?.name).filter(Boolean).slice(0, 3),
    content: malContent(a),
  };
}

function dedupe(cards: (MalCard | null)[]): MalCard[] {
  const seen = new Set<number>();
  const out: MalCard[] = [];
  for (const c of cards) if (c && !seen.has(c.malId)) { seen.add(c.malId); out.push(c); }
  return out;
}

async function cached(key: string, f: () => Promise<MalCard[]>): Promise<MalCard[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const data = await f();
  if (data.length) cache.set(key, { at: Date.now(), data });
  return data;
}

export async function malTrending(): Promise<MalCard[]> {
  return cached("trending", async () => {
    const j = await jikan("/top/anime?filter=airing&limit=25");
    log.info("AniList down — served trending from MAL");
    return dedupe((j.data ?? []).map(toCard)).slice(0, 30);
  });
}

export async function malRecommended(): Promise<MalCard[]> {
  return cached("recommended", async () => {
    // Most-favourited/popular all-time — reliable and distinct from the airing rows.
    const j = await jikan("/top/anime?filter=bypopularity&limit=25");
    return dedupe((j.data ?? []).map(toCard)).slice(0, 30);
  });
}

export async function malNewSeason(): Promise<MalCard[]> {
  return cached("newseason", async () => {
    const j = await jikan("/seasons/now?limit=25");
    return dedupe((j.data ?? []).map(toCard)).slice(0, 30);
  });
}
