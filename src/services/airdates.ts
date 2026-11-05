import { db } from "../db.js";
import { logger } from "../logger.js";
import type { Title } from "../types.js";
import { airingSchedule } from "./anilist.js";
import { malEpisodeAirDates } from "./mal.js";

// Each episode's air date for the episode lists (title page, player), as
// "YYYY-MM-DD": the Japanese broadcast date, the one MyAnimeList shows. MAL is
// asked first. AniList's broadcast schedule fills in what MAL hasn't dated
// yet, usually the newest episode and the upcoming ones. Stored on the title,
// so a restart doesn't ask again.
const log = logger("airdates");

/** A finished show's dates don't move; an airing one gains a date a week. */
const FRESH_FINISHED_MS = 7 * 24 * 3600_000;
const FRESH_AIRING_MS = 6 * 3600_000;
/** A failed fetch is retried after this, not on every page view. */
const RETRY_MS = 30 * 60_000;

const inFlight = new Map<number, Promise<void>>();
const failedAt = new Map<number, number>();

/** airingAt (unix seconds) as the date in Japan, where the broadcast is. */
function japanDate(airingAt: number): string {
  return new Date((airingAt + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

async function refresh(t: Title): Promise<void> {
  const [mal, anilist] = await Promise.allSettled([
    t.malId ? malEpisodeAirDates(t.malId) : Promise.resolve(new Map<number, string>()),
    airingSchedule(t.id),
  ]);
  if (mal.status === "rejected" && anilist.status === "rejected") {
    failedAt.set(t.id, Date.now());
    log.warn(`no air dates for ${t.id}: ${String(mal.reason)} / ${String(anilist.reason)}`);
    return;
  }
  const dates: Record<string, string> = {};
  if (anilist.status === "fulfilled") for (const [ep, at] of anilist.value) dates[ep] = japanDate(at);
  if (mal.status === "fulfilled") for (const [ep, day] of mal.value) dates[ep] = day;
  // A half-failed fetch keeps the dates the failed source gave last time.
  t.airDates = mal.status === "fulfilled" && anilist.status === "fulfilled"
    ? dates
    : { ...t.airDates, ...dates };
  t.airDatesAt = Date.now();
  failedAt.delete(t.id);
  await db.save();
}

function stale(t: Title): boolean {
  if (!t.airDatesAt) return true;
  const fresh = t.airingStatus === "FINISHED" ? FRESH_FINISHED_MS : FRESH_AIRING_MS;
  return Date.now() - t.airDatesAt > fresh;
}

/**
 * The title's air dates (episode number -> "YYYY-MM-DD"). Stale or missing ones
 * are refetched. The first fetch is waited for up to [waitMs]; after that the
 * stored dates answer at once and the refresh lands for the next view.
 */
export async function airDatesFor(t: Title, waitMs = 2500): Promise<Record<string, string>> {
  if (t.type === "movie" && t.airDates) return t.airDates;
  const failed = failedAt.get(t.id);
  if (stale(t) && !(failed && Date.now() - failed < RETRY_MS)) {
    let run = inFlight.get(t.id);
    if (!run) {
      run = refresh(t)
        .catch((e) => {
          failedAt.set(t.id, Date.now());
          log.warn(`air dates for ${t.id} failed: ${String(e)}`);
        })
        .finally(() => inFlight.delete(t.id));
      inFlight.set(t.id, run);
    }
    if (!t.airDates) {
      await Promise.race([run, new Promise((r) => setTimeout(r, waitMs))]);
    }
  }
  return t.airDates ?? {};
}
