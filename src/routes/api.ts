import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { db } from "../db.js";
import { logger } from "../logger.js";
import * as authsite from "../services/authsite.js";
import type { AniListMedia } from "../services/anilist.js";
import * as anilist from "../services/anilist.js";
import * as rd from "../services/realdebrid.js";
import * as jellyfin from "../services/jellyfin.js";
import * as tracker from "../services/tracker.js";
import * as captions from "../services/captions.js";
import * as library from "../services/library.js";
import * as watch from "../services/watch.js";
import * as mal from "../services/mal.js";
import { queue, resolveStream, getOrCreateTitle, downloadSeason, availableEpisodes, requireToken, userDownloadedCount, peekUserEp, userFolders, folderOf, DEFAULT_FOLDER, providerFor, listProviders, upNextFor, watchedEp, setWatched, invalidateStream } from "../services/downloader.js";
import * as autodl from "../services/autodl.js";
import { requireAdmin, type AuthedRequest } from "../services/auth.js";
import { isTrackStatus } from "../services/tracker.js";
import type { UserRecord } from "../types.js";
import type { Title } from "../types.js";

const log = logger("api");
export const api = Router();

function wrap(fn: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req as AuthedRequest, res).catch((e) => {
      const msg = String(e instanceof Error ? e.message : e);
      // RD is mandatory (ISP-ban-risk prevention): surface a distinct code so
      // the UI can prompt for the token instead of showing a 500.
      if (msg === "realdebrid_required") {
        if (!res.headersSent) res.status(402).json({ error: "realdebrid_required" });
        return;
      }
      log.error(req.method, req.path, msg);
      if (!res.headersSent) res.status(500).json({ error: msg });
    });
  };
}

// --- DTO mappers -----------------------------------------------------------
function cardFromMedia(m: AniListMedia) {
  return {
    id: m.id,
    type: anilist.mediaType(m),
    title: m.title.english ?? m.title.romaji ?? m.title.native,
    year: m.seasonYear,
    poster: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    genres: (m.genres ?? []).slice(0, 3),
  };
}
function userLists(user: UserRecord | undefined, titleId: number): string[] {
  if (!user?.lists) return [];
  return Object.keys(user.lists).filter((name) => user.lists[name]?.includes(titleId));
}

function inLibrary(user: UserRecord | undefined, titleId: number): boolean {
  return Boolean(user?.library?.includes(titleId));
}

// List names become object keys — reject reserved/prototype-polluting names and
// restrict to a safe charset.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function safeListName(raw: unknown): string | null {
  const name = String(raw ?? "").trim().toLowerCase().slice(0, 40);
  if (!name || RESERVED_KEYS.has(name) || !/^[a-z0-9 _-]+$/.test(name)) return null;
  return name;
}
// Folder names keep original case (they become directory names) but stay safe.
function safeFolderName(raw: unknown): string | null {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 48);
  if (!name || RESERVED_KEYS.has(name.toLowerCase()) || !/^[A-Za-z0-9 _-]+$/.test(name)) return null;
  return name;
}

// Move a title between folders: relocate its files on disk and rewrite the
// stored per-user file paths (first path segment = the folder directory).
async function moveTitleToFolder(user: UserRecord, t: Title, from: string, to: string): Promise<void> {
  if (from !== to) await library.moveTitleDir(user.id, from, to, t).catch(() => {});
  const fromSeg = library.sanitize(from) || "Library";
  const toSeg = library.sanitize(to) || "Library";
  for (const [k, ep] of Object.entries(user.eps ?? {})) {
    if (!k.startsWith(`${t.id}:`) || !ep.filePath) continue;
    const parts = ep.filePath.split("/");
    if (parts[0] === fromSeg) { parts[0] = toSeg; ep.filePath = parts.join("/"); }
  }
  user.titleFolder ??= {};
  user.titleFolder[String(t.id)] = to;
  invalidateStream(user.id, t.id); // cached /files URLs point at the old folder
}

/** Add a title to the user's personal library (idempotent, no save). Returns
 *  true only when the title was newly added (first entry). */
function addToLibrary(user: UserRecord | undefined, titleId: number): boolean {
  if (!user) return false;
  user.library ??= [];
  if (user.library.includes(titleId)) return false;
  user.library.push(titleId);
  return true;
}

/** Block downloads for a denied user (streaming stays allowed). Returns true if
 *  the response was already sent (caller should return). */
function downloadBlocked(user: UserRecord | undefined, res: Response): boolean {
  if (user?.downloadsDenied) {
    res.status(403).json({ error: "Downloads are disabled for your account" });
    return true;
  }
  return false;
}

/** Apply this user's per-title "on add" defaults the first time a title enters
 *  their library. Best-effort — folder/auto mutate the db (caller saves);
 *  tracker sync is fire-and-forget so the add stays snappy. */
function applyAddDefaults(user: UserRecord, t: Title): void {
  const d = user.addDefaults;
  if (!d) return;
  if (d.folder && userFolders(user).includes(d.folder)) {
    user.titleFolder ??= {};
    if (!user.titleFolder[String(t.id)]) user.titleFolder[String(t.id)] = d.folder;
  }
  if (d.autoDownload && !user.downloadsDenied) {
    user.autoTitles ??= [];
    if (!user.autoTitles.includes(t.id)) user.autoTitles.push(t.id);
  }
  if (d.track && isTrackStatus(d.track) && (user.anilistToken || user.malToken)) {
    tracker.setTracking(t, user, { status: d.track }).catch((e) => log.warn("addDefaults track", t.id, String(e)));
  }
}

/**
 * Dynamic tracking status. scrobble() already marks a title "watching" as the
 * user progresses; this escalates it to "completed" the moment they've watched
 * the final episode of a FINISHED series (or a movie). A returning / RELEASING
 * series with an unwatched aired episode stays "watching". No-op without a
 * connected tracker (status lives only on AniList / MAL).
 */
async function syncWatchStatus(t: Title, user: UserRecord): Promise<void> {
  if (user.autoStatus === false) return; // per-user "Auto-update status" set to Off
  if (!user.anilistToken && !user.malToken) return;
  const finished = t.type === "movie" || t.airingStatus === "FINISHED";
  const total = t.type === "movie" ? 1 : (t.episodeCount ?? availableEpisodes(t));
  const watched = watchedEp(user, t.id);
  if (finished && total > 0 && watched >= total) {
    await tracker.setTracking(t, user, { status: "completed" }).catch((e) => log.warn("dyn-status", t.id, String(e)));
  }
}

function cardFromTitle(t: Title, user?: UserRecord) {
  return {
    id: t.id,
    type: t.type,
    title: t.english ?? t.romaji,
    year: t.year ?? null,
    poster: t.poster ?? null,
    genres: t.genres.slice(0, 3),
    inLibrary: inLibrary(user, t.id),
    lists: userLists(user, t.id),
    folder: user ? folderOf(user, t.id) : DEFAULT_FOLDER,
    downloaded: user ? userDownloadedCount(user, t.id) : 0,
    upNext: user ? upNextFor(user, t) : null,
  };
}
function detailFromTitle(t: Title, user?: UserRecord) {
  const known = t.episodeCount ?? (t.nextAiringEpisode ? t.nextAiringEpisode - 1 : undefined);
  const count = t.type === "movie" ? 1 : known ?? 12;
  // 0 aired is a real state (premiere pending); only fall back to `count` when
  // airing data is genuinely unknown.
  const hasAiringData = t.nextAiringEpisode !== undefined || t.airingStatus !== undefined;
  const aired = hasAiringData ? availableEpisodes(t) : count;
  const episodes = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const rec = user ? peekUserEp(user, t.id, n) : undefined; // MY download state only
    return {
      number: n,
      status: rec?.status ?? "wanted",
      hasFile: rec?.status === "downloaded",
      progress: rec?.progress ?? 0,
      aired: n <= aired,
    };
  });
  return {
    ...t,
    episodes: undefined,
    autoDownload: (user?.autoTitles ?? []).includes(t.id), // per-user, not the legacy title-level flag
    episodesTotal: count,
    airedEpisodes: aired,
    episodeList: episodes,
  };
}

// --- Health / status -------------------------------------------------------
api.get("/health", wrap(async (req, res) => {
  const token = req.user?.realDebridToken;
  const [acct, jf, anilistOn, malOn] = await Promise.all([
    token ? rd.accountInfo(token) : Promise.resolve(null),
    jellyfin.jellyfinConfigured() ? jellyfin.ping() : Promise.resolve("not-configured" as const),
    tracker.anilistConnected(req.user),
    tracker.malConnected(req.user),
  ]);
  res.json({
    ok: true,
    realdebrid: !token ? "not-connected" : !acct ? "invalid" : rd.isPremium(acct) ? "premium" : "not-premium",
    jellyfin: jf,
    trackers: { anilist: anilistOn, mal: malOn },
    // Where the BROWSER links AniList/MAL accounts (public host for the popup +
    // postMessage origin). Token fetching uses the internal host, not this one.
    authsite: { enabled: authsite.configured(), url: config.authsitePublicUrl },
  });
}));

// --- Discovery -------------------------------------------------------------
// Each browse row prefers AniList; if AniList is unavailable it falls back to
// MAL (Jikan) so the page still populates. MAL cards resolve to an AniList id
// on click via GET /titles/resolve.
async function browseRow(
  anilistFn: () => Promise<AniListMedia[]>,
  malFn: () => Promise<unknown[]>,
): Promise<unknown[]> {
  try {
    return (await anilistFn()).map(cardFromMedia);
  } catch (e) {
    log.warn("anilist browse failed, MAL fallback:", String(e));
    return malFn();
  }
}

api.get("/discover/trending", wrap(async (_req, res) => {
  res.json(await browseRow(anilist.trendingAnime, mal.malTrending));
}));

api.get("/discover/recommended", wrap(async (_req, res) => {
  res.json(await browseRow(anilist.recommendedAnime, mal.malRecommended));
}));

api.get("/discover/new-season", wrap(async (_req, res) => {
  res.json(await browseRow(anilist.newSeasonAnime, mal.malNewSeason));
}));

// Resolve a MyAnimeList id -> AniList id (for MAL-sourced browse cards).
api.get("/titles/resolve", wrap(async (req, res) => {
  const malId = Number(req.query.mal);
  if (!malId) return res.status(400).json({ error: "mal id required" });
  const id = await anilist.idFromMal(malId);
  if (!id) return res.status(404).json({ error: "not found" });
  res.json({ id });
}));

api.get("/discover/search", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const type = req.query.type === "movie" ? "movie" : req.query.type === "series" ? "series" : undefined;
  if (!q) return res.json([]);
  const media = await anilist.searchAnime(q, type);
  res.json(media.map(cardFromMedia));
}));

// --- Library (per-user; files & metadata are shared, membership is not) -----
api.get("/library", wrap(async (req, res) => {
  const user = req.user;
  const rawList = String(req.query.list ?? "").trim();
  const list = rawList ? safeListName(rawList) : "";
  if (rawList && !list) return res.json([]); // unknown/invalid list -> empty
  const folder = String(req.query.folder ?? "").trim(); // exact match (case-sensitive)

  const lists = user?.lists ?? {};
  const ids = new Set(list ? (Object.prototype.hasOwnProperty.call(lists, list) ? lists[list] : []) : user?.library ?? []);
  let titles = db.titles().filter((t) => ids.has(t.id));
  if (folder && user) titles = titles.filter((t) => folderOf(user, t.id) === folder);
  res.json(titles.map((t) => cardFromTitle(t, user)));
}));

// --- Folders (per-user, physical collections) ------------------------------
api.get("/folders", wrap(async (req, res) => {
  const user = req.user!;
  const folders = userFolders(user);
  const libIds = user.library ?? [];
  const counts: Record<string, number> = {};
  for (const id of libIds) {
    const f = folderOf(user, id);
    counts[f] = (counts[f] ?? 0) + 1;
  }
  res.json(folders.map((name) => ({ name, count: counts[name] ?? 0, default: name === folders[0] })));
}));

api.post("/folders", wrap(async (req, res) => {
  const user = req.user!;
  const name = safeFolderName(req.body?.name);
  if (!name) return res.status(400).json({ error: "invalid folder name" });
  user.folders ??= [DEFAULT_FOLDER];
  if (user.folders.some((f) => f.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "folder already exists" });
  }
  user.folders.push(name);
  await db.save();
  res.json({ name });
}));

api.delete("/folders/:name", wrap(async (req, res) => {
  const user = req.user!;
  const name = safeFolderName(req.params.name);
  if (!name) return res.status(400).json({ error: "invalid folder name" });
  const folders = userFolders(user);
  if (folders[0] === name) return res.status(400).json({ error: "cannot delete the default folder" });
  const target = folders[0]; // reassign contents to the default folder
  user.titleFolder ??= {};
  for (const [tid, f] of Object.entries(user.titleFolder)) {
    if (f !== name) continue;
    const t = db.getTitle(Number(tid));
    if (t) await moveTitleToFolder(user, t, name, target);
  }
  user.folders = folders.filter((f) => f !== name);
  await db.save();
  res.json({ ok: true, reassignedTo: target });
}));

// Assign a title to a folder (creates the folder if new, moves files on disk).
api.post("/titles/:id/folder", wrap(async (req, res) => {
  const user = req.user!;
  const folder = safeFolderName(req.body?.folder);
  if (!folder) return res.status(400).json({ error: "invalid folder name" });
  const t = await getOrCreateTitle(Number(req.params.id));
  user.folders ??= [DEFAULT_FOLDER];
  if (!user.folders.some((f) => f.toLowerCase() === folder.toLowerCase())) user.folders.push(folder);
  const canonical = user.folders.find((f) => f.toLowerCase() === folder.toLowerCase()) ?? folder;
  const from = folderOf(user, t.id);
  addToLibrary(user, t.id);
  if (from !== canonical) await moveTitleToFolder(user, t, from, canonical);
  await db.save();
  res.json({ id: t.id, folder: canonical });
}));

// The requesting user's named lists (watchlist / favorites / custom) + counts.
api.get("/lists", wrap(async (req: AuthedRequest, res) => {
  const counts: Record<string, number> = {};
  for (const [name, ids] of Object.entries(req.user?.lists ?? {})) {
    counts[name] = ids.length;
  }
  res.json(counts);
}));

// Toggle a title's membership in one of MY lists. Body: { list, on }
api.post("/titles/:id/lists", wrap(async (req, res) => {
  const user = req.user!;
  const t = await getOrCreateTitle(Number(req.params.id));
  const list = safeListName(req.body?.list);
  if (!list) return res.status(400).json({ error: "invalid list name" });
  user.lists ??= {};
  const cur = new Set(user.lists[list] ?? []);
  if (req.body?.on) {
    cur.add(t.id);
    if (addToLibrary(user, t.id)) applyAddDefaults(user, t); // anything you list is in your library
  } else {
    cur.delete(t.id);
  }
  if (cur.size) user.lists[list] = [...cur];
  else delete user.lists[list];
  await db.save();
  res.json({ id: t.id, lists: userLists(user, t.id), inLibrary: inLibrary(user, t.id) });
}));

api.post("/library", wrap(async (req, res) => {
  const id = Number(req.body?.anilistId ?? req.body?.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "anilistId required" });
  const t = await getOrCreateTitle(id);
  if (addToLibrary(req.user, t.id) && req.user) applyAddDefaults(req.user, t);
  await db.save();
  res.json(cardFromTitle(t, req.user));
}));

// Remove a title from MY library only (shared files/metadata are untouched).
api.delete("/library/:id", wrap(async (req, res) => {
  const user = req.user!;
  const id = Number(req.params.id);
  if (user.library) user.library = user.library.filter((x) => x !== id);
  for (const name of Object.keys(user.lists ?? {})) {
    user.lists[name] = user.lists[name].filter((x) => x !== id);
    if (!user.lists[name].length) delete user.lists[name];
  }
  watch.dropWatch(user, id); // forget this title's watch links
  await db.save();
  res.json({ ok: true });
}));

api.get("/titles/:id", wrap(async (req, res) => {
  const t = await getOrCreateTitle(Number(req.params.id));
  const extra = await anilist.detailExtra(t.id).catch(() => ({ episodes: [], seasons: [] }));
  const detail = detailFromTitle(t, req.user);
  // Merge per-episode preview thumbnails + episode titles (fallback: banner/poster).
  const episodeList = detail.episodeList.map((e) => {
    const meta = extra.episodes[e.number - 1];
    return { ...e, thumbnail: meta?.thumbnail || t.banner || t.poster || null, epTitle: meta?.title || null };
  });
  res.json({
    ...detail,
    episodeList,
    seasons: extra.seasons,
    watchedThrough: req.user ? watchedEp(req.user, t.id) : 0, // last episode marked watched
    lists: userLists(req.user, t.id),
    inLibrary: inLibrary(req.user, t.id),
    folder: req.user ? folderOf(req.user, t.id) : DEFAULT_FOLDER,
    folders: req.user ? userFolders(req.user) : [DEFAULT_FOLDER],
    provider: req.user ? providerFor(req.user, t.id) ?? null : null,
  });
}));

// --- Providers (release groups) for a title --------------------------------
api.get("/titles/:id/providers", wrap(async (req, res) => {
  res.json(await listProviders(Number(req.params.id)));
}));

// Set (or clear) MY preferred release group for a title — used for all eps/seasons.
api.post("/titles/:id/provider", wrap(async (req, res) => {
  const user = req.user!;
  const t = await getOrCreateTitle(Number(req.params.id));
  const raw = String(req.body?.group ?? "").trim().slice(0, 40);
  user.titleProvider ??= {};
  if (raw && /^[\w .\-\[\]]+$/.test(raw)) user.titleProvider[String(t.id)] = raw;
  else delete user.titleProvider[String(t.id)]; // empty/invalid -> auto
  invalidateStream(user.id, t.id); // re-resolve with the new release group
  await db.save();
  res.json({ id: t.id, provider: user.titleProvider[String(t.id)] ?? null });
}));

// --- Playback: instant stream (RD, mandatory) or local file ----------------
api.get("/titles/:id/play/:ep", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const ep = Math.max(1, Number(req.params.ep) || 1);
  const resolved = await resolveStream(id, ep, req.user!);
  res.json(resolved);
}));

// --- Watch links: per-series URL id (stable per-user if saved, else temp) ---
api.post("/titles/:id/watch", wrap(async (req, res) => {
  const user = req.user!;
  const t = await getOrCreateTitle(Number(req.params.id));
  const saved = inLibrary(user, t.id) || userLists(user, t.id).length > 0;
  const watchId = watch.watchTokenFor(user, t.id, saved);
  await db.save();
  res.json({ watchId, titleId: t.id });
}));

// Resolve a watch id -> title + resume episode (scoped to the requesting user).
api.get("/watch/:watchId", wrap(async (req, res) => {
  const user = req.user!;
  const tok = watch.resolveWatch(user, String(req.params.watchId));
  if (!tok) return res.status(404).json({ error: "watch link not found" });
  const t = await getOrCreateTitle(tok.titleId);
  res.json({ titleId: t.id, resumeEp: Math.max(1, watchedEp(user, t.id) + 1), temp: tok.temp });
}));

// --- Background download (RD mandatory) ------------------------------------
api.post("/titles/:id/download/:ep", wrap(async (req, res) => {
  const user = req.user!;
  if (downloadBlocked(user, res)) return; // staff can deny a user all downloads
  requireToken(user); // 402 realdebrid_required if not connected
  const id = Number(req.params.id);
  const ep = Math.max(1, Number(req.params.ep) || 1);
  addToLibrary(user, id);
  await db.save();
  const job = await queue.enqueue(id, ep, user.id);
  res.json(job);
}));

// --- Season grab: queue every missing aired episode ------------------------
api.post("/titles/:id/download-season", wrap(async (req, res) => {
  const user = req.user!;
  if (downloadBlocked(user, res)) return;
  const id = Number(req.params.id);
  addToLibrary(user, id);
  await db.save();
  res.json(await downloadSeason(id, user));
}));

// --- Per-title auto-download toggle (ADMIN: it's a global, owner-funded flag) --
// Per-user auto-download flag: the title downloads to THIS user's own RD on the
// schedule. Open to any user who isn't download-denied (no longer admin-only).
api.post("/titles/:id/auto", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (downloadBlocked(user, res)) return;
  const t = await getOrCreateTitle(Number(req.params.id));
  const on = Boolean(req.body?.enabled);
  const set = new Set(user.autoTitles ?? []);
  if (on) { set.add(t.id); addToLibrary(user, t.id); } else set.delete(t.id);
  user.autoTitles = [...set];
  await db.save();
  res.json({ id: t.id, autoDownload: on });
}));

// --- Auto-downloader (spends the OWNER's Real-Debrid account -> ADMIN only) ---
api.get("/autodl/status", wrap(async (_req, res) => {
  res.json(autodl.getStatus());
}));

api.post("/autodl/run", requireAdmin, wrap(async (_req, res) => {
  res.json(await autodl.tick());
}));

// --- Mark watched -> local progress + scrobble to MY trackers --------------
api.post("/titles/:id/watched/:ep", wrap(async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const ep = Math.max(1, Number(req.params.ep) || 1);
  const t = await getOrCreateTitle(id);
  setWatched(req.user!, id, ep);   // powers "up next"
  await db.save();
  await tracker.scrobble(t, ep, req.user); // progress + "watching" on the trackers
  await syncWatchStatus(t, req.user!);     // …escalate to "completed" once fully watched
  res.json({ ok: true, upNext: upNextFor(req.user!, t) });
}));

// --- Updates feed: new episodes / seasons for saved titles (anime + movies) --
api.get("/updates", wrap(async (req, res) => {
  const user = req.user!;
  const libIds = user.library ?? [];
  const inLib = new Set(libIds);
  const items: unknown[] = [];

  for (const id of libIds) {
    const t = db.getTitle(id);
    if (!t) continue;
    const avail = availableEpisodes(t);
    const w = watchedEp(user, id);
    if (t.type === "series" && avail > w) {
      items.push({ kind: "episode", id, type: "series", title: t.english ?? t.romaji, poster: t.poster,
        ep: w + 1, latest: avail, releasing: t.airingStatus === "RELEASING" });
    } else if (t.type === "movie" && avail >= 1 && w < 1) {
      items.push({ kind: "movie", id, type: "movie", title: t.english ?? t.romaji, poster: t.poster });
    }
  }

  // New seasons: sequels of saved titles that aren't in the library yet.
  const seenSeasons = new Set<number>();
  for (const id of libIds.slice(0, 20)) {
    const ex = await anilist.detailExtra(id).catch(() => ({ seasons: [] as { id: number; title: string; poster: string | null; year: number | null; relation: string; status: string | null }[] }));
    for (const s of ex.seasons) {
      if (s.relation !== "SEQUEL" || inLib.has(s.id) || seenSeasons.has(s.id)) continue;
      if (!["RELEASING", "NOT_YET_RELEASED", "FINISHED"].includes(s.status ?? "")) continue;
      seenSeasons.add(s.id);
      items.push({ kind: "season", id: s.id, type: "series", title: s.title, poster: s.poster, year: s.year,
        upcoming: s.status === "NOT_YET_RELEASED" });
    }
  }
  res.json(items);
}));

// --- Jobs (only MY jobs; admin sees all) -----------------------------------
api.get("/jobs", wrap(async (req, res) => {
  const user = req.user!;
  const jobs = db.jobs()
    .filter((j) => user.role !== "user" || j.userId === user.id)
    .filter((j) => ["queued", "searching", "downloading", "failed"].includes(j.status) ||
      Date.now() - new Date(j.updatedAt).getTime() < 60_000)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((j) => {
      const t = db.getTitle(j.titleId);
      // Don't expose internal fields (userId, rdTorrentId, magnet) to the client.
      return {
        id: j.id,
        titleId: j.titleId, // needed for the Retry button
        episode: j.episode,
        status: j.status,
        progress: j.progress,
        message: j.message,
        title: t ? t.english ?? t.romaji : `#${j.titleId}`,
        mine: j.userId === user.id,
      };
    });
  res.json(jobs);
}));

// --- Retry a failed download (re-search from scratch) ----------------------
api.post("/titles/:id/retry/:ep", wrap(async (req, res) => {
  const user = req.user!;
  if (downloadBlocked(user, res)) return; // retry also enqueues a real download — honor the deny flag
  requireToken(user);
  const id = Number(req.params.id);
  const ep = Math.max(1, Number(req.params.ep) || 1);
  const rec = peekUserEp(user, id, ep);
  if (rec) { rec.rdTorrentId = undefined; rec.status = "wanted"; await db.save(); } // fresh search
  const job = await queue.enqueue(id, ep, user.id);
  res.json(job);
}));

// --- Captions proxy: remote sub -> WebVTT ----------------------------------
api.get("/captions/:id.vtt", wrap(async (req, res) => {
  const vtt = await captions.fetchAsVtt(req.params.id);
  res.type("text/vtt").send(vtt);
}));

// --- Tracker connections (per-user tokens) ----------------------------------
api.post("/trackers/import", wrap(async (req: AuthedRequest, res) => {
  res.json(await tracker.importAll(req.user));
}));

// Per-title tracking (status / progress / score) read from + synced to trackers.
api.get("/titles/:id/tracking", wrap(async (req: AuthedRequest, res) => {
  const t = await getOrCreateTitle(Number(req.params.id));
  res.json(await tracker.getTracking(t, req.user));
}));

api.post("/titles/:id/tracking", wrap(async (req: AuthedRequest, res) => {
  const t = await getOrCreateTitle(Number(req.params.id));
  const patch: { status?: tracker.TrackStatus; progress?: number; score?: number } = {};
  const st = String(req.body?.status ?? "");
  if (tracker.isTrackStatus(st)) patch.status = st;
  if (req.body?.progress != null) patch.progress = Math.max(0, Math.floor(Number(req.body.progress) || 0));
  if (req.body?.score != null) patch.score = Math.max(0, Math.min(10, Number(req.body.score) || 0));
  await tracker.setTracking(t, req.user, patch);
  res.json(await tracker.getTracking(t, req.user)); // return the fresh synced state
}));
