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

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
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
}
interface DetailExtra { episodes: EpisodeThumb[]; seasons: SeasonRef[] }

const extraCache = new Map<number, { at: number; data: DetailExtra }>();
const EXTRA_TTL = 60 * 60_000;

export async function detailExtra(id: number): Promise<DetailExtra> {
  const hit = extraCache.get(id);
  if (hit && Date.now() - hit.at < EXTRA_TTL) return hit.data;
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
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
  try {
    const data = await gql<{
      Media: {
        streamingEpisodes: { title: string | null; thumbnail: string | null }[] | null;
        relations: { edges: { relationType: string; node: {
          id: number; type: string; format: string | null; status: string | null;
          seasonYear: number | null; episodes: number | null;
          title: { romaji: string | null; english: string | null };
          coverImage: { large: string | null } | null;
        } }[] } | null;
      };
    }>(query, { id });
    // AniList lists streamingEpisodes in episode order (index 0 = episode 1);
    // titles are prefixed "Episode N - Title". Just strip the prefix for a clean
    // title — do NOT reorder (the "N" is the streaming site's global number).
    const episodes: EpisodeThumb[] = (data.Media.streamingEpisodes ?? []).map((e) => {
      const raw = (e.title ?? "").trim();
      const m = raw.match(/^\s*Episode\s+\d+\s*[-:–—]\s*(.+)$/i);
      return { title: m ? m[1].trim() : raw, thumbnail: e.thumbnail ?? null };
    });
    // Seasons = directly-related TV/ONA prequels & sequels (other cours).
    const seasons: SeasonRef[] = (data.Media.relations?.edges ?? [])
      .filter((e) => ["PREQUEL", "SEQUEL"].includes(e.relationType) &&
        e.node.type === "ANIME" && ["TV", "TV_SHORT", "ONA"].includes(e.node.format ?? ""))
      .map((e) => ({
        id: e.node.id,
        title: e.node.title.english ?? e.node.title.romaji ?? `#${e.node.id}`,
        year: e.node.seasonYear,
        format: e.node.format,
        episodes: e.node.episodes,
        poster: e.node.coverImage?.large ?? null,
        relation: e.relationType,
        status: e.node.status,
      }));
    const result = { episodes, seasons };
    extraCache.set(id, { at: Date.now(), data: result });
    return result;
  } catch (e) {
    log.warn("detailExtra failed", id, String(e));
    return { episodes: [], seasons: [] };
  }
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
