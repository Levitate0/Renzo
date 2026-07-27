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
    } catch {
      log.info("no db found, starting fresh at", this.path);
      await this.flush();
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    // Serialize writes so concurrent callers can't corrupt the file. The
    // .catch(() => {}) is load-bearing: without it one failed write would
    // leave `this.writing` rejected and every later flush would silently skip.
    const run = this.writing.catch(() => {}).then(async () => {
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.path);
    });
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
  async addSession(s: SessionRecord): Promise<void> {
    // Opportunistic pruning of expired sessions.
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((x) => new Date(x.expiresAt).getTime() > now);
    this.data.sessions.push(s);
    await this.flush();
  }
  async removeSession(token: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.token !== token);
    await this.flush();
  }
  /** Revoke all of a user's sessions except (optionally) one to keep. */
  async removeSessionsForUser(userId: string, keepToken?: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId || s.token === keepToken);
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
