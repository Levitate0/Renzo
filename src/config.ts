import "dotenv/config";
import { resolve } from "node:path";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: int(process.env.PORT, 8787),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ""),

  dataDir: resolve(process.env.DATA_DIR ?? "./data"),
  libraryDir: resolve(process.env.LIBRARY_DIR ?? "./library"),

  realDebridToken: process.env.REALDEBRID_TOKEN ?? "",

  preferredResolution: int(process.env.PREFERRED_RESOLUTION, 1080),
  minSeeders: int(process.env.MIN_SEEDERS, 1),
  downloadConcurrency: Math.max(1, int(process.env.DOWNLOAD_CONCURRENCY, 2)),

  tmdbApiKey: process.env.TMDB_API_KEY ?? "",

  // Subtitles
  jimakuApiKey: process.env.JIMAKU_API_KEY ?? "",
  openSubtitlesApiKey: process.env.OPENSUBTITLES_API_KEY ?? "",
  subtitleLangs: (process.env.SUBTITLE_LANGS ?? "en").split(",").map((s) => s.trim()).filter(Boolean),

  // Jellyfin integration (optional)
  jellyfinUrl: (process.env.JELLYFIN_URL ?? "").replace(/\/$/, ""),
  jellyfinApiKey: process.env.JELLYFIN_API_KEY ?? "",
  // Key the Renzo Jellyfin plugin uses to reach the catalog/stream API.
  pluginKey: process.env.RENZO_PLUGIN_KEY ?? "",
  // The Jellyfin plugin repository (manifest) URL handed to users to install
  // the plugin. Hosted on GitHub (public repo) — NOT the Renzo server — so the
  // zip comes from a GitHub Release asset.
  pluginManifestUrl: process.env.RENZO_PLUGIN_MANIFEST_URL
    || "https://raw.githubusercontent.com/Levitate0/Renzo/main/public/jellyfin/manifest.json",

  // Tracker connections. Priority per user: their own token > env override >
  // the self-hosted auth site (below), which fetches/refreshes tokens centrally.
  anilistToken: process.env.ANILIST_TOKEN ?? "",
  malToken: process.env.MAL_TOKEN ?? "",

  // Self-hosted auth site (Renzo Apps) that stores + auto-refreshes AniList/MAL
  // tokens. Two bases:
  //  - authsiteUrl (internal): server-to-server token fetch via X-Service-Key.
  //    Defaults to localhost so it never depends on the public tunnel.
  //  - authsitePublicUrl (public): handed to the browser for the OAuth connect
  //    popup (/connect/<provider>) and the postMessage origin check.
  authsiteUrl: (process.env.AUTHSITE_URL || "http://127.0.0.1:8788/auth").replace(/\/$/, ""),
  authsitePublicUrl: (process.env.AUTHSITE_PUBLIC_URL || "https://renzo-apps.levitatemedia.top/auth").replace(/\/$/, ""),
  authsiteServiceKey: process.env.AUTHSITE_SERVICE_KEY ?? "",

  // Authentication
  authDisabled: bool(process.env.AUTH_DISABLED, false), // escape hatch for trusted LANs
  sessionTtlDays: Math.max(1, int(process.env.SESSION_TTL_DAYS, 30)),

  // Auto-downloader (watches auto-flagged titles / AniList CURRENT list)
  autoDownload: bool(process.env.AUTO_DOWNLOAD, false),
  // Clamp: >=5m, <=1 week (Node timers overflow past ~24.8 days and fire instantly).
  autoDownloadIntervalMin: Math.min(7 * 24 * 60, Math.max(5, int(process.env.AUTO_DOWNLOAD_INTERVAL_MIN, 60))),
  autoDownloadMaxPerTick: Math.max(1, int(process.env.AUTO_DOWNLOAD_MAX_PER_TICK, 6)),

  debug: bool(process.env.DEBUG, false),
} as const;

export function assertConfig(): void {
  // Real-Debrid is now per-user (set in Settings). The env token, if present,
  // only seeds the first-run owner account. Nothing to assert at boot.
}
