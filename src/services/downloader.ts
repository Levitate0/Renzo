import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import type { Title, EpisodeRecord, DownloadJob, TorrentResult, UserRecord } from "../types.js";
import * as anilist from "./anilist.js";
import * as torrents from "./torrents.js";
import * as rd from "./realdebrid.js";
import * as debrid from "./debrid.js";
import type { DebridApi } from "./debrid.js";
import * as library from "./library.js";
import * as captions from "./captions.js";
import * as jellyfin from "./jellyfin.js";

const log = logger("downloader");

// ---------------------------------------------------------------------------
// Title / episode helpers
// ---------------------------------------------------------------------------
export async function getOrCreateTitle(anilistId: number): Promise<Title> {
  const existing = db.getTitle(anilistId);
  if (existing) return existing;
  const media = await anilist.getById(anilistId).catch((e) => {
    if (String(e).includes("anilist_unavailable")) throw new Error("AniList is rate-limiting right now — try again in a moment");
    throw e;
  });
  if (!media) throw new Error(`AniList id ${anilistId} not found`);
  return db.upsertTitle(anilist.toTitle(media));
}

// Download state is isolated PER USER (UserRecord.eps), keyed "titleId:ep".
// Title objects only hold shared AniList metadata.
function epKey(titleId: number, num: number): string {
  return `${titleId}:${num}`;
}
function getUserEp(user: UserRecord, titleId: number, num: number): EpisodeRecord {
  user.eps ??= {};
  const k = epKey(titleId, num);
  let ep = user.eps[k];
  if (!ep) {
    ep = { number: num, status: "wanted", updatedAt: new Date().toISOString() };
    user.eps[k] = ep;
  }
  return ep;
}
export function peekUserEp(user: UserRecord, titleId: number, num: number): EpisodeRecord | undefined {
  return user.eps?.[epKey(titleId, num)];
}
export function userDownloadedCount(user: UserRecord, titleId: number): number {
  const prefix = `${titleId}:`;
  return Object.entries(user.eps ?? {}).filter(([k, e]) => k.startsWith(prefix) && e.status === "downloaded").length;
}

// ---------------------------------------------------------------------------
// Folders (per-user named collections; physical on disk)
// ---------------------------------------------------------------------------
export const DEFAULT_FOLDER = "Library";
export function userFolders(user: UserRecord): string[] {
  return user.folders?.length ? user.folders : [DEFAULT_FOLDER];
}
export function folderOf(user: UserRecord, titleId: number): string {
  return user.titleFolder?.[String(titleId)] ?? userFolders(user)[0];
}

/** The user's chosen release group for a title (applied to all eps/seasons). */
export function providerFor(user: UserRecord, titleId: number): string | undefined {
  return user.titleProvider?.[String(titleId)];
}

/** Last episode the user finished (for "up next"). */
export function watchedEp(user: UserRecord, titleId: number): number {
  return user.progress?.[String(titleId)] ?? 0;
}
export function setWatched(user: UserRecord, titleId: number, episode: number): void {
  user.progress ??= {};
  user.progress[String(titleId)] = Math.max(user.progress[String(titleId)] ?? 0, episode);
}
/** Next episode number to watch, or null if caught up. */
export function upNextFor(user: UserRecord, t: Title): number | null {
  const avail = availableEpisodes(t);
  const w = watchedEp(user, t.id);
  if (t.type === "movie") return avail >= 1 && w < 1 ? 1 : null;
  return avail > w ? w + 1 : null;
}

/** List available release-group providers for a title (for the picker). */
export async function listProviders(anilistId: number): Promise<torrents.ProviderInfo[]> {
  const t = await getOrCreateTitle(anilistId);
  return torrents.listProviders(t);
}

/** Refresh title metadata from AniList (episode count, airing state, art). */
export async function refreshTitle(t: Title): Promise<Title> {
  const media = await anilist.getById(t.id);
  if (media) {
    const fresh = anilist.toTitle(media);
    Object.assign(t, fresh, {
      addedAt: t.addedAt,
      episodes: t.episodes,
      autoDownload: t.autoDownload,
      autoFromTracker: t.autoFromTracker,
    });
    await db.upsertTitle(t);
  }
  return t;
}

/** How many episodes have actually aired (movies = 1). */
export function availableEpisodes(t: Title): number {
  if (t.type === "movie") return t.airingStatus === "NOT_YET_RELEASED" ? 0 : 1;
  // nextAiringEpisode === 1 means the premiere hasn't aired: 0 available.
  if (t.nextAiringEpisode) return t.nextAiringEpisode - 1;
  if (t.airingStatus === "NOT_YET_RELEASED") return 0;
  return t.episodeCount ?? 0;
}

/** A debrid provider (Real-Debrid or AllDebrid) is mandatory: none -> hard stop. */
export function requireDebrid(user: UserRecord | undefined): debrid.Resolved {
  const d = debrid.resolveDebrid(user);
  if (!d) throw new Error("realdebrid_required"); // frontend maps this to "connect a debrid service"
  return d;
}
/** Back-compat presence check — any debrid provider connected. */
export function requireToken(user: UserRecord | undefined): string {
  return requireDebrid(user).token;
}

async function candidatesFor(t: Title, episode: number, preferredGroup?: string): Promise<TorrentResult[]> {
  if (t.type === "movie") return torrents.findForMovie(t, preferredGroup);
  const single = await torrents.findForEpisode(t, episode, preferredGroup);
  if (single.length) return single;
  return torrents.findBatch(t, preferredGroup); // fall back to a season pack that contains it
}

// ---------------------------------------------------------------------------
// Resolve a playable source: local file if we have it, else Real-Debrid link
// ---------------------------------------------------------------------------
export interface ResolvedStream {
  source: "local" | "realdebrid" | "alldebrid";
  url: string;
  filename: string;
  subtitles: { id: string; label: string; lang: string }[];
  downloading?: DownloadJob;
}

// Short-lived cache of resolved streams so the player can prefetch the next
// episode and make in-player transitions instant (the real play reuses the
// warmed link instead of re-resolving through Real-Debrid).
const streamCache = new Map<string, { at: number; data: ResolvedStream }>();
const STREAM_TTL_MS = 8 * 60_000;
function cacheStream(key: string, data: ResolvedStream): ResolvedStream {
  streamCache.set(key, { at: Date.now(), data });
  return data;
}
/** Drop cached stream(s) for a user's title — one episode or all of them. */
export function invalidateStream(userId: string, titleId: number, episode?: number): void {
  if (episode != null) { streamCache.delete(`${userId}:${titleId}:${episode}`); return; }
  const prefix = `${userId}:${titleId}:`;
  for (const k of [...streamCache.keys()]) if (k.startsWith(prefix)) streamCache.delete(k);
}
// A cached entry is only reusable if it still reflects reality: a cached local
// file must still exist at that exact path (guards folder moves / deletes), and
// a cached RD link is stale once the episode is available locally (prefer the
// local handoff instead of continuing to stream from Real-Debrid).
async function cachedStillValid(data: ResolvedStream, ep: EpisodeRecord, userId: string): Promise<boolean> {
  if (data.source === "local") {
    if (!ep.filePath) return false;
    const expected = `/files/${ep.filePath.split("/").map(encodeURIComponent).join("/")}`;
    return data.url === expected && (await library.exists(library.userAbs(userId, ep.filePath)));
  }
  return !(ep.status === "downloaded" && ep.filePath);
}

export async function resolveStream(anilistId: number, episode: number, user: UserRecord): Promise<ResolvedStream> {
  const t = await getOrCreateTitle(anilistId);
  const ep = getUserEp(user, anilistId, episode);
  const cacheKey = `${user.id}:${anilistId}:${episode}`;
  const cached = streamCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STREAM_TTL_MS && (await cachedStillValid(cached.data, ep, user.id))) {
    return cached.data;
  }
  streamCache.delete(cacheKey); // expired or no longer valid -> re-resolve below
  log.info(`▶ play ${t.romaji} E${episode} (${user.username})`);

  // 1) Already in MY library -> serve MY local file (Crunchyroll-style handoff).
  if (ep.status === "downloaded" && ep.filePath && (await library.exists(library.userAbs(user.id, ep.filePath)))) {
    // The release's own (usually English) subtitles: extract them lazily on first
    // play so episodes downloaded before this feature also get them; cached on ep.
    if (ep.subs === undefined || ep.subsV !== captions.SUBS_VERSION) {
      try {
        const emb = await captions.extractEmbedded(library.userAbs(user.id, ep.filePath));
        const relBase = ep.filePath.replace(/\.[^.]+$/, "");
        ep.subs = emb.map((e) => ({ file: relBase + e.suffix, lang: e.lang, label: e.label }));
      } catch (e) { ep.subs = []; log.warn("extract embedded", String(e)); }
      ep.subsV = captions.SUBS_VERSION;
      await db.save();
    }
    const localSubs = (ep.subs ?? []).map((s) => ({
      id: Buffer.from(`local::${s.file}`).toString("base64url"), label: s.label, lang: s.lang,
    }));
    return cacheStream(cacheKey, {
      source: "local",
      url: `/files/${ep.filePath.split("/").map(encodeURIComponent).join("/")}`,
      filename: ep.filePath.split("/").pop() ?? "",
      // Extracted release subs (English) first, then Jimaku (Japanese) as a fallback.
      subtitles: [...localSubs, ...await subtitleList(anilistId, episode, user.jimakuKey)],
      downloading: activeJobFor(anilistId, episode, user.id),
    });
  }

  // 2) Otherwise resolve an instant debrid stream — mandatory: all torrent traffic
  // goes through the user's debrid account, never their own IP. Skips the
  // per-title lock so playback stays responsive during a season grab.
  const dbr = requireDebrid(user);
  const link = await resolveDebridLinkInner(dbr.api, dbr.token, t, ep, 45_000, undefined, user);
  await db.save();
  return cacheStream(cacheKey, {
    source: dbr.name,
    url: link.download,
    filename: link.filename,
    subtitles: await subtitleList(anilistId, episode, user.jimakuKey), // use the user's key while streaming too
    downloading: activeJobFor(anilistId, episode, user.id),
  });
}

// Serialize RD preparation per title so concurrent episode jobs (e.g. a season
// grab) don't add duplicate torrents; the first job's batch is shared with the
// rest via ep.rdTorrentId (see the sibling-sharing block below).
const titleLocks = new Map<string, Promise<unknown>>();
async function withTitleLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = titleLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const guard = run.catch(() => {});
  titleLocks.set(key, guard);
  try {
    return await run;
  } finally {
    if (titleLocks.get(key) === guard) titleLocks.delete(key);
  }
}

/** Prepare (or reuse) a debrid torrent and return the direct link for the episode. */
function resolveDebridLink(
  api: DebridApi,
  token: string,
  t: Title,
  ep: EpisodeRecord,
  timeoutMs: number,
  wantedEpisodes: number[] | undefined,
  user: UserRecord,
): Promise<rd.RdLink> {
  // Lock per (user,title): one user's season grab shouldn't block another's playback.
  return withTitleLock(`${user.id}:${t.id}`, () => resolveDebridLinkInner(api, token, t, ep, timeoutMs, wantedEpisodes, user));
}

async function resolveDebridLinkInner(
  api: DebridApi,
  token: string,
  t: Title,
  ep: EpisodeRecord,
  timeoutMs: number,
  wantedEpisodes: number[] | undefined,
  user: UserRecord,
): Promise<rd.RdLink> {
  if (!token) throw new Error("No debrid service connected — add Real-Debrid or AllDebrid in Settings");
  // Reuse a previously prepared debrid torrent when possible (id is provider-specific;
  // a stale id from a switched provider just fails getInfo and we re-resolve).
  if (ep.rdTorrentId) {
    try {
      const info = await api.getInfo(token, ep.rdTorrentId);
      if (info.status === "downloaded") {
        return await api.resolveEpisodeLink(token, info, t.type === "movie" ? undefined : ep.number);
      }
    } catch {
      ep.rdTorrentId = undefined;
    }
  }

  const preferredGroup = providerFor(user, t.id);
  const list = await candidatesFor(t, ep.number, preferredGroup);
  if (!list.length) {
    log.warn(`no torrents for ${t.romaji} E${ep.number}`);
    throw new Error("No torrents found for this title/episode");
  }
  log.info(`${t.romaji} E${ep.number}: ${list.length} candidates${preferredGroup ? ` (provider: ${preferredGroup})` : ""}, top: [${list[0].source}] ${list[0].title.slice(0, 54)}`);

  let lastErr: unknown;
  // Try more candidates so DMCA'd (RD 451 infringing_file) or uncached releases
  // are skipped for the next available one.
  for (const cand of list.slice(0, 10)) {
    try {
      const info = await api.addAndPrepare(token, cand.magnet, {
        episode: t.type === "movie" ? undefined : ep.number,
        // Download jobs select every still-wanted episode a batch contains, so
        // one debrid torrent serves the whole season grab (sibling sharing below).
        episodes: t.type === "movie" ? undefined : wantedEpisodes,
        timeoutMs,
      });
      if (info.status !== "downloaded") {
        await api.deleteTorrent(token, info.id);
        continue; // not cached / still downloading — try the next candidate
      }
      ep.rdTorrentId = info.id;
      ep.magnet = cand.magnet;
      ep.updatedAt = new Date().toISOString();
      log.info(`✓ debrid ready: [${cand.releaseGroup ?? cand.source}] ${cand.resolution || "?"}p — ${cand.title.slice(0, 54)}`);

      // Sibling sharing: if this torrent is a batch, point every other episode
      // in THIS user's library at the same RD torrent so their jobs skip search.
      const selected = info.files.filter((f) => f.selected === 1);
      if (t.type === "series" && selected.length > 1) {
        for (const f of selected) {
          const n = torrents.parseEpisode(f.path);
          if (n && n !== ep.number) {
            const sib = getUserEp(user, t.id, n);
            if (sib.status !== "downloaded" && !sib.rdTorrentId) {
              sib.rdTorrentId = info.id;
              sib.magnet = cand.magnet;
              sib.updatedAt = new Date().toISOString();
            }
          }
        }
      }
      return await api.resolveEpisodeLink(token, info, t.type === "movie" ? undefined : ep.number);
    } catch (e) {
      lastErr = e;
      log.warn("candidate failed", cand.title, String(e));
    }
  }
  throw new Error(
    `Could not get an instant stream (nothing cached on your debrid service yet). ${lastErr ? String(lastErr) : ""}`.trim(),
  );
}

// ---------------------------------------------------------------------------
// Background download queue
// ---------------------------------------------------------------------------
class DownloadQueue {
  private pending: string[] = [];
  private active = new Set<string>();

  async resume(): Promise<void> {
    for (const j of db.jobs()) {
      if (j.status === "queued" || j.status === "downloading" || j.status === "searching") {
        j.status = "queued";
        this.pending.push(j.id);
      }
    }
    // Reconcile orphans: an episode stuck in an active status with no matching
    // job (crash between the two writes) would otherwise be skipped forever.
    for (const u of db.users()) {
      for (const [k, ep] of Object.entries(u.eps ?? {})) {
        if (!["queued", "searching", "downloading"].includes(ep.status)) continue;
        const titleId = Number(k.split(":")[0]);
        const hasJob = db.jobs().some(
          (j) => j.userId === u.id && j.titleId === titleId && j.episode === ep.number &&
            ["queued", "searching", "downloading"].includes(j.status),
        );
        if (!hasJob) {
          ep.status = "wanted";
          ep.updatedAt = new Date().toISOString();
        }
      }
    }
    await db.save();
    this.pump();
  }

  private findActive(anilistId: number, episode: number, userId: string): DownloadJob | undefined {
    return db.jobs().find(
      (j) => j.userId === userId && j.titleId === anilistId && j.episode === episode &&
        ["queued", "searching", "downloading"].includes(j.status),
    );
  }

  private static readonly MAX_ACTIVE_PER_USER = 100;

  async enqueue(anilistId: number, episode: number, userId: string): Promise<DownloadJob> {
    const user = db.getUser(userId);
    if (!user) throw new Error("unknown user");
    await getOrCreateTitle(anilistId); // ensure shared metadata exists
    const ep = getUserEp(user, anilistId, episode);
    const early = this.findActive(anilistId, episode, userId);
    if (early) return early;

    // Bound shared-disk / RD abuse: cap simultaneous active jobs per user.
    const activeForUser = db.jobs().filter(
      (j) => j.userId === userId && ["queued", "searching", "downloading"].includes(j.status),
    ).length;
    if (activeForUser >= DownloadQueue.MAX_ACTIVE_PER_USER) {
      throw new Error(`Too many active downloads (max ${DownloadQueue.MAX_ACTIVE_PER_USER}) — wait for some to finish`);
    }

    ep.status = "queued";
    ep.updatedAt = new Date().toISOString();
    await db.save();

    // Re-check after the await: two concurrent enqueues for the same episode
    // could both pass the early check. The check + insert below happen with no
    // await between them, so they're atomic on the event loop.
    const existing = this.findActive(anilistId, episode, userId);
    if (existing) return existing;

    const job: DownloadJob = {
      id: randomUUID(),
      titleId: anilistId,
      userId,
      episode,
      status: "queued",
      progress: 0,
      magnet: ep.magnet ?? "",
      rdTorrentId: ep.rdTorrentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    void db.upsertJob(job);
    this.pending.push(job.id);
    this.pump();
    return job;
  }

  // Move a queued job to the front of the line ("Download now"). No-op if it's
  // already active (can't preempt) or unknown. Returns true if it's now next up.
  prioritize(jobId: string): boolean {
    const i = this.pending.indexOf(jobId);
    if (i < 0) return false;
    if (i > 0) { this.pending.splice(i, 1); this.pending.unshift(jobId); }
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.active.size < config.downloadConcurrency && this.pending.length) {
      const id = this.pending.shift()!;
      this.active.add(id);
      this.run(id).finally(() => {
        this.active.delete(id);
        this.pump();
      });
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = db.getJob(jobId);
    if (!job) return;
    const t = db.getTitle(job.titleId);
    if (!t) return void (await this.fail(job, "title missing"));
    const user = db.getUser(job.userId);
    if (!user) return void (await this.fail(job, "account removed"));
    const dbr = debrid.resolveDebrid(user);
    if (!dbr) return void (await this.fail(job, "No debrid service connected for this account"));
    const ep = getUserEp(user, job.titleId, job.episode);

    try {
      await this.update(job, { status: "searching", message: `Finding & preparing on ${dbr.name === "alldebrid" ? "AllDebrid" : "Real-Debrid"}…` });
      // Every still-wanted episode in THIS user's library: if we prepare a batch,
      // select them all so this user's sibling jobs reuse the same RD torrent.
      const avail = availableEpisodes(t);
      const wanted: number[] = [];
      for (let n = 1; n <= avail; n++) {
        if (peekUserEp(user, t.id, n)?.status !== "downloaded") wanted.push(n);
      }
      if (!wanted.includes(job.episode)) wanted.push(job.episode);

      const link = await resolveDebridLink(dbr.api, dbr.token, t, ep, 8 * 60_000, wanted, user); // allow the debrid time to cache
      await db.save();

      const folder = folderOf(user, t.id);
      const { abs, rel } = library.targetFor(user.id, folder, t, job.episode, link.filename);
      await this.update(job, { status: "downloading", message: "Downloading to library…", progress: 0 });
      ep.status = "downloading";
      await db.save();

      let lastPersist = 0;
      await library.downloadTo(link.download, abs, async (frac) => {
        job.progress = frac;
        ep.progress = frac;
        const now = Date.now();
        if (now - lastPersist > 1500) {
          lastPersist = now;
          await db.upsertJob(job).catch(() => {});
        }
      });

      ep.status = "downloaded";
      ep.filePath = rel;
      ep.progress = 1;
      ep.updatedAt = new Date().toISOString();
      await db.save();
      invalidateStream(job.userId, job.titleId, job.episode); // serve the local file now, not the stale RD link

      // Post-processing: artwork, captions (per-user dir), Jellyfin scan (best-effort).
      await library.saveArtwork(user.id, folder, t).catch(() => {});
      await saveCaptionsNextTo(t, job.episode, abs, user.jimakuKey).catch((e) => log.warn("captions", String(e)));
      // Extract the release's embedded (usually English) subtitles now so they're
      // ready at first play (resolveStream falls back to lazy extraction otherwise).
      try {
        const emb = await captions.extractEmbedded(abs);
        const relBase = rel.replace(/\.[^.]+$/, "");
        ep.subs = emb.map((e) => ({ file: relBase + e.suffix, lang: e.lang, label: e.label }));
        ep.subsV = captions.SUBS_VERSION;
        await db.save();
      } catch (e) { log.warn("extract embedded", String(e)); }
      await jellyfin.triggerScan().catch(() => {});

      await this.update(job, { status: "downloaded", message: "Done", progress: 1, filePath: rel });
      log.info(`downloaded ${t.romaji} E${job.episode} for ${user.username}`);
    } catch (e) {
      ep.status = "failed";
      ep.updatedAt = new Date().toISOString();
      await db.save().catch(() => {});
      await this.fail(job, String(e));
    }
  }

  private async update(job: DownloadJob, patch: Partial<DownloadJob>): Promise<void> {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await db.upsertJob(job);
  }
  private async fail(job: DownloadJob, message: string): Promise<void> {
    log.error("job failed", job.id, message);
    await this.update(job, { status: "failed", message });
  }
}

export const queue = new DownloadQueue();

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------
async function subtitleList(anilistId: number, episode: number, key?: string) {
  try {
    const subs = await captions.findSubtitles(anilistId, episode, key);
    return subs.map((s) => ({ id: s.id, label: s.label, lang: s.lang }));
  } catch (e) {
    log.warn("subtitle search", String(e));
    return [];
  }
}

/** Auto-download captions next to the video for Jellyfin + offline use. */
async function saveCaptionsNextTo(t: Title, episode: number, videoAbs: string, key?: string): Promise<void> {
  const subs = await captions.findSubtitles(t.id, episode, key);
  const base = videoAbs.replace(/\.[^.]+$/, "");
  const seen = new Set<string>();
  for (const s of subs) {
    if (seen.has(s.lang)) continue; // one per language is enough
    try {
      const vtt = await captions.fetchAsVtt(s.id);
      await fs.writeFile(`${base}.${s.lang}.vtt`, vtt);
      seen.add(s.lang);
    } catch (e) {
      log.warn("save caption", String(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Season grab — enqueue every missing aired episode; jobs coordinate through
// the per-title lock + sibling sharing, so a season pack is prepared once.
// ---------------------------------------------------------------------------
export async function downloadSeason(anilistId: number, user: UserRecord): Promise<{ queued: number; episodes: number[] }> {
  requireToken(user);
  let t = await getOrCreateTitle(anilistId);
  if (t.type === "series" && (!t.episodeCount || t.airingStatus === "RELEASING")) {
    t = await refreshTitle(t); // make sure the aired-episode count is current
  }
  const total = availableEpisodes(t);
  if (!total) throw new Error("Episode count unknown for this title (AniList has no data yet)");

  // Only count episodes actually enqueued now (skip already active/downloaded).
  const enqueued: number[] = [];
  for (let n = 1; n <= total; n++) {
    if (peekUserEp(user, anilistId, n)?.status === "downloaded") continue;
    if (activeJobFor(anilistId, n, user.id)) continue;
    await queue.enqueue(anilistId, n, user.id);
    enqueued.push(n);
  }
  log.info(`season grab: ${t.romaji} -> queued ${enqueued.length}/${total} for ${user.username}`);
  return { queued: enqueued.length, episodes: enqueued };
}

function activeJobFor(anilistId: number, episode: number, userId: string): DownloadJob | undefined {
  return db.jobs().find(
    (j) => j.userId === userId && j.titleId === anilistId && j.episode === episode &&
      ["queued", "searching", "downloading"].includes(j.status),
  );
}
