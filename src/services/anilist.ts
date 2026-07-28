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
  isAdult: boolean;
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
  isAdult
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

// AniList's SEARCH_MATCH ranks titles that START with the query, so a term that
// appears mid-title ("Teacher" in "Why the hell are you here, Teacher!?") lands
// around rank 30-40 and used to fall outside the page entirely. Score every
// candidate by how it contains the query so a plain word behaves like *query*.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function matchScore(m: AniListMedia, q: string): number {
  const fields = [m.title.english, m.title.romaji, m.title.native, ...(m.synonyms ?? [])]
    .filter(Boolean).map((s) => (s as string).toLowerCase());
  const word = new RegExp(`\\b${escapeRe(q)}`);
  let best = 0;
  for (const f of fields) {
    if (f === q) return 5;                       // exact title
    if (f.startsWith(q)) best = Math.max(best, 4);
    else if (word.test(f)) best = Math.max(best, 3); // starts a word mid-title
    else if (f.includes(q)) best = Math.max(best, 2); // anywhere at all
  }
  return best;
}

/** Text search. `type` narrows to movies or series (everything non-MOVIE). */
export async function searchAnime(search: string, type?: MediaType): Promise<AniListMedia[]> {
  const formats =
    type === "movie" ? ["MOVIE"] : type === "series" ? ["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"] : null;
  // AniList returns HTTP 500 on an explicit `format_in: null`, so only declare and
  // pass the argument when a format filter is actually set (type = All omits it).
  const fmtDecl = formats ? ", $formats: [MediaFormat]" : "";
  const fmtArg = formats ? ", format_in: $formats" : "";
  // Pull a wide candidate pool (AniList caps perPage at 50) and re-rank locally —
  // the match we want is often past the first two dozen results.
  const query = `
    query ($search: String${fmtDecl}) {
      Page(perPage: 50) {
        media(search: $search, type: ANIME${fmtArg}, sort: SEARCH_MATCH) {
          ${MEDIA_FIELDS}
        }
      }
    }`;
  const vars: Record<string, unknown> = { search };
  if (formats) vars.formats = formats;
  const data = await gql<{ Page: { media: AniListMedia[] } }>(query, vars);
  const q = search.trim().toLowerCase();
  if (!q) return data.Page.media.slice(0, 30);
  // Stable sort: substring hits first, AniList's own ordering breaks ties.
  return data.Page.media
    .map((m, i) => ({ m, i, s: matchScore(m, q) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m)
    .slice(0, 30);
}

/** Trending anime for the landing page. */
export async function trendingAnime(): Promise<AniListMedia[]> {
  const query = `
    query {
      Page(perPage: 30) {
        media(type: ANIME, sort: TRENDING_DESC) {
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
    // A rate-limit/outage is NOT "this title doesn't exist" — rethrow so callers
    // (and the UI) report a temporary failure instead of a bogus not-found, which
    // made a season card look permanently unclickable.
    if (/AniList (429|5\d\d)/.test(String(e))) throw new Error("anilist_unavailable");
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
  kind: SeasonKind;     // "extra" = OVA/special attached to the series, not a numbered season
}
export type SeasonKind = "season" | "extra";
interface DetailExtra { episodes: EpisodeThumb[]; seasons: SeasonRef[]; seasonNum: number; seasonPart: number | null; seasonKind: SeasonKind; seasonFormat: string | null; nextUp: SeasonRef | null; duration: number | null }

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
// Movies/OVAs/specials belong to a series but never take a season number ("extras").
const EXTRA_FORMATS = ["MOVIE", "OVA", "SPECIAL"];
// Formats we FOLLOW relation edges through — includes the extras so a bridge entry
// keeps the chain connected: Slime's "Visions of Coleus" OVA between S1 and S2, or
// the Rascal franchise, whose 2018 and 2025 TV seasons are joined ONLY by a run of
// movies (TV -> movie -> movie -> movie -> TV).
const TRAVERSE_FORMATS = ["TV", "TV_SHORT", "ONA", "MOVIE", "OVA", "SPECIAL"];
// Relations that can join one series chain. PREQUEL/SEQUEL are the season spine;
// SIDE_STORY/PARENT attach specials & OVAs to their parent show (e.g. "Why the
// hell are you here, Teacher!?: Thirteenth Period" is a SIDE_STORY, not a sequel,
// so it used to float as its own separate series).
const CHAIN_RELATIONS = ["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT"];

/** True for formats that are numbered seasons (not a movie/OVA/special). */
export function isSeasonFormat(fmt: string | null | undefined): boolean {
  return SEASON_FORMATS.includes(fmt ?? "");
}
function isExtraFormat(fmt: string | null | undefined): boolean {
  return EXTRA_FORMATS.includes(fmt ?? "");
}

/** Whether a relation edge joins the same series. Side-story/parent edges are
 *  followed ONLY to attach an OVA/special to its parent — never between two full
 *  shows, so a TV spin-off keeps its own identity instead of being swallowed. */
function followsChain(from: SeasonNode, relation: string, to: SeasonNode): boolean {
  if (relation === "PREQUEL" || relation === "SEQUEL") return true;
  if (relation === "SIDE_STORY") return isExtraFormat(to.format);   // series -> its extra
  if (relation === "PARENT") return isExtraFormat(from.format);      // extra -> its series
  return false;
}

// Bump when the chain-walking rules change so persisted seriesKeys (which are
// cached on Title) are recomputed instead of pinning the old grouping.
export const SERIES_CHAIN_VERSION = 2;

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
    .filter((e) => CHAIN_RELATIONS.includes(e.relationType) &&
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
      if (!followsChain(info.node, nb.relation, nb.node)) continue; // not the same series
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
    // Show the numbered seasons AND the series' OVAs/specials (they're part of the
    // series, just not numbered), ordered chronologically.
    const displayed = [...nodes.values()].filter(
      (n) => n.id === id || SEASON_FORMATS.includes(n.format ?? "") || isExtraFormat(n.format),
    );
    const chain = orderSeasons(displayed);
    // Season number: prefer the number in the title ("Season 4"), so split-cours
    // don't offset it; fall back to position among the REAL seasons. Extras never
    // consume a number — they inherit the season they follow purely for ordering.
    const numById = new Map<number, number>();
    const partById = new Map<number, number | null>();
    const kindById = new Map<number, SeasonKind>();
    let pos = 0;
    for (const n of chain) {
      if (isExtraFormat(n.format)) {
        kindById.set(n.id, "extra");
        numById.set(n.id, pos || 1); // sorts directly after the preceding season
        partById.set(n.id, null);
        continue;
      }
      kindById.set(n.id, "season");
      const { num, part } = seasonParts(n.title);
      pos = num ?? pos + 1;       // a title-derived number re-anchors the counter
      numById.set(n.id, pos);
      partById.set(n.id, part);
    }
    const seasonNum = numById.get(id) ?? 1;
    const seasonPart = partById.get(id) ?? null;
    const seasonKind = kindById.get(id) ?? "season";
    const seasonFormat = self.node.format;
    // Other entries in the chain. relation is derived vs. the current season so
    // consumers (Updates feed) can still tell which are sequels — correct even
    // across multiple hops / bridge entries. Extras report SIDE_STORY so the
    // Updates feed never announces a special as a brand-new season.
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
        kind: kindById.get(n.id) ?? "season",
        relation: kindById.get(n.id) === "extra" ? "SIDE_STORY"
          : numById.get(n.id)! > seasonNum ? "SEQUEL" : "PREQUEL",
      }));
    // "Up next": the next watchable entry in the chain after this one, whatever
    // its format — S1 -> the movie that continues it -> S2. Unreleased entries are
    // skipped so the card never points at something you can't watch yet.
    const order = chain.map((n) => n.id);
    const selfPos = order.indexOf(id);
    const nextUp = selfPos < 0 ? null
      : seasons.find((s) => order.indexOf(s.id) > selfPos && s.status !== "NOT_YET_RELEASED") ?? null;
    const result: DetailExtra = { episodes: self.thumbs, seasons, seasonNum, seasonPart, seasonKind, seasonFormat, nextUp, duration: self.node.duration };
    // Only cache a chain we walked in full — never poison the cache with a
    // partial chain (a rate-limited hop), which would mislabel seasons for an
    // hour. An incomplete result is returned best-effort but re-fetched next time.
    if (complete) extraCache.set(id, { at: Date.now(), data: result });
    return result;
  } catch (e) {
    log.warn("detailExtra failed", id, String(e));
    return { episodes: [], seasons: [], seasonNum: 1, seasonPart: null, seasonKind: "season", seasonFormat: null, nextUp: null, duration: null };
  }
}

/** Every id in this title's series chain, INCLUDING the given id — seasons AND
 *  the series' movies/OVAs/specials. Used to group the library into one card per
 *  series and keep per-user state (library/auto/folder/lists) in lockstep. Extras
 *  are included deliberately: a franchise movie or special is part of the series,
 *  not a separate show, so it must not surface as its own card.
 *  Best-effort: returns at least [id] if the chain can't be fully walked. */
export async function seasonSiblings(id: number): Promise<{ ids: number[]; complete: boolean }> {
  const { nodes, complete } = await buildSeasonChain(id);
  const ids = [...nodes.values()].map((n) => n.id);
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
    format: m.format ?? undefined,
    romaji,
    english: m.title.english ?? undefined,
    synonyms: [...new Set([m.title.native, ...(m.synonyms ?? [])].filter(Boolean) as string[])],
    year: m.seasonYear ?? undefined,
    episodeCount: type === "movie" ? 1 : m.episodes ?? undefined,
    description: (m.description ?? undefined)?.replace(/<[^>]+>/g, "").trim(),
    genres: m.genres ?? [],
    isAdult: m.isAdult ?? false,
    poster: m.coverImage?.extraLarge ?? m.coverImage?.large ?? undefined,
    banner: m.bannerImage ?? undefined,
    airingStatus: m.status ?? undefined,
    nextAiringEpisode: m.nextAiringEpisode?.episode ?? undefined,
    addedAt: new Date().toISOString(),
    episodes: [],
  };
}
