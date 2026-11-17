import { Router, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as anilist from "../services/anilist.js";
import * as apikeys from "../services/apikeys.js";
import * as library from "../services/library.js";
import { mintStreamToken, userFromStreamToken } from "../services/auth.js";
import { getOrCreateTitle, resolveStream, availableEpisodes, episodeTotal, userFolders, folderOf, peekUserEp, sharedCopy } from "../services/downloader.js";
import type { UserRecord, Title } from "../types.js";

// Public API consumed by the Renzo Jellyfin plugin (catalog / search / episodes /
// stream). Every request under /api carries a PER-USER API key: it resolves to
// a specific Renzo account and streams through THAT user's Real-Debrid and their
// isolated library — no shared/owner identity. /play/:id/:ep is the one route
// outside /api: it takes a short-lived per-episode token instead of the key.
// The repo manifest + zip are served statically from public/jellyfin/.
const log = logger("jf-plugin");
export const jellyfinPluginRoutes = Router();

// The API key identifies which Renzo user this request runs as.
interface KeyedRequest extends Request {
  renzoUser?: UserRecord;
}

// Routes the legacy shared RENZO_PLUGIN_KEY may reach: the plugin's read-only
// browse + playback surface, named explicitly so a route added here later does
// not silently become reachable with an env secret nobody can rotate from the
// UI. Per-user keys are not limited by this list.
const LEGACY_KEY_ROUTES = new Set(["/groups", "/library", "/catalog", "/episodes", "/stream", "/streamurl", "/file"]);
let legacyKeyWarned = false;

function requireKey(req: Request, res: Response, next: NextFunction): void {
  // Header first: a key in the query string ends up in Jellyfin's DB, ffmpeg
  // command lines and proxy logs. ?key= stays accepted for plugin <= 1.0.3.
  const key = String(req.get("X-Renzo-Key") ?? req.query.key ?? "");
  const hit = apikeys.resolveApiKey(key);
  if (!hit) { res.status(401).json({ error: "invalid or missing Renzo API key" }); return; }
  if (hit.legacy) {
    if ((req.method !== "GET" && req.method !== "HEAD") || !LEGACY_KEY_ROUTES.has(req.path)) {
      res.status(403).json({ error: "the legacy RENZO_PLUGIN_KEY cannot use this route; use a per-user API key" });
      return;
    }
    if (!legacyKeyWarned) {
      legacyKeyWarned = true;
      log.warn("legacy RENZO_PLUGIN_KEY in use (acts as the owner): switch the plugin to a per-user API key and unset RENZO_PLUGIN_KEY");
    }
  }
  (req as KeyedRequest).renzoUser = hit.user;
  // Same per-user AniList share as the /api router (owner exempt).
  if (hit.user.role !== "owner") anilist.asUser(hit.user.id, next);
  else next();
}

function toItem(m: anilist.AniListMedia) {
  const type = anilist.mediaType(m);
  return {
    id: m.id,
    name: m.title.english || m.title.romaji || m.title.native || `#${m.id}`,
    year: m.seasonYear ?? null,
    overview: (m.description || "").replace(/<[^>]+>/g, "").trim(),
    poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
    banner: m.bannerImage || null,
    type, // "movie" | "series"
    episodes: type === "movie" ? 1 : m.episodes ?? null,
    genres: (m.genres || []).slice(0, 4),
  };
}

// Same card shape as toItem(), but from a stored Renzo Title (library items).
function toItemFromTitle(t: Title) {
  return {
    id: t.id,
    name: t.english || t.romaji || `#${t.id}`,
    year: t.year ?? null,
    overview: (t.description || "").replace(/<[^>]+>/g, "").trim(),
    poster: t.poster || null,
    banner: t.banner || null,
    type: t.type,
    episodes: t.type === "movie" ? 1 : t.episodeCount ?? null,
    genres: (t.genres || []).slice(0, 4),
  };
}

jellyfinPluginRoutes.use("/api", requireKey);

// This user's library organisation: physical folders/collections + named lists
// (watchlist, favorites, custom). The plugin turns each into a channel folder.
jellyfinPluginRoutes.get("/api/groups", (req, res) => {
  const user = (req as KeyedRequest).renzoUser!;
  const folders = userFolders(user);
  const lists = Object.keys(user.lists ?? {}).filter((n) => (user.lists[n]?.length ?? 0) > 0);
  res.json({ folders, lists });
});

// Titles in one of this user's folders (?folder=) or lists (?list=), else the
// whole library. Returns library-card items (from stored Title metadata).
jellyfinPluginRoutes.get("/api/library", (req, res) => {
  const user = (req as KeyedRequest).renzoUser!;
  const folder = String(req.query.folder ?? "");
  const list = String(req.query.list ?? "");
  let ids: number[] = [];
  if (list) ids = user.lists?.[list] ?? [];
  else if (folder) ids = (user.library ?? []).filter((id) => folderOf(user, id) === folder);
  else ids = user.library ?? [];
  const items = ids.map((id) => db.getTitle(id)).filter((t): t is Title => !!t).map(toItemFromTitle);
  res.json(items);
});

// Catalog by category (trending / season / recommended) or a search query.
// The plugin exposes each category as a folder, so browsing/refreshing indexes
// a broad slice of the catalog into Jellyfin's DB — that's what makes Renzo
// titles turn up in Jellyfin's global search.
jellyfinPluginRoutes.get("/api/catalog", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const cat = String(req.query.cat ?? "trending").toLowerCase();
  try {
    const media = q
      ? await anilist.searchAnime(q)
      : cat === "recommended" ? await anilist.recommendedAnime()
      : cat === "season" ? await anilist.newSeasonAnime()
      : await anilist.trendingAnime();
    res.json(media.map(toItem));
  } catch (e) { log.warn("catalog", String(e)); res.json([]); }
});

// Episodes of a series (aired only), with titles + thumbnails.
jellyfinPluginRoutes.get("/api/episodes", async (req, res) => {
  const id = Number(req.query.id);
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  try {
    const t = await getOrCreateTitle(id);
    const extra = await anilist.detailExtra(id).catch(() => ({ episodes: [] as { title: string; thumbnail: string | null }[] }));
    const aired = availableEpisodes(t);
    const count = Math.max(episodeTotal(t), aired, t.episodeCount ? 0 : extra.episodes.length);
    const episodes = [];
    for (let n = 1; n <= count && n <= aired; n++) {
      const meta = extra.episodes[n - 1];
      episodes.push({ number: n, title: meta?.title || `Episode ${n}`, thumb: meta?.thumbnail || t.banner || t.poster || null });
    }
    res.json({ id, name: t.english || t.romaji, poster: t.poster, banner: t.banner, episodes });
  } catch (e) { log.warn("episodes", String(e)); res.status(404).json({ error: "not found" }); }
});

// Ranged read of a file on disk. Content-Type stays video/mp4 whatever the
// container (what Jellyfin has always been given; it probes the stream itself),
// and nosniff is set globally, so no file under a library root renders here.
async function sendRanged(req: Request, res: Response, abs: string): Promise<void> {
  const info = await stat(abs);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "private, no-store");
  const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
  if (m && (m[1] || m[2])) {
    let start: number, end: number;
    if (m[1]) {
      start = parseInt(m[1], 10);
      end = m[2] ? Math.min(parseInt(m[2], 10), info.size - 1) : info.size - 1;
    } else { // suffix range: the last N bytes
      start = Math.max(0, info.size - parseInt(m[2], 10));
      end = info.size - 1;
    }
    if (start > end || start >= info.size) {
      res.status(416).setHeader("Content-Range", `bytes */${info.size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(info.size));
    createReadStream(abs).pipe(res);
  }
}

/** The on-disk file behind a "local" resolve: this user's own copy, else the
 *  household shared copy resolveStream picked (same lookup, same order). */
async function localAbs(user: UserRecord, id: number, ep: number): Promise<string | null> {
  const mine = peekUserEp(user, id, ep);
  if (mine?.status === "downloaded" && mine.filePath
      && (await library.exists(library.userAbs(user.id, mine.filePath)))) {
    return library.userAbs(user.id, mine.filePath);
  }
  const shared = await sharedCopy(id, ep, user.id);
  return shared ? library.userAbs(shared.owner.id, shared.ownerEp.filePath!) : null;
}

// Resolve a playable source for this user and hand it to Jellyfin: a local file
// (theirs or a household copy) is streamed from THIS response; a debrid one is
// a 302 to the provider's own https link. The server never builds a URL that
// carries the caller's credential — local files used to be redirected to
// /jellyfin/api/file?p=…&key=<the API key>.
async function playEpisode(req: Request, res: Response, user: UserRecord, id: number, ep: number): Promise<void> {
  // No debrid pre-check here: resolveStream() serves an already-downloaded local
  // file without any debrid at all, and only then falls back to requireDebrid(),
  // which accepts Real-Debrid OR AllDebrid. Gating on realDebridToken blocked
  // AllDebrid accounts outright — and even their own local files.
  try {
    const r = await resolveStream(id, ep, user);
    if (r.source === "local") {
      const abs = await localAbs(user, id, ep);
      if (!abs) { res.status(404).json({ error: "file not found" }); return; }
      await sendRanged(req, res, abs);
    } else {
      res.redirect(302, r.url); // direct Real-Debrid / AllDebrid https link
    }
  } catch (e) {
    if (res.headersSent) return;
    // Map the "no debrid connected" sentinel to a provider-neutral 402, matching
    // the browser API, instead of a raw 502 that says nothing actionable.
    if (String(e).includes("realdebrid_required")) {
      res.status(402).json({ error: "connect a debrid service (Real-Debrid or AllDebrid) in Renzo to stream" });
      return;
    }
    log.warn("stream", String(e)); res.status(502).json({ error: String(e) });
  }
}

function episodeOf(src: Record<string, unknown>): { id: number; ep: number } {
  return { id: Number(src.id), ep: Math.max(1, Number(src.ep) || 1) };
}

// Key-authenticated playback: what plugin <= 1.0.3 put in MediaSourceInfo.Path
// (with ?key=). Kept so existing installs still play; newer plugins ask
// /api/streamurl at playback time instead.
jellyfinPluginRoutes.get("/api/stream", async (req, res) => {
  const { id, ep } = episodeOf(req.query);
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  await playEpisode(req, res, (req as KeyedRequest).renzoUser!, id, ep);
});

// Mint a playback path for one episode (key sent in the X-Renzo-Key header).
// The plugin puts the returned path — never its API key — into
// MediaSourceInfo.Path, which Jellyfin stores and hands to ffmpeg/clients.
jellyfinPluginRoutes.get("/api/streamurl", (req, res) => {
  const { id, ep } = episodeOf(req.query);
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  const path = `/jellyfin/play/${id}/${ep}`;
  const st = mintStreamToken((req as KeyedRequest).renzoUser!.id, path);
  res.set("Cache-Control", "no-store").json({ path: `${path}?st=${encodeURIComponent(st)}` });
});

// Token-authenticated playback: ?st= is bound to this exact id/ep path and
// expires (auth.mintStreamToken), so a leaked URL plays one episode for a few
// hours and reaches nothing else. Lives outside /api, so requireKey never runs.
jellyfinPluginRoutes.get("/play/:id/:ep", async (req, res) => {
  const path = req.originalUrl.split("?")[0];
  const user = userFromStreamToken(typeof req.query.st === "string" ? req.query.st : undefined, path);
  if (!user) { res.status(401).json({ error: "invalid or expired stream link" }); return; }
  const { id, ep } = episodeOf(req.params);
  if (!id) { res.status(400).json({ error: "id required" }); return; }
  await playEpisode(req, res, user, id, ep);
});

// Ranged streaming of one of this user's library files. Nothing links here any
// more (local playback is served by playEpisode itself); kept, key-protected,
// for a redirect an older server handed out just before an upgrade.
jellyfinPluginRoutes.get("/api/file", async (req, res) => {
  const user = (req as KeyedRequest).renzoUser!;
  const rel = decodeURIComponent(String(req.query.p ?? "")).replace(/\\/g, "/");
  if (!rel || rel.includes("..")) { res.status(400).end(); return; }
  try {
    await sendRanged(req, res, library.userAbs(user.id, rel));
  } catch { if (!res.headersSent) res.status(404).end(); }
});
