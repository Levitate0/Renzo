import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as tracker from "./tracker.js";
import { queue, refreshTitle, availableEpisodes, peekUserEp } from "./downloader.js";
import type { Title, UserRecord } from "../types.js";
import * as selfcheck from "./selfcheck.js";
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
  scope?: "server" | "you";
  canRun?: boolean;
  checks?: selfcheck.PublicCheck[];
}

const state = {
  running: false,
  lastRun: undefined as string | undefined,
  lastQueued: 0,
  lastError: undefined as string | undefined,
  lastQueuedByUser: {} as Record<string, number>,
};

export function getStatus(user?: UserRecord): AutoDlStatus {
  // Staff see the whole server; everyone else sees THEIR OWN numbers — the global
  // union used to be shown to every account, so a user read someone else's
  // "38 tracked" as their own and had no way to tell nothing was running for them.
  const staff = user?.role === "owner" || user?.role === "manager";
  const flagged = new Set<number>();
  if (staff || !user) {
    for (const u of db.users()) (u.autoTitles ?? []).forEach((id) => flagged.add(id));
  } else {
    (user.autoTitles ?? []).forEach((id) => flagged.add(id));
  }
  return {
    enabled: config.autoDownload,
    intervalMin: config.autoDownloadIntervalMin,
    maxPerTick: config.autoDownloadMaxPerTick,
    running: state.running,
    lastRun: state.lastRun,
    lastQueued: staff || !user ? state.lastQueued : (state.lastQueuedByUser[user.id] ?? 0),
    lastError: staff || !user ? state.lastError : undefined,
    trackedTitles: flagged.size,
    scope: staff || !user ? "server" : "you",
    canRun: user?.role === "owner",
    checks: selfcheck.checksFor(user, staff),
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
  state.lastQueuedByUser = {};
  let queued = 0;
  try {
    // 1) Per-user AniList sync → each user's currently-watching ids.
    const watchingByUser = new Map<string, Set<number>>();
    for (const u of await tracker.usersWithAniList()) {
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

      // PLAN first (no enqueues): pick the eligible episodes of every target, so
      // one big backlog can't consume the whole pass before later titles are even
      // looked at — that starved a just-aired episode behind a 12-episode backfill.
      const plans: { t: Title; eps: number[] }[] = [];
      const missingMeta: number[] = [];
      for (const titleId of targets) {
        const t = db.getTitle(titleId);
        if (!t) { missingMeta.push(titleId); continue; } // reported by the self-check
        // Only refresh what can still change. A FINISHED title with a known
        // episode count cannot gain episodes, and refreshing every target every
        // pass is what was burning the AniList rate limit (429s stalled the tick).
        if (t.airingStatus !== "FINISHED" || !t.episodeCount) {
          await refreshTitle(t).catch((e) => log.warn("refresh", t.romaji, String(e)));
          await sleep(300);
        }
        // Make sure the title shows up in this user's library.
        u.library ??= [];
        if (!u.library.includes(titleId)) { u.library.push(titleId); await db.save(); }
        const avail = availableEpisodes(t);
        const eps: number[] = [];
        for (let n = 1; n <= avail && eps.length < config.autoDownloadMaxPerTick; n++) {
          const rec = peekUserEp(u, t.id, n);
          if (rec && ["downloaded", "downloading", "queued", "searching"].includes(rec.status)) continue;
          // Don't hammer a permanently-failing episode: retry at most daily.
          if (rec?.status === "failed" && Date.now() - new Date(rec.updatedAt).getTime() < 24 * 3600_000) continue;
          eps.push(n);
        }
        if (eps.length) plans.push({ t, eps });
      }
      if (missingMeta.length) log.warn("autodl: no title record for", missingMeta.join(","), "-", u.username);

      // DRAIN round-robin: one episode per title per round, so every followed show
      // makes progress each pass instead of the first one taking the whole budget.
      let userQueued = 0;
      outer:
      for (let round = 0; round < config.autoDownloadMaxPerTick; round++) {
        let progressed = false;
        for (const p of plans) {
          if (userQueued >= config.autoDownloadMaxPerTick) break outer;
          const n = p.eps[round];
          if (n === undefined) continue;
          progressed = true;
          try {
            await queue.enqueue(p.t.id, n, u.id);
            userQueued++; queued++;
            state.lastQueuedByUser[u.id] = (state.lastQueuedByUser[u.id] ?? 0) + 1;
            log.info(`queued ${p.t.romaji} E${n} for ${u.username}`);
          } catch (e) {
            // e.g. "Too many active downloads" — isolate so one user can't abort
            // the whole pass and starve everyone after them.
            log.warn("autodl enqueue", u.username, p.t.romaji, `E${n}`, String(e));
            break outer;
          }
        }
        if (!progressed) break;
      }
    }
    state.lastQueued = queued;
  } catch (e) {
    state.lastError = String(e);
    log.error("tick failed", String(e));
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
    try { selfcheck.run({ reason: "tick", lastRun: state.lastRun, bootAt }); }
    catch (e) { log.warn("selfcheck", String(e)); }
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

let bootAt = Date.now();

export function start(): void {
  bootAt = Date.now();
  // Evaluate before the early-return so "auto is on for N titles but the
  // scheduler is disabled" is actually reported instead of being invisible.
  try { selfcheck.run({ reason: "boot", lastRun: state.lastRun, bootAt }); }
  catch (e) { log.warn("selfcheck", String(e)); }
  if (!config.autoDownload) {
    log.info("auto-downloader off (set AUTO_DOWNLOAD=true to enable)");
    return;
  }
  const ms = config.autoDownloadIntervalMin * 60_000;
  setInterval(() => void tick(), ms).unref();
  setTimeout(() => void tick(), 20_000).unref(); // first pass shortly after boot
  log.info(`auto-downloader on — every ${config.autoDownloadIntervalMin}m, ≤${config.autoDownloadMaxPerTick}/tick`);
}
