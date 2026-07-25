import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as tracker from "./tracker.js";
import { queue, refreshTitle, availableEpisodes, peekUserEp } from "./downloader.js";
import type { UserRecord } from "../types.js";

const log = logger("autodl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AutoDlStatus {
  enabled: boolean;
  intervalMin: number;
  maxPerTick: number;
  running: boolean;
  lastRun?: string;
  lastQueued: number;
  lastError?: string;
  trackedTitles: number;
}

const state = {
  running: false,
  lastRun: undefined as string | undefined,
  lastQueued: 0,
  lastError: undefined as string | undefined,
};

export function getStatus(): AutoDlStatus {
  return {
    enabled: config.autoDownload,
    intervalMin: config.autoDownloadIntervalMin,
    maxPerTick: config.autoDownloadMaxPerTick,
    running: state.running,
    lastRun: state.lastRun,
    lastQueued: state.lastQueued,
    lastError: state.lastError,
    trackedTitles: db.titles().filter((t) => t.autoDownload).length,
  };
}

/** The account whose Real-Debrid creds fund auto-downloads (owner by default). */
function autoDownloadUser(): UserRecord | undefined {
  const admins = db.users().filter((u) => u.role === "admin" && u.realDebridToken);
  if (admins.length) return admins[0];
  return db.users().find((u) => u.realDebridToken);
}

/**
 * One pass: sync each AniList-connected account (flags/unflags titles), then for
 * every auto-flagged title queue aired-but-missing episodes, up to the per-tick
 * cap. Downloads use the owner's Real-Debrid creds (RD is mandatory).
 */
export async function tick(): Promise<{ queued: number }> {
  if (state.running) return { queued: 0 };
  state.running = true;
  state.lastError = undefined;
  let queued = 0;
  try {
    // Sync AniList watching lists; retire tracker flags for shows nobody is
    // watching anymore. Users with their own token sync individually; otherwise
    // fall back to the shared token (env override or the auth site).
    const connectedUsers = tracker.usersWithAniList();
    const stillWatching = new Set<number>();
    let synced = false;
    for (const u of connectedUsers) {
      const r = await tracker.importAniList(u).catch((e) => {
        log.warn("anilist sync", u.username, String(e));
        return { imported: 0, watchingIds: [] as number[] };
      });
      r.watchingIds.forEach((id) => stillWatching.add(id));
      synced = true;
      await sleep(400); // rate-limit courtesy to AniList between accounts
    }
    if (!synced && (await tracker.anilistConnected())) {
      const r = await tracker.importAniList().catch((e) => {
        log.warn("anilist sync (shared)", String(e));
        return { imported: 0, watchingIds: [] as number[] };
      });
      r.watchingIds.forEach((id) => stillWatching.add(id));
      synced = true;
    }
    if (synced) await tracker.retireAutoFlags(stillWatching);

    const rdUser = autoDownloadUser();
    if (!rdUser) {
      state.lastError = "No account with a Real-Debrid token — auto-download idle";
      return { queued: 0 };
    }

    const targets = db.titles().filter((t) => t.autoDownload);
    for (const t of targets) {
      if (queued >= config.autoDownloadMaxPerTick) break;
      await refreshTitle(t).catch((e) => log.warn("refresh", t.romaji, String(e)));
      const avail = availableEpisodes(t);

      for (let n = 1; n <= avail && queued < config.autoDownloadMaxPerTick; n++) {
        // Auto-downloads land in the funding (owner) account's own library.
        const rec = peekUserEp(rdUser, t.id, n);
        if (rec && ["downloaded", "downloading", "queued", "searching"].includes(rec.status)) continue;
        // Don't hammer a permanently-failing episode: retry at most daily.
        if (rec?.status === "failed" && Date.now() - new Date(rec.updatedAt).getTime() < 24 * 3600_000) continue;
        await queue.enqueue(t.id, n, rdUser.id);
        queued++;
        log.info(`queued ${t.romaji} E${n}`);
      }
      await sleep(300);
    }
    state.lastQueued = queued;
  } catch (e) {
    state.lastError = String(e);
    log.error("tick failed", String(e));
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
  }
  if (queued) log.info(`tick complete — queued ${queued}`);
  return { queued };
}

export function start(): void {
  if (!config.autoDownload) {
    log.info("auto-downloader off (set AUTO_DOWNLOAD=true to enable)");
    return;
  }
  const ms = config.autoDownloadIntervalMin * 60_000;
  setInterval(() => void tick(), ms).unref();
  setTimeout(() => void tick(), 20_000).unref(); // first pass shortly after boot
  log.info(`auto-downloader on — every ${config.autoDownloadIntervalMin}m, ≤${config.autoDownloadMaxPerTick}/tick`);
}
