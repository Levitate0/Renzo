import { Router, type Request, type Response, type NextFunction } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as anilist from "../services/anilist.js";
import * as library from "../services/library.js";
import { getOrCreateTitle, resolveStream, availableEpisodes } from "../services/downloader.js";
import type { UserRecord } from "../types.js";

// Public API consumed by the Renzo Jellyfin plugin (catalog / search / episodes /
// stream). Everything under /api is protected by RENZO_PLUGIN_KEY; the plugin
// streams through the owner's Real-Debrid identity. The repo manifest + zip are
// served statically from public/jellyfin/.
const log = logger("jf-plugin");
export const jellyfinPluginRoutes = Router();

function ownerUser(): UserRecord | undefined {
  return db.users().find((u) => u.role === "owner" && u.id !== "system") ?? db.users().find((u) => u.id !== "system");
}

function requireKey(req: Request, res: Response, next: NextFunction): void {
  if (!config.pluginKey) { res.status(503).json({ error: "plugin API disabled (set RENZO_PLUGIN_KEY)" }); return; }
  const key = String(req.query.key ?? req.get("X-Renzo-Key") ?? "");
  if (key !== config.pluginKey) { res.status(401).json({ error: "invalid plugin key" }); return; }
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

// Trending (no q) or search — this is what powers Jellyfin's Renzo search.
jellyfinPluginRoutes.get("/api/catalog", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  try {
    const media = q ? await anilist.searchAnime(q) : await anilist.trendingAnime();
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

// Resolve a playable URL (owner's RD/local) and redirect Jellyfin to it.
jellyfinPluginRoutes.get("/api/stream", async (req, res) => {
  const id = Number(req.query.id);
  const ep = Math.max(1, Number(req.query.ep) || 1);
  const owner = ownerUser();
  if (!owner) { res.status(503).json({ error: "no Renzo account to stream through" }); return; }
  try {
    const r = await resolveStream(id, ep, owner);
    if (r.source === "local") {
      // /files/<enc path> -> serve directly (ranged) through the key-protected file route
      const rel = r.url.replace(/^\/files\//, "");
      res.redirect(302, `/jellyfin/api/file?p=${rel}&key=${encodeURIComponent(config.pluginKey)}`);
    } else {
      res.redirect(302, r.url); // direct Real-Debrid https link
    }
  } catch (e) { log.warn("stream", String(e)); res.status(502).json({ error: String(e) }); }
});

// Ranged file streaming of a local library file (owner's), for Jellyfin playback.
jellyfinPluginRoutes.get("/api/file", async (req, res) => {
  const owner = ownerUser();
  if (!owner) { res.status(503).end(); return; }
  const rel = decodeURIComponent(String(req.query.p ?? "")).replace(/\\/g, "/");
  if (!rel || rel.includes("..")) { res.status(400).end(); return; }
  const abs = library.userAbs(owner.id, rel);
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
