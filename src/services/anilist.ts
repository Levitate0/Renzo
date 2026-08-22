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

// ---------------------------------------------------------------------------
// Rate-limit state
// ---------------------------------------------------------------------------
// AniList allows 30 requests/minute per IP and answers 429 with a Retry-After
// (typically ~30s) plus X-RateLimit-Reset. The old policy clamped that wait to
// 8s and retried up to four times, so every retry landed INSIDE a window that
// had not reset yet: each one was guaranteed to 429 and each one still counted
// against the quota. One rate-limited search therefore fired five doomed
// requests, kept the bucket empty, and blocked the caller for ~32s before
// failing — which the UI reported as "server unreachable" because the request
// was still hanging when the connection gave up.
//
// So: remember when the window actually reopens and refuse to spend requests
// before then, rather than hammering a closed door.
let rateLimitedUntil = 0;

/** Seconds until AniList will accept requests again (0 when it will now). */
export function rateLimitedFor(): number {
  return Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
}

/** Thrown when the quota is spent. Carries the reset delay for the UI. */
export class AniListRateLimited extends Error {
  constructor(public readonly retryAfterSec: number) {
    super(`anilist_rate_limited:${retryAfterSec}`);
    this.name = "AniListRateLimited";
  }
}

// A retry only makes sense while the caller can still afford to wait. Anything
// longer is served better by failing fast with an honest "try again in Ns".
const MAX_RETRY_WAIT_MS = 2_500;

// Identical concurrent queries (two discover rows, a re-render, two clients)
// used to fire separately and burn separate quota — the logs showed duplicate
// retries in the same millisecond. One in-flight request per distinct query.
const inFlight = new Map<string, Promise<unknown>>();

// AniList rate-limits aggressively (429, sometimes 30/min in degraded mode) and
// occasionally 5xx. Retry with backoff so a burst of requests — e.g. walking a
// season chain while the discovery rows also load — doesn't fail a hop and leave
// the chain incomplete.
// A token bucket in FRONT of the request, so the server self-limits instead of
// discovering the limit by being told. AniList allows 30/min; refilling one
// slot every 2.2s averages ~27/min, leaving headroom for the burst capacity
// below. Everything that talks to AniList goes through here — including the
// authenticated tracker calls, which previously had their own fetch and so
// spent quota this limiter could not see.
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_MS = 2_200;
let bucket = BUCKET_CAPACITY;
let bucketLastRefill = Date.now();

function refillBucket(): void {
  const gained = Math.floor((Date.now() - bucketLastRefill) / BUCKET_REFILL_MS);
  if (gained > 0) {
    bucket = Math.min(BUCKET_CAPACITY, bucket + gained);
    bucketLastRefill += gained * BUCKET_REFILL_MS;
  }
}

// Single-threaded: the check and the decrement happen in one tick, so several
// waiters cannot take the same slot — the losers simply loop again.
async function acquireSlot(): Promise<void> {
  for (;;) {
    refillBucket();
    if (bucket > 0) { bucket--; return; }
    const untilNext = BUCKET_REFILL_MS - ((Date.now() - bucketLastRefill) % BUCKET_REFILL_MS);
    await sleep(Math.max(50, untilNext));
  }
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  attempt = 0,
  token?: string,
): Promise<T> {
  // attempt 0 is the entry hop: it refuses spent quota and coalesces. The
  // checks belong HERE and not on retries — a retry has already slept out the
  // window it was told to wait for, and re-checking would reject its own wait.
  if (attempt === 0) {
    const waiting = rateLimitedFor();
    if (waiting > 0) throw new AniListRateLimited(waiting);
    // The token is part of the key ON PURPOSE: an authenticated query returns
    // per-user data (mediaListEntry), so coalescing two users onto one request
    // would hand one user the other's list state.
    const key = `${token ?? "anon"}|${query}|${JSON.stringify(variables)}`;
    const running = inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = gql<T>(query, variables, 1, token).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }

  await acquireSlot();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    await res.text().catch(() => {}); // drain the body so the socket can be reused
    // Believe Retry-After. AniList means it: retrying earlier is a wasted
    // request that also refreshes nothing.
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const waitMs = retryAfter > 0 ? retryAfter * 1000
      : reset > 0 ? Math.max(0, reset * 1000 - Date.now())
      : 30_000;
    rateLimitedUntil = Date.now() + waitMs;
    log.warn(`AniList 429 — quota spent, holding off ${Math.ceil(waitMs / 1000)}s`);
    if (waitMs > MAX_RETRY_WAIT_MS) throw new AniListRateLimited(Math.ceil(waitMs / 1000));
    await sleep(waitMs);
    rateLimitedUntil = 0; // we waited it out; the window is open again
    return gql<T>(query, variables, attempt + 1, token);
  }
  if (res.status >= 500 && attempt < 4) {
    // A 5xx is a different failure: short backoff, it isn't a quota problem.
    await res.text().catch(() => {});
    const wait = Math.min(attempt * 800, 4000);
    log.warn(`AniList ${res.status}, retry ${attempt}/4 in ${wait}ms`);
    await sleep(wait);
    return gql<T>(query, variables, attempt + 1, token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AniList ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`AniList: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data as T;
}

/**
 * Authenticated AniList call, for the tracker. Routed through the same [gql]
 * so it shares the rate-limit backoff, the retry policy, the coalescing and
 * the token bucket — it used to have its own fetch, which meant a 429 there
 * never registered as a rate limit and its requests were invisible to every
 * budget decision made here.
 */
export async function gqlAuthed<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return gql<T>(query, variables, 0, token);
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
// Search was the one query a user could fire arbitrarily fast, completely
// uncached — every keystroke burst past the debounce was an upstream request,
// and going back to a previous query paid again. Results do not move in ten
// minutes.
const searchCache = new Map<string, { at: number; data: AniListMedia[] }>();
const SEARCH_TTL = 10 * 60_000;

export async function searchAnime(search: string, type?: MediaType): Promise<AniListMedia[]> {
  const cacheKey = `${search.trim().toLowerCase()}|${type ?? "all"}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL) return cached.data;
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
  for (const m of data.Page.media) if (m.idMal) rememberMalId(m.idMal, m.id);
  const q = search.trim().toLowerCase();
  // Cache the RANKED result, not the raw page: ranking is deterministic for a
  // given query, so there is nothing to gain by re-running it.
  const ranked = !q
    ? data.Page.media.slice(0, 30)
    // Stable sort: substring hits first, AniList's own ordering breaks ties.
    : data.Page.media
        .map((m, i) => ({ m, i, s: matchScore(m, q) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.m)
        .slice(0, 30);
  if (ranked.length) searchCache.set(cacheKey, { at: Date.now(), data: ranked });
  return ranked;
}

/** Trending anime for the landing page. */
export async function trendingAnime(): Promise<AniListMedia[]> {
  // Cached like the other two rows. It wasn't, so every Discover load spent an
  // AniList request on it — the row is the first thing every client asks for,
  // which made it the biggest single contributor to hitting the rate limit.
  return cachedList("trending", async () => {
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
  });
}

// Light TTL cache for the browse rows (they change slowly; avoids hammering AniList).
const listCache = new Map<string, { at: number; data: AniListMedia[] }>();
// 30 minutes: these rows move on the order of a day, and this cache is what
// stands between every client's Discover load and AniList's 30-req/min budget.
const LIST_TTL_MS = 30 * 60_000;
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

// Metadata for a FINISHED show is immutable in practice; a RELEASING one only
// changes when an episode airs. refreshTitle re-fetched unconditionally, once
// per airing target per autodl tick, which is a steady background drain.
const byIdCache = new Map<number, { at: number; data: AniListMedia }>();
const BY_ID_TTL_RELEASING = 6 * 60 * 60_000;
const BY_ID_TTL_FINISHED = 7 * 24 * 60 * 60_000;
const byIdTtl = (m: AniListMedia) =>
  m.status === "FINISHED" ? BY_ID_TTL_FINISHED : BY_ID_TTL_RELEASING;

export async function getById(id: number): Promise<AniListMedia | null> {
  const hit = byIdCache.get(id);
  if (hit && Date.now() - hit.at < byIdTtl(hit.data)) return hit.data;
  const query = `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;
  try {
    const data = await gql<{ Media: AniListMedia }>(query, { id });
    if (data.Media) {
      byIdCache.set(id, { at: Date.now(), data: data.Media });
      if (data.Media.idMal) rememberMalId(data.Media.idMal, data.Media.id);
    }
    return data.Media;
  } catch (e) {
    log.warn("getById failed", id, String(e));
    // A rate-limit/outage is NOT "this title doesn't exist" — rethrow so callers
    // (and the UI) report a temporary failure instead of a bogus not-found, which
    // made a season card look permanently unclickable.
    if (e instanceof AniListRateLimited) throw e;
    if (/AniList (429|5\d\d)/.test(String(e))) throw new Error("anilist_unavailable");
    return null;
  }
}

export function mediaType(m: AniListMedia): MediaType {
  return m.format === "MOVIE" ? "movie" : "series";
}

// malId -> anilistId. The mapping is immutable, so this never expires. It is
// seeded from the local library at boot (see primeMalIds), which matters: the
// MAL fallback exists precisely for when AniList is rate-limited, and resolving
// a clicked MAL card USED to need an AniList request — so the fallback
// dead-ended exactly when it was needed.
const malToAniList = new Map<number, number>();

export function rememberMalId(malId: number, anilistId: number): void {
  if (malId > 0 && anilistId > 0) malToAniList.set(malId, anilistId);
}

/** Seed the map from titles already on disk — every one carries its malId. */
export function primeMalIds(pairs: Iterable<{ id: number; malId?: number }>): void {
  let n = 0;
  for (const t of pairs) if (t.malId) { rememberMalId(t.malId, t.id); n++; }
  if (n) log.info(`anilist: primed ${n} MAL id mappings from the library`);
}

/**
 * Local-only batch lookup — never touches the network, so it is safe to call
 * on the rate-limited fallback path.
 */
export function knownAniListIds(malIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of malIds) {
    const id = malToAniList.get(m);
    if (id) out.set(m, id);
  }
  return out;
}

/** Resolve a batch of MAL ids in ONE request, so a MAL row is pre-resolved. */
export async function idsFromMal(malIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const missing: number[] = [];
  for (const m of malIds) {
    const known = malToAniList.get(m);
    if (known) out.set(m, known);
    else missing.push(m);
  }
  if (!missing.length) return out;
  const query = `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { id idMal } } }`;
  for (let i = 0; i < missing.length; i += 50) {
    const slice = missing.slice(i, i + 50);
    try {
      const data = await gql<{ Page: { media: { id: number; idMal: number | null }[] } }>(query, { ids: slice });
      for (const m of data.Page.media) if (m.idMal) { rememberMalId(m.idMal, m.id); out.set(m.idMal, m.id); }
    } catch (e) {
      log.warn("idsFromMal failed", String(e));
      break; // rate-limited: return what we have rather than spending more
    }
  }
  return out;
}

/** Map a MyAnimeList id to its AniList id (for MAL-sourced browse cards). */
export async function idFromMal(malId: number): Promise<number | null> {
  const known = malToAniList.get(malId);
  if (known) return known;
  const query = `query ($m: Int) { Media(idMal: $m, type: ANIME) { id } }`;
  try {
    const data = await gql<{ Media: { id: number } | null }>(query, { m: malId });
    if (data.Media?.id) rememberMalId(malId, data.Media.id);
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
// A franchise chain is SYMMETRIC: start from S1 or from S4 and the walk
// converges on the same set. The per-node relCache did not help with that —
// every caller still re-ran the BFS and paid a request per hop on any node it
// had not seen. So cache the assembled chain and, when the walk completed,
// store it under EVERY node id: one walk then answers for the whole franchise.
//
// This is where the requests actually were. /updates walks up to 20 titles and
// each walk is a hop per season, so a cold cache could spend 100+ requests on a
// single poll — far more than the browse rows the older comment blames.
interface ChainEntry { at: number; nodes: Map<number, SeasonNode>; complete: boolean }
const chainCache = new Map<number, ChainEntry>();
const CHAIN_TTL = 60 * 60_000;
// An incomplete walk (a hop 429'd) is cached briefly so a burst of callers does
// not re-walk it, but not for the full hour — it is missing seasons and should
// heal as soon as the quota reopens.
const CHAIN_TTL_INCOMPLETE = 2 * 60_000;

async function buildSeasonChain(startId: number): Promise<{ nodes: Map<number, SeasonNode>; complete: boolean }> {
  const cached = chainCache.get(startId);
  if (cached && Date.now() - cached.at < (cached.complete ? CHAIN_TTL : CHAIN_TTL_INCOMPLETE)) {
    return { nodes: cached.nodes, complete: cached.complete };
  }
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
  const entry: ChainEntry = { at: Date.now(), nodes: found, complete };
  // Only fan the entry out across the franchise when the walk finished. An
  // incomplete chain is only valid for the node it was started from — seeding
  // it everywhere would persist a half-discovered franchise to seasons that
  // could still resolve it fully themselves.
  if (complete) for (const id of found.keys()) chainCache.set(id, entry);
  else chainCache.set(startId, entry);
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
