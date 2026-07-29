import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as debrid from "./debrid.js";
import * as authsite from "./authsite.js";
import { availableEpisodes, peekUserEp } from "./downloader.js";
import type { UserRecord } from "../types.js";

const log = logger("selfcheck");

// ---------------------------------------------------------------------------
// Self-check: the app watching itself for the failure mode where work is
// silently dropped and nobody finds out for weeks ("auto-download is on but
// nothing ever downloads"). Deliberately READ-ONLY — it never enqueues, never
// saves the db, and never makes a network call, so it can't itself become the
// thing that breaks. Everything it needs is already in memory.
// ---------------------------------------------------------------------------

export type CheckCode =
  | "auto_without_debrid"
  | "auto_while_denied"
  | "stalled_titles"
  | "scheduler_off"
  | "scheduler_stale"
  | "no_title_record";

interface Finding {
  code: CheckCode;
  userId: string | null; // null = server-wide
  username?: string;
  message: string;
  action?: string;
  since: string;   // first time this condition was seen
  loggedAt: number;
}

/** What the API hands to the UI. */
export interface PublicCheck {
  code: CheckCode;
  scope: "you" | "server" | "user";
  user?: string;
  severity: "warn";
  since: string;
  message: string;
  action?: string;
}

const findings = new Map<string, Finding>();
// Stall detection needs two samples: how many episodes were missing last pass.
const prevMissing = new Map<string, number>();
let sawFirstRun = false;

export interface Snapshot {
  reason: "boot" | "tick";
  lastRun?: string;
  bootAt: number;
}

const keyOf = (code: CheckCode, userId: string | null) => `${code}:${userId ?? "-"}`;
const RELOG_MS = 24 * 3600_000;

function emit(now: number, out: Map<string, Finding>, f: Omit<Finding, "since" | "loggedAt">): void {
  const key = keyOf(f.code, f.userId);
  const prev = findings.get(key);
  // Same condition still true → keep the original `since`, refresh the message,
  // and stay quiet (re-warn once a day so it survives log rotation).
  if (prev) {
    const relog = now - prev.loggedAt >= RELOG_MS;
    if (relog) log.warn(f.code, f.username ? `user=${f.username}` : "", f.message);
    out.set(key, { ...prev, ...f, loggedAt: relog ? now : prev.loggedAt });
    return;
  }
  log.warn(f.code, f.username ? `user=${f.username}` : "", f.message);
  out.set(key, { ...f, since: new Date(now).toISOString(), loggedAt: now });
}

/** Recompute every check. Call on boot and at the end of each auto-downloader pass. */
export function run(s: Snapshot): void {
  const now = Date.now();
  const out = new Map<string, Finding>();

  // Titles with an in-flight job, so "queued but not started" never looks stalled.
  const busy = new Set<string>();
  for (const j of db.jobs()) {
    if (["queued", "searching", "downloading"].includes(j.status)) busy.add(`${j.userId}:${j.titleId}`);
  }

  const users = db.users().filter((u) => u.id !== "system");
  const autoUsers = users.filter((u) => (u.autoTitles?.length ?? 0) > 0);

  for (const u of users) {
    const autoCount = u.autoTitles?.length ?? 0;
    if (!autoCount) continue;

    // 1) Auto is on but the account cannot download at all. This mirrors the
    //    exact guard the tick uses, so the check can never drift from the skip.
    if (!debrid.resolveDebrid(u)) {
      emit(now, out, {
        code: "auto_without_debrid", userId: u.id, username: u.username,
        message: `Auto-download is on for ${autoCount} title(s), but this account has no debrid service connected — nothing will download. Connect Real-Debrid or AllDebrid in Settings.`,
        action: "settings:credentials",
      });
      continue; // the other per-user checks are meaningless while this is true
    }
    if (u.downloadsDenied) {
      emit(now, out, {
        code: "auto_while_denied", userId: u.id, username: u.username,
        message: `Downloads are disabled for this account, so ${autoCount} auto-download title(s) are skipped every pass. Ask an admin to re-enable downloads.`,
      });
      continue;
    }

    // 2) Auto titles that have aired episodes missing and made no progress since
    //    the previous pass, with nothing queued. Two samples, so a fresh queue
    //    never trips it.
    const stalled: string[] = [];
    const noRecord: number[] = [];
    for (const id of u.autoTitles ?? []) {
      const t = db.getTitle(id);
      if (!t) { noRecord.push(id); continue; }
      let missing = 0;
      const avail = availableEpisodes(t);
      for (let n = 1; n <= avail; n++) {
        if (peekUserEp(u, t.id, n)?.status !== "downloaded") missing++;
      }
      const k = `${u.id}:${id}`;
      const before = prevMissing.get(k);
      if (missing > 0 && !busy.has(k) && before !== undefined && missing >= before) {
        stalled.push(t.english ?? t.romaji);
      }
      prevMissing.set(k, missing);
    }
    if (stalled.length) {
      const shown = stalled.slice(0, 3).join(", ");
      emit(now, out, {
        code: "stalled_titles", userId: u.id, username: u.username,
        message: `${stalled.length} auto-download title(s) have aired episodes missing with nothing queued (${shown}${stalled.length > 3 ? ", …" : ""}). Check Downloads for failed jobs.`,
        action: "downloads",
      });
    }
    if (noRecord.length) {
      emit(now, out, {
        code: "no_title_record", userId: u.id, username: u.username,
        message: `${noRecord.length} auto-download title(s) have no metadata yet (AniList id ${noRecord.slice(0, 3).join(", ")}) and are skipped every pass.`,
      });
    }
  }

  // 3) Server-wide scheduler health.
  if (!config.autoDownload && autoUsers.length) {
    const total = autoUsers.reduce((n, u) => n + (u.autoTitles?.length ?? 0), 0);
    emit(now, out, {
      code: "scheduler_off", userId: null,
      message: `Auto-downloader is off (AUTO_DOWNLOAD=false), but ${autoUsers.length} account(s) have ${total} title(s) flagged for auto-download — nothing is picked up automatically.`,
    });
  } else if (config.autoDownload) {
    if (s.reason === "tick") sawFirstRun = true;
    const intervalMs = config.autoDownloadIntervalMin * 60_000;
    const stale = s.lastRun
      ? now - Date.parse(s.lastRun) > 2.5 * intervalMs
      : sawFirstRun === false && now - s.bootAt > intervalMs + 5 * 60_000;
    if (stale) {
      emit(now, out, {
        code: "scheduler_stale", userId: null,
        message: s.lastRun
          ? `Auto-downloader has not completed a pass since ${new Date(s.lastRun).toLocaleTimeString()} (expected every ${config.autoDownloadIntervalMin}m).`
          : `Auto-downloader has not completed its first pass (expected every ${config.autoDownloadIntervalMin}m).`,
      });
    }
  }

  // Anything gone since last time is resolved — say so once, then forget it.
  for (const [key, f] of findings) {
    if (!out.has(key)) {
      const mins = Math.round((now - Date.parse(f.since)) / 60_000);
      log.info("resolved", f.code, f.username ? `user=${f.username}` : "", `(flagged ${mins}m ago)`);
    }
  }
  findings.clear();
  for (const [k, v] of out) findings.set(k, v);
}

/** Checks visible to this caller. A normal user sees only their own + server-wide
 *  ones; staff additionally see other accounts' (named) so an admin can act. */
export function checksFor(user?: UserRecord, staff = false): PublicCheck[] {
  const out: PublicCheck[] = [];
  for (const f of findings.values()) {
    const mine = user && f.userId === user.id;
    const server = f.userId === null;
    if (mine || server) {
      out.push({ code: f.code, scope: server ? "server" : "you", severity: "warn", since: f.since, message: f.message, action: f.action });
    } else if (staff) {
      out.push({ code: f.code, scope: "user", user: f.username, severity: "warn", since: f.since, message: `${f.username}: ${f.message}` });
    }
  }
  return out;
}

/** Count for the header dot. */
export function warningCount(user?: UserRecord, staff = false): number {
  return checksFor(user, staff).length;
}
