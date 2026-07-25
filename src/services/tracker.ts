import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as anilist from "./anilist.js";
import * as authsite from "./authsite.js";
import type { Title, UserRecord } from "../types.js";

const log = logger("tracker");
const ANILIST = "https://graphql.anilist.co";
const MAL = "https://api.myanimelist.net/v2";

// Token resolution, highest priority first:
//   1. the user's own connected token (per-user, from Settings)
//   2. an env override (ANILIST_TOKEN / MAL_TOKEN)
//   3. the self-hosted auth site (fetched + auto-refreshed at call time)
export async function anilistTokenFor(user?: UserRecord): Promise<string> {
  return user?.anilistToken || config.anilistToken || (await authsite.getToken("anilist")) || "";
}
export async function malTokenFor(user?: UserRecord): Promise<string> {
  return user?.malToken || config.malToken || (await authsite.getToken("myanimelist")) || "";
}
export async function anilistConnected(user?: UserRecord): Promise<boolean> {
  return Boolean(await anilistTokenFor(user));
}
export async function malConnected(user?: UserRecord): Promise<boolean> {
  return Boolean(await malTokenFor(user));
}

// ---------------------------------------------------------------------------
// AniList
// ---------------------------------------------------------------------------
async function aniGql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data as T;
}

const LIST_FIELDS = `
  progress
  status
  media {
    id idMal format status episodes seasonYear genres
    nextAiringEpisode { episode }
    description(asHtml: false)
    title { romaji english native }
    synonyms
    coverImage { extraLarge large }
    bannerImage
  }`;

/**
 * Merge freshly-fetched AniList metadata into the library IN PLACE — running
 * download jobs hold references to the live Title objects, so replacing them
 * would let a job's later save silently revert this update.
 */
async function mergeTitle(
  media: anilist.AniListMedia,
  opts: { watching?: boolean } = {},
): Promise<number> {
  const title = anilist.toTitle(media);
  const existing = db.getTitle(title.id);
  if (existing) {
    Object.assign(existing, title, {
      addedAt: existing.addedAt,
      episodes: existing.episodes,
      autoDownload: existing.autoDownload,
      autoFromTracker: existing.autoFromTracker,
    });
    if (opts.watching && existing.autoDownload === undefined) {
      existing.autoDownload = true;      // manual off (false) always wins
      existing.autoFromTracker = true;
    }
    await db.save();
  } else {
    await db.upsertTitle({
      ...title,
      autoDownload: opts.watching ? true : undefined,
      autoFromTracker: opts.watching ? true : undefined,
    });
  }
  return title.id;
}

/**
 * Import CURRENT/REPEATING/PLANNING anime from the linked AniList account.
 * Watching entries flag global auto-download; PLANNING entries land on the
 * importing user's watchlist (when a user record is provided). Returns the
 * set of actively-watched ids so the auto-downloader can retire flags for
 * shows that were dropped/completed on AniList.
 */
export async function importAniList(user?: UserRecord): Promise<{ imported: number; watchingIds: number[] }> {
  const token = await anilistTokenFor(user);
  if (!token) throw new Error("AniList not connected");
  const viewer = await aniGql<{ Viewer: { id: number } }>(token, `query { Viewer { id } }`, {});
  const data = await aniGql<{
    MediaListCollection: { lists: { entries: { progress: number; status: string; media: anilist.AniListMedia }[] }[] };
  }>(
    token,
    `query ($userId: Int) {
       MediaListCollection(userId: $userId, type: ANIME, status_in: [CURRENT, PLANNING, REPEATING]) {
         lists { entries { ${LIST_FIELDS} } }
       }
     }`,
    { userId: viewer.Viewer.id },
  );

  let imported = 0;
  const watchingIds: number[] = [];
  const watchlist = new Set(user?.lists?.watchlist ?? []);
  for (const list of data.MediaListCollection.lists) {
    for (const entry of list.entries) {
      const watching = entry.status === "CURRENT" || entry.status === "REPEATING";
      const id = await mergeTitle(entry.media, { watching });
      if (watching) watchingIds.push(id);
      if (entry.status === "PLANNING" && user) watchlist.add(id);
      imported++;
    }
  }
  if (user) {
    user.lists ??= {};
    user.lists.watchlist = [...watchlist];
    await db.save();
  }
  log.info(`imported ${imported} titles from AniList${user ? ` for ${user.username}` : ""}`);
  return { imported, watchingIds };
}

/**
 * Retire tracker-granted auto flags for titles nobody is watching anymore.
 * Only touches flags the tracker itself set — manual toggles are untouched.
 */
export async function retireAutoFlags(stillWatching: Set<number>): Promise<void> {
  let changed = false;
  for (const t of db.titles()) {
    if (t.autoFromTracker && t.autoDownload && !stillWatching.has(t.id)) {
      t.autoDownload = false;
      t.autoFromTracker = false;
      changed = true;
      log.info(`auto-download retired for ${t.romaji} (no longer watching)`);
    }
  }
  if (changed) await db.save();
}

async function anilistScrobble(token: string, mediaId: number, progress: number): Promise<void> {
  await aniGql(
    token,
    `mutation ($mediaId: Int, $progress: Int) {
       SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: CURRENT) { id progress }
     }`,
    { mediaId, progress },
  );
}

// ---------------------------------------------------------------------------
// MyAnimeList
// ---------------------------------------------------------------------------
export async function importMal(user?: UserRecord): Promise<{ imported: number }> {
  const token = await malTokenFor(user);
  if (!token) throw new Error("MAL not connected");
  const res = await fetch(
    `${MAL}/users/@me/animelist?status=watching&limit=100&fields=list_status`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`MAL ${res.status}`);
  const data = (await res.json()) as { data: { node: { id: number; title: string } }[] };

  // MAL doesn't give AniList ids; resolve each via an AniList search by title.
  let imported = 0;
  for (const item of data.data.slice(0, 60)) {
    try {
      const [match] = await anilist.searchAnime(item.node.title);
      if (!match) continue;
      await mergeTitle(match, { watching: true });
      imported++;
    } catch (e) {
      log.warn("mal import item", item.node.title, String(e));
    }
  }
  log.info(`imported ${imported} titles from MAL${user ? ` for ${user.username}` : ""}`);
  return { imported };
}

async function malScrobble(token: string, malId: number, episode: number): Promise<void> {
  await fetch(`${MAL}/anime/${malId}/my_list_status`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ num_watched_episodes: String(episode), status: "watching" }).toString(),
  });
}

// ---------------------------------------------------------------------------
// Unified per-user operations
// ---------------------------------------------------------------------------
export async function scrobble(title: Title, episode: number, user?: UserRecord): Promise<void> {
  const jobs: Promise<void>[] = [];
  const [aniToken, malToken] = await Promise.all([anilistTokenFor(user), malTokenFor(user)]);
  if (aniToken) {
    jobs.push(anilistScrobble(aniToken, title.id, episode).catch((e) => log.warn("anilist scrobble", String(e))));
  }
  if (malToken && title.malId) {
    jobs.push(malScrobble(malToken, title.malId, episode).catch((e) => log.warn("mal scrobble", String(e))));
  }
  await Promise.allSettled(jobs);
}

export async function importAll(user?: UserRecord): Promise<{ anilist: number; mal: number }> {
  let a = 0;
  let m = 0;
  if (await anilistConnected(user)) a = (await importAniList(user).catch(() => ({ imported: 0 }))).imported;
  if (await malConnected(user)) m = (await importMal(user).catch(() => ({ imported: 0 }))).imported;
  return { anilist: a, mal: m };
}

/** Every user with an AniList connection (for the auto-downloader's sync). */
export function usersWithAniList(): UserRecord[] {
  return db.users().filter((u) => Boolean(u.anilistToken));
}
