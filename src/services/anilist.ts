import { logger } from "../logger.js";
import type { MediaType, Title } from "../types.js";

const log = logger("anilist");
const ENDPOINT = "https://graphql.anilist.co";

export interface AniListMedia {
  id: number;
  idMal: number | null;
  format: string | null;
  status: string | null;
  episodes: number | null;
  nextAiringEpisode: { episode: number } | null;
  seasonYear: number | null;
  genres: string[];
  description: string | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  coverImage: { extraLarge: string | null; large: string | null } | null;
  bannerImage: string | null;
}

const MEDIA_FIELDS = `
  id
  idMal
  format
  status
  episodes
  nextAiringEpisode { episode }
  seasonYear
  genres
  description(asHtml: false)
  title { romaji english native }
  synonyms
  coverImage { extraLarge large }
  bannerImage
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// AniList rate-limits aggressively (429, sometimes 30/min in degraded mode) and
// occasionally 5xx. Retry with backoff so a burst of requests — e.g. walking a
// season chain while the discovery rows also load — doesn't fail a hop and leave
// the chain incomplete.
async function gql<T>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await res.text().catch(() => {}); // drain the body so the socket can be reused
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 800, 8000);
    log.warn(`AniList ${res.status}, retry ${attempt + 1}/4 in ${wait}ms`);
    await sleep(wait);
    return gql<T>(query, variables, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AniList ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`AniList: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data as T;
}

/** Text search. `type` narrows to movies or series (everything non-MOVIE). */
export async function searchAnime(search: string, type?: MediaType): Promise<AniListMedia[]> {
  const query = `
    query ($search: String, $formats: [MediaFormat]) {
      Page(perPage: 24) {
        media(search: $search, type: ANIME, format_in: $formats, sort: SEARCH_MATCH, isAdult: false) {
          ${MEDIA_FIELDS}
        }
      }
    }`;
  const formats =
    type === "movie" ? ["MOVIE"] : type === "series" ? ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"] : null;
  const data = await gql<{ Page: { media: AniListMedia[] } }>(query, { search, formats });
  return data.Page.media;
}

/** Trending anime for the landing page. */
export async function trendingAnime(): Promise<AniListMedia[]> {
  const query = `
    query {
      Page(perPage: 30) {
        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
          ${MEDIA_FIELDS}
        }
      }
    }`;
  const data = await gql<{ Page: { media: AniListMedia[] } }>(query, {});
  return data.Page.media;
}

// Light TTL cache for the browse rows (they change slowly; avoids hammering AniList).
const listCache = new Map<string, { at: number; data: AniListMedia[] }>();
const LIST_TTL_MS = 10 * 60_000;
async function cachedList(key: string, fetcher: () => Promise<AniListMedia[]>): Promise<AniListMedia[]> {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.data;
  const data = await fetcher();
  if (data.length) listCache.set(key, { at: Date.now(), data });
  return data;
}

const ANIME_FORMATS = new Set(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]);

/** Community-recommended, highly-rated anime. */
export async function recommendedAnime(): Promise<AniListMedia[]> {
  return cachedList("recommended", async () => {
    const query = `
      query {
        Page(perPage: 50) {
          recommendations(sort: RATING_DESC) {
            mediaRecommendation { ${MEDIA_FIELDS} }
          }
        }
      }`;
    const data = await gql<{ Page: { recommendations: { mediaRecommendation: AniListMedia | null }[] } }>(query, {});
    const seen = new Set<number>();
    const out: AniListMedia[] = [];
    for (const r of data.Page.recommendations) {
      const m = r.mediaRecommendation;
      if (m && m.id && !seen.has(m.id) && ANIME_FORMATS.has(m.format ?? "")) { seen.add(m.id); out.push(m); }
    }
    return out.slice(0, 30);
  });
}

function currentSeason(): { season: string; year: number } {
  const d = new Date();
  const m = d.getMonth(); // 0-11
  if (m === 11) return { season: "WINTER", year: d.getFullYear() + 1 }; // Dec -> next WINTER
  const season = m <= 1 ? "WINTER" : m <= 4 ? "SPRING" : m <= 7 ? "SUMMER" : "FALL";
  return { season, year: d.getFullYear() };
}

/** New & continuing shows airing this season (new seasons + new titles). */
export async function newSeasonAnime(): Promise<AniListMedia[]> {
  const { season, year } = currentSeason();
  return cachedList(`newseason:${season}${year}`, async () => {
    const query = `
      query ($season: MediaSeason, $year: Int) {
        Page(perPage: 30) {
          media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC,
                isAdult: false, format_in: [TV, TV_SHORT, ONA, OVA]) {
            ${MEDIA_FIELDS}
          }
        }
      }`;
    const data = await gql<{ Page: { media: AniListMedia[] } }>(query, { season, year });
    return data.Page.media;
  });
}

export async function getById(id: number): Promise<AniListMedia | null> {
  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;
  try {
    const data = await gql<{ Media: AniListMedia }>(query, { id });
    return data.Media;
  } catch (e) {
    log.warn("getById failed", id, String(e));
    return null;
  }
}

export function mediaType(m: AniListMedia): MediaType {
  return m.format === "MOVIE" ? "movie" : "series";
}

/** Map a MyAnimeList id to its AniList id (for MAL-sourced browse cards). */
export async function idFromMal(malId: number): Promise<number | null> {
  const query = `query ($m: Int) { Media(idMal: $m, type: ANIME) { id } }`;
  try {
    const data = await gql<{ Media: { id: number } | null }>(query, { m: malId });
    return data.Media?.id ?? null;
  } catch (e) {
    log.warn("idFromMal failed", malId, String(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-episode thumbnails + related seasons (for the detail view), TTL-cached.
// ---------------------------------------------------------------------------
export interface EpisodeThumb { title: string; thumbnail: string | null }
export interface SeasonRef {
  id: number; title: string; year: number | null; format: string | null;
  episodes: number | null; poster: string | null; relation: string; status: string | null;
  num: number;          // season number within the full chain (from title, else position)
  part: number | null;  // split-cour part ("Season 2 Part 2" -> 2), else null
}
interface DetailExtra { episodes: EpisodeThumb[]; seasons: SeasonRef[]; seasonNum: number; seasonPart: number | null; duration: number | null }

const extraCache = new Map<number, { at: number; data: DetailExtra }>();
const EXTRA_TTL = 60 * 60_000;

// One node's own summary + episode thumbnails + its prequel/sequel TV neighbours.
interface SeasonNode {
  id: number; title: string; year: number | null; format: string | null;
  episodes: number | null; poster: string | null; status: string | null; duration: number | null;
}
interface RelInfo { node: SeasonNode; thumbs: EpisodeThumb[]; neighbours: { relation: string; node: SeasonNode }[] }

const relCache = new Map<number, { at: number; data: RelInfo }>();
const REL_TTL = 60 * 60_000;
// Formats shown as numbered seasons.
const SEASON_FORMATS = ["TV", "TV_SHORT", "ONA"];
// Formats we FOLLOW prequel/sequel edges through — includes OVA/Special so a
// bridge entry (e.g. Slime's "Visions of Coleus" OVA between S1 and S2) keeps the
// chain connected. Bridges are traversed but filtered out of the seasons list.
const TRAVERSE_FORMATS = ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"];

// Derive a season number + split-cour part from a title, e.g.
// "… Season 2 Part 2" -> {num:2, part:2}, "… 3rd Season" -> {num:3}. Bare
// trailing numbers are ignored (too many false positives like "Gundam 00").
function seasonParts(title: string): { num: number | null; part: number | null } {
  const t = title.toLowerCase();
  let num: number | null = null;
  let m = t.match(/\bseason\s+(\d+)\b/) || t.match(/\b(\d+)\s*(?:st|nd|rd|th)\s+season\b/);
  if (m) num = Number(m[1]);
  const pm = t.match(/\bpart\s+(\d+)\b/) || t.match(/\bcour\s+(\d+)\b/);
  const part = pm ? Number(pm[1]) : null;
  return { num, part };
}

// Fetch a single media's own metadata, episode thumbnails, and its DIRECT
// prequel/sequel TV/ONA neighbours. Cached per id so a chain walk that revisits
// a node (they all point back at each other) costs one request, not many.
async function relationsOf(id: number): Promise<RelInfo> {
  const hit = relCache.get(id);
  if (hit && Date.now() - hit.at < REL_TTL) return hit.data;
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id seasonYear format status episodes duration
        title { romaji english }
        coverImage { large }
        streamingEpisodes { title thumbnail }
        relations {
          edges {
            relationType
            node {
              id type format status seasonYear episodes
              title { romaji english }
              coverImage { large }
            }
          }
        }
      }
    }`;
  const data = await gql<{
    Media: {
      id: number; seasonYear: number | null; format: string | null; status: string | null; episodes: number | null; duration: number | null;
      title: { romaji: string | null; english: string | null };
      coverImage: { large: string | null } | null;
      streamingEpisodes: { title: string | null; thumbnail: string | null }[] | null;
      relations: { edges: { relationType: string; node: {
        id: number; type: string; format: string | null; status: string | null;
        seasonYear: number | null; episodes: number | null;
        title: { romaji: string | null; english: string | null };
        coverImage: { large: string | null } | null;
      } }[] } | null;
    };
  }>(query, { id });
  const m = data.Media;
  const node: SeasonNode = {
    id: m.id,
    title: m.title.english ?? m.title.romaji ?? `#${m.id}`,
    year: m.seasonYear,
    format: m.format,
    episodes: m.episodes,
    poster: m.coverImage?.large ?? null,
    status: m.status,
    duration: m.duration ?? null,
  };
  // AniList lists streamingEpisodes in episode order (index 0 = episode 1);
  // titles are prefixed "Episode N - Title". Just strip the prefix for a clean
  // title — do NOT reorder (the "N" is the streaming site's global number).
  const thumbs: EpisodeThumb[] = (m.streamingEpisodes ?? []).map((e) => {
    const raw = (e.title ?? "").trim();
    const mm = raw.match(/^\s*Episode\s+\d+\s*[-:–—]\s*(.+)$/i);
    return { title: mm ? mm[1].trim() : raw, thumbnail: e.thumbnail ?? null };
  });
  const neighbours = (m.relations?.edges ?? [])
    .filter((e) => ["PREQUEL", "SEQUEL"].includes(e.relationType) &&
      e.node.type === "ANIME" && TRAVERSE_FORMATS.includes(e.node.format ?? ""))
    .map((e) => ({
      relation: e.relationType,
      node: {
        id: e.node.id,
        title: e.node.title.english ?? e.node.title.romaji ?? `#${e.node.id}`,
        year: e.node.seasonYear,
        format: e.node.format,
        episodes: e.node.episodes,
        poster: e.node.coverImage?.large ?? null,
        status: e.node.status,
        duration: null, // not needed for neighbours (only the viewed title shows runtime)
      } as SeasonNode,
    }));
  const info: RelInfo = { node, thumbs, neighbours };
  relCache.set(id, { at: Date.now(), data: info });
  return info;
}

// Walk the prequel/sequel chain transitively (BFS) so the FULL set of seasons is
// present no matter which one we start from. AniList only exposes DIRECT
// neighbours, so from S3 you'd otherwise never see S1 (it's two hops away) — the
// old code numbered by array index and mislabelled every later season.
async function buildSeasonChain(startId: number): Promise<{ nodes: Map<number, SeasonNode>; complete: boolean }> {
  const found = new Map<number, SeasonNode>();
  const visited = new Set<number>();
  const queue: number[] = [startId];
  let complete = true;
  while (queue.length && found.size < 32) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    let info: RelInfo;
    try { info = await relationsOf(cur); }
    catch (e) { log.warn("season chain hop failed", cur, String(e)); complete = false; continue; }
    found.set(cur, info.node); // authoritative self metadata
    for (const nb of info.neighbours) {
      if (!found.has(nb.node.id)) found.set(nb.node.id, nb.node);
      if (!visited.has(nb.node.id)) queue.push(nb.node.id);
    }
  }
  return { nodes: found, complete };
}

// Chronological order: by season year, then AniList id as a stable tiebreak
// (handles split-cours that share a year well enough for numbering).
function orderSeasons(nodes: SeasonNode[]): SeasonNode[] {
  return [...nodes].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.id - b.id);
}

export async function detailExtra(id: number): Promise<DetailExtra> {
  const hit = extraCache.get(id);
  if (hit && Date.now() - hit.at < EXTRA_TTL) return hit.data;
  try {
    const self = await relationsOf(id); // episode thumbnails for THIS title
    const { nodes, complete } = await buildSeasonChain(id);
    // Drop OVA/Special bridges from the displayed seasons (but always keep the
    // title being viewed), then order chronologically.
    const displayed = [...nodes.values()].filter((n) => n.id === id || SEASON_FORMATS.includes(n.format ?? ""));
    const chain = orderSeasons(displayed);
    // Season number: prefer the number in the title ("Season 4"), so split-cours
    // and OVA bridges don't offset it; fall back to chronological position.
    const numById = new Map<number, number>();
    const partById = new Map<number, number | null>();
    chain.forEach((n, i) => {
      const { num, part } = seasonParts(n.title);
      numById.set(n.id, num ?? i + 1);
      partById.set(n.id, part);
    });
    const seasonNum = numById.get(id) ?? 1;
    const seasonPart = partById.get(id) ?? null;
    // Other seasons in the chain. relation is derived vs. the current season so
    // consumers (Updates feed) can still tell which are sequels — correct even
    // across multiple hops / bridge entries.
    const seasons: SeasonRef[] = chain
      .filter((n) => n.id !== id)
      .map((n) => ({
        id: n.id,
        title: n.title,
        year: n.year,
        format: n.format,
        episodes: n.episodes,
        poster: n.poster,
        status: n.status,
        num: numById.get(n.id)!,
        part: partById.get(n.id) ?? null,
        relation: numById.get(n.id)! > seasonNum ? "SEQUEL" : "PREQUEL",
      }));
    const result: DetailExtra = { episodes: self.thumbs, seasons, seasonNum, seasonPart, duration: self.node.duration };
    // Only cache a chain we walked in full — never poison the cache with a
    // partial chain (a rate-limited hop), which would mislabel seasons for an
    // hour. An incomplete result is returned best-effort but re-fetched next time.
    if (complete) extraCache.set(id, { at: Date.now(), data: result });
    return result;
  } catch (e) {
    log.warn("detailExtra failed", id, String(e));
    return { episodes: [], seasons: [], seasonNum: 1, seasonPart: null, duration: null };
  }
}

/** Every season id in this title's series chain, INCLUDING the given id. Used to
 *  keep per-user state (library/auto/folder/lists) in lockstep across seasons.
 *  Best-effort: returns at least [id] if the chain can't be fully walked. */
export async function seasonSiblings(id: number): Promise<{ ids: number[]; complete: boolean }> {
  const { nodes, complete } = await buildSeasonChain(id);
  const ids = [...nodes.values()]
    .filter((n) => n.id === id || SEASON_FORMATS.includes(n.format ?? "")) // exclude OVA/Special bridges
    .map((n) => n.id);
  return { ids: ids.length ? ids : [id], complete };
}

/** Convert an AniList record into a library Title skeleton (no episodes yet). */
export function toTitle(m: AniListMedia): Title {
  const type = mediaType(m);
  const romaji = m.title.romaji ?? m.title.english ?? m.title.native ?? `AniList ${m.id}`;
  return {
    id: m.id,
    malId: m.idMal ?? undefined,
    type,
    romaji,
    english: m.title.english ?? undefined,
    synonyms: [...new Set([m.title.native, ...(m.synonyms ?? [])].filter(Boolean) as string[])],
    year: m.seasonYear ?? undefined,
    episodeCount: type === "movie" ? 1 : m.episodes ?? undefined,
    description: (m.description ?? undefined)?.replace(/<[^>]+>/g, "").trim(),
    genres: m.genres ?? [],
    poster: m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined,
    banner: m.bannerImage ?? undefined,
    airingStatus: m.status ?? undefined,
    nextAiringEpisode: m.nextAiringEpisode?.episode ?? undefined,
    addedAt: new Date().toISOString(),
    episodes: [],
  };
}
