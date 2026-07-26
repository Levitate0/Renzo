import { Router, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { logger } from "../logger.js";
import * as anilist from "../services/anilist.js";
import * as apikeys from "../services/apikeys.js";
import * as library from "../services/library.js";
import { getOrCreateTitle, resolveStream, availableEpisodes } from "../services/downloader.js";
import type { UserRecord } from "../types.js";

// Public API consumed by the Renzo Jellyfin plugin (catalog / search / episodes /
// stream). Every request under /api carries a PER-USER API key: it resolves to
// a specific Renzo account and streams through THAT user's Real-Debrid and their
// isolated library — no shared/owner identity. The repo manifest + zip are
// served statically from public/jellyfin/.
const log = logger("jf-plugin");
export const jellyfinPluginRoutes = Router();

// The API key identifies which Renzo user this request runs as.
interface KeyedRequest extends Request {
  renzoUser?: UserRecord;
  renzoKey?: string;
}

function requireKey(req: Request, res: Response, next: NextFunction): void {
  const key = String(req.query.key ?? req.get("X-Renzo-Key") ?? "");
  const user = apikeys.userByApiKey(key);
  if (!user) { res.status(401).json({ error: "invalid or missing Renzo API key" }); return; }
  (req as KeyedRequest).renzoUser = user;
  (req as KeyedRequest).renzoKey = key;
  next();
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

jellyfinPluginRoutes.use("/api", requireKey);

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
    const count = t.type === "movie" ? 1 : (t.episodeCount ?? Math.max(aired, extra.episodes.length)) || 12;
    const episodes = [];
    for (let n = 1; n <= count && n <= aired; n++) {
      const meta = extra.episodes[n - 1];
      episodes.push({ number: n, title: meta?.title || `Episode ${n}`, thumb: meta?.thumbnail || t.banner || t.poster || null });
    }
    res.json({ id, name: t.english || t.romaji, poster: t.poster, banner: t.banner, episodes });
  } catch (e) { log.warn("episodes", String(e)); res.status(404).json({ error: "not found" }); }
});

// Resolve a playable URL (this user's RD/local) and redirect Jellyfin to it.
jellyfinPluginRoutes.get("/api/stream", async (req, res) => {
  const id = Number(req.query.id);
  const ep = Math.max(1, Number(req.query.ep) || 1);
  const user = (req as KeyedRequest).renzoUser!;
  const key = (req as KeyedRequest).renzoKey!;
  if (!user.realDebridToken) { res.status(400).json({ error: "connect Real-Debrid in Renzo to stream" }); return; }
  try {
    const r = await resolveStream(id, ep, user);
    if (r.source === "local") {
      // /files/<enc path> -> serve directly (ranged) through the key-protected
      // file route; carry the SAME per-user key so it stays this user's file.
      const rel = r.url.replace(/^\/files\//, "");
      res.redirect(302, `/jellyfin/api/file?p=${rel}&key=${encodeURIComponent(key)}`);
    } else {
      res.redirect(302, r.url); // direct Real-Debrid https link
    }
  } catch (e) { log.warn("stream", String(e)); res.status(502).json({ error: String(e) }); }
});

// Ranged file streaming of a local library file (this user's), for Jellyfin playback.
jellyfinPluginRoutes.get("/api/file", async (req, res) => {
  const user = (req as KeyedRequest).renzoUser!;
  const rel = decodeURIComponent(String(req.query.p ?? "")).replace(/\\/g, "/");
  if (!rel || rel.includes("..")) { res.status(400).end(); return; }
  const abs = library.userAbs(user.id, rel);
  try {
    const info = await stat(abs);
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : info.size - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(abs, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", String(info.size));
      createReadStream(abs).pipe(res);
    }
  } catch { res.status(404).end(); }
});

// The plugin key handler applies to /api only; the file route lives under /api so it's covered.
