import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { DbShape, Title, DownloadJob, UserRecord, SessionRecord, InviteRecord, SmtpSettings, WatchToken } from "./types.js";

const log = logger("db");

/**
 * Tiny persistent JSON store with atomic writes and a serialized write queue.
 * Plenty for a single-user personal media app; swap for SQLite if it grows.
 */
class Store {
  private path = join(config.dataDir, "db.json");
  private data: DbShape = { titles: [], jobs: [], users: [], sessions: [], invites: [], settings: {}, watch: {} };
  private writing: Promise<void> = Promise.resolve();
  private loaded = false;

  async init(): Promise<void> {
    await fs.mkdir(config.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.path, "utf8");
      this.data = JSON.parse(raw);
      this.data.titles ??= [];
      this.data.jobs ??= [];
      this.data.users ??= [];
      this.data.sessions ??= [];
      this.data.invites ??= [];
      this.data.settings ??= {};
      this.data.watch ??= {};
      // Migrate legacy role "admin" -> "owner".
      let migrated = false;
      for (const u of this.data.users) {
        if ((u.role as string) === "admin") { u.role = "owner"; migrated = true; }
      }
      if (migrated) await this.flush();
    } catch (e) {
      // Only a MISSING file means a fresh install. Anything else (a file
      // that exists but will not parse) used to land here too and was then
      // overwritten with an empty database: every user and title gone, and
      // with no users the setup page would hand the owner account to
      // whoever opened it first. Refuse to start instead and leave the file.
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.error("db.json exists but could not be read; refusing to start rather than overwrite it", String(e));
        throw e;
      }
      log.info("no db found, starting fresh at", this.path);
      await this.flush();
    }
    this.loaded = true;
  }

  /** A write that is queued but has not started yet; later callers share it. */
  private queued: Promise<void> | null = null;

  private flush(): Promise<void> {
    // Coalesced: a queued write serializes the data when it STARTS, so it
    // already carries every change made before then and any caller arriving
    // meanwhile can simply share it. Every call used to append its own full
    // rewrite of the ~2 MB file, and a download's progress ticks queued them
    // faster than they drained.
    if (this.queued) return this.queued;
    // Serialize writes so concurrent callers can't corrupt the file. The
    // .catch(() => {}) is load-bearing: without it one failed write would
    // leave `this.writing` rejected and every later flush would silently skip.
    const run = this.writing.catch(() => {}).then(async () => {
      this.queued = null; // changes from here on need the next write
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.path);
    });
    this.queued = run;
    this.writing = run.catch((e) => log.error("flush failed", String(e)));
    return run;
  }

  private assert(): void {
    if (!this.loaded) throw new Error("db not initialized");
  }

  // --- titles ---------------------------------------------------------------
  titles(): Title[] {
    this.assert();
    return this.data.titles;
  }
  getTitle(id: number): Title | undefined {
    return this.data.titles.find((t) => t.id === id);
  }
  async upsertTitle(t: Title): Promise<Title> {
    this.assert();
    const idx = this.data.titles.findIndex((x) => x.id === t.id);
    if (idx >= 0) this.data.titles[idx] = t;
    else this.data.titles.push(t);
    await this.flush();
    return t;
  }
  async removeTitle(id: number): Promise<void> {
    this.data.titles = this.data.titles.filter((t) => t.id !== id);
    this.data.jobs = this.data.jobs.filter((j) => j.titleId !== id);
    await this.flush();
  }

  // --- jobs -----------------------------------------------------------------
  jobs(): DownloadJob[] {
    return this.data.jobs;
  }
  getJob(id: string): DownloadJob | undefined {
    return this.data.jobs.find((j) => j.id === id);
  }
  async upsertJob(j: DownloadJob): Promise<DownloadJob> {
    const idx = this.data.jobs.findIndex((x) => x.id === j.id);
    if (idx >= 0) this.data.jobs[idx] = j;
    else this.data.jobs.push(j);
    await this.flush();
    return j;
  }
  /** Replace the job list in memory; persisted by the next write. */
  replaceJobs(jobs: DownloadJob[]): void {
    this.data.jobs = jobs;
  }
  async removeJob(id: string): Promise<void> {
    this.data.jobs = this.data.jobs.filter((j) => j.id !== id);
    await this.flush();
  }

  // --- users ----------------------------------------------------------------
  users(): UserRecord[] {
    return this.data.users;
  }
  getUser(id: string): UserRecord | undefined {
    return this.data.users.find((u) => u.id === id);
  }
  getUserByName(username: string): UserRecord | undefined {
    const n = username.toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === n);
  }
  async upsertUser(u: UserRecord): Promise<UserRecord> {
    const idx = this.data.users.findIndex((x) => x.id === u.id);
    if (idx >= 0) this.data.users[idx] = u;
    else this.data.users.push(u);
    await this.flush();
    return u;
  }
  async removeUser(id: string): Promise<void> {
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    await this.flush();
  }

  // --- sessions ---------------------------------------------------------------
  sessions(): SessionRecord[] {
    return this.data.sessions;
  }
  getSession(token: string): SessionRecord | undefined {
    return this.data.sessions.find((s) => s.token === token);
  }
  /** A session whose PREVIOUS token is this one, while its grace is still open. */
  getSessionByPrevToken(token: string): SessionRecord | undefined {
    const now = Date.now();
    return this.data.sessions.find(
      (s) => s.prevToken === token && !!s.prevUntil && new Date(s.prevUntil).getTime() > now,
    );
  }
  async addSession(s: SessionRecord): Promise<void> {
    // Opportunistic pruning of expired sessions.
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((x) => new Date(x.expiresAt).getTime() > now);
    this.data.sessions.push(s);
    await this.flush();
  }
  /**
   * Matches `prevToken` as well as `token`. A client can legitimately arrive on
   * the token its session most recently REPLACED, during the rotation grace
   * (see getSessionByPrevToken) — and a client that failed to persist the
   * rotated cookie arrives that way on EVERY request. Matching only `token`
   * meant such a client's logout deleted nothing: the row survived with its
   * current token still valid for the full remaining TTL (30 days browser,
   * 365 TV) and the device stayed listed in Account -> Devices.
   *
   * Every match on a session token in this file must consider both.
   */
  async removeSession(token: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter(
      (s) => s.token !== token && s.prevToken !== token,
    );
    await this.flush();
  }
  /**
   * Revoke all of a user's sessions except (optionally) one to keep.
   *
   * `keepToken` matches `prevToken` too, for the same reason removeSession
   * does: a caller holding the pre-rotation token would otherwise fail to
   * match its own row and revoke the very session it is using.
   */
  async removeSessionsForUser(userId: string, keepToken?: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter(
      (s) =>
        s.userId !== userId ||
        s.token === keepToken ||
        (keepToken !== undefined && s.prevToken === keepToken),
    );
    await this.flush();
  }

  // --- invites ---------------------------------------------------------------
  invites(): InviteRecord[] {
    return this.data.invites;
  }
  getInvite(token: string): InviteRecord | undefined {
    return this.data.invites.find((i) => i.token === token);
  }
  async addInvite(i: InviteRecord): Promise<void> {
    // Prune expired/used-long-ago invites opportunistically.
    const now = Date.now();
    this.data.invites = this.data.invites.filter(
      (x) => !x.usedAt && new Date(x.expiresAt).getTime() > now,
    );
    this.data.invites.push(i);
    await this.flush();
  }
  async removeInvite(token: string): Promise<void> {
    this.data.invites = this.data.invites.filter((i) => i.token !== token);
    await this.flush();
  }

  // --- settings --------------------------------------------------------------
  smtp(): SmtpSettings | undefined {
    return this.data.settings.smtp;
  }
  async setSmtp(s: SmtpSettings | undefined): Promise<void> {
    this.data.settings.smtp = s;
    await this.flush();
  }

  // Stable server secret for signing short-lived download tokens (generated once).
  dtokenSecret(): string {
    this.assert();
    if (!this.data.settings.dtokenSecret) {
      this.data.settings.dtokenSecret = randomBytes(32).toString("hex");
      void this.flush();
    }
    return this.data.settings.dtokenSecret;
  }

  // This install's OAuth instance key for the auth site's machine API
  // (generated once, like dtokenSecret).
  oauthInstanceKey(): string {
    this.assert();
    if (!this.data.settings.oauthInstanceKey) {
      this.data.settings.oauthInstanceKey = randomBytes(24).toString("hex");
      void this.flush();
    }
    return this.data.settings.oauthInstanceKey;
  }

  // --- watch tokens ----------------------------------------------------------
  watch(): Record<string, WatchToken> {
    this.assert();
    return this.data.watch;
  }

  /** Persist any in-place mutations made by callers. */
  async save(): Promise<void> {
    await this.flush();
  }
}

export const db = new Store();
