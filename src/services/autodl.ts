import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as tracker from "./tracker.js";
import { queue, refreshTitle, availableEpisodes, peekUserEp } from "./downloader.js";
import * as debrid from "./debrid.js";

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
  // How many distinct titles are auto-flagged across all users' own lists.
  const flagged = new Set<number>();
  for (const u of db.users()) (u.autoTitles ?? []).forEach((id) => flagged.add(id));
  return {
    enabled: config.autoDownload,
    intervalMin: config.autoDownloadIntervalMin,
    maxPerTick: config.autoDownloadMaxPerTick,
    running: state.running,
    lastRun: state.lastRun,
    lastQueued: state.lastQueued,
    lastError: state.lastError,
    trackedTitles: flagged.size,
  };
}

/**
 * One pass, PER USER — no shared Real-Debrid. For each account we sync their
 * AniList "Watching" list, union it with the titles they manually flagged
 * (user.autoTitles), and queue aired-but-missing episodes into THAT user's own
 * library using THEIR OWN Real-Debrid. Users who are download-denied or have no
 * RD token are skipped. Each user gets up to maxPerTick queued per pass (fair).
 */
export async function tick(): Promise<{ queued: number }> {
  if (state.running) return { queued: 0 };
  state.running = true;
  state.lastError = undefined;
  let queued = 0;
  try {
    // 1) Per-user AniList sync → each user's currently-watching ids.
    const watchingByUser = new Map<string, Set<number>>();
    for (const u of tracker.usersWithAniList()) {
      const r = await tracker.importAniList(u).catch((e) => {
        log.warn("anilist sync", u.username, String(e));
        return { imported: 0, watchingIds: [] as number[] };
      });
      watchingByUser.set(u.id, new Set(r.watchingIds));
      await sleep(400); // rate-limit courtesy to AniList between accounts
    }

    // 2) For each real account, download its own auto targets to its own RD.
    for (const u of db.users()) {
      if (u.id === "system") continue;
      if (u.downloadsDenied) continue;   // denied → skip entirely
      // Any debrid provider works (Real-Debrid OR AllDebrid) — this used to test
      // realDebridToken only, so AllDebrid-only accounts were skipped entirely and
      // NOTHING ever auto-downloaded for them (incl. the back catalogue of older
      // seasons, which is the tail this pass is meant to fill in).
      if (!debrid.resolveDebrid(u)) continue; // no debrid → can't fund their own downloads
      const targets = new Set<number>([...(u.autoTitles ?? []), ...(watchingByUser.get(u.id) ?? [])]);
      if (!targets.size) continue;

      let userQueued = 0;
      for (const titleId of targets) {
        if (userQueued >= config.autoDownloadMaxPerTick) break;
        const t = db.getTitle(titleId);
        if (!t) continue;
        await refreshTitle(t).catch((e) => log.warn("refresh", t.romaji, String(e)));
        // Make sure the title shows up in this user's library.
        u.library ??= [];
        if (!u.library.includes(titleId)) { u.library.push(titleId); await db.save(); }
        const avail = availableEpisodes(t);
        let capped = false;
        for (let n = 1; n <= avail && userQueued < config.autoDownloadMaxPerTick; n++) {
          const rec = peekUserEp(u, t.id, n);
          if (rec && ["downloaded", "downloading", "queued", "searching"].includes(rec.status)) continue;
          // Don't hammer a permanently-failing episode: retry at most daily.
          if (rec?.status === "failed" && Date.now() - new Date(rec.updatedAt).getTime() < 24 * 3600_000) continue;
          try {
            await queue.enqueue(t.id, n, u.id);
            userQueued++; queued++;
            log.info(`queued ${t.romaji} E${n} for ${u.username}`);
          } catch (e) {
            // e.g. "Too many active downloads" — isolate so one user can't abort
            // the whole pass and starve everyone after them.
            log.warn("autodl enqueue", u.username, t.romaji, `E${n}`, String(e));
            capped = true;
            break;
          }
        }
        await sleep(300);
        if (capped) break; // move on to the next user
      }
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

/**
 * One-time migration: the old model flagged auto-download on the shared Title
 * record. Move MANUAL flags (not tracker-derived) onto the owner's per-user
 * autoTitles so their auto-downloads keep working, then clear the legacy
 * title-level flags (tracker-derived flags are recomputed from Watching lists).
 */
export async function migrateAutoFlags(): Promise<void> {
  const owner = db.users().find((u) => u.role === "owner" && u.id !== "system")
    ?? db.users().find((u) => u.id !== "system");
  let changed = false;
  let moved = 0;
  for (const t of db.titles()) {
    if (t.autoDownload && !t.autoFromTracker && owner) {
      owner.autoTitles ??= [];
      if (!owner.autoTitles.includes(t.id)) { owner.autoTitles.push(t.id); moved++; }
    }
    if (t.autoDownload !== undefined || t.autoFromTracker !== undefined) {
      t.autoDownload = undefined;
      t.autoFromTracker = undefined;
      changed = true;
    }
  }
  if (changed) {
    await db.save();
    if (moved) log.info(`migrated ${moved} legacy auto-flag(s) to ${owner?.username}'s autoTitles`);
  }
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
