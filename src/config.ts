import "dotenv/config";
import { resolve } from "node:path";
import { isIP } from "node:net";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

// ---------------------------------------------------------------------------
// PUBLIC_URL
// ---------------------------------------------------------------------------
// "Set" is not the useful question — .env.example ships
// PUBLIC_URL=http://localhost:8787, so a fresh install has it set to a value
// that means nothing anywhere but this machine. What callers actually need to
// know (TV pairing prints this URL on a television) is whether it is reachable
// from another device, so a loopback — or unparseable — value counts as unset
// and the URL is derived from the request instead.
function publicUrlIsReachable(raw: string): boolean {
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false; // not a URL at all: nothing to print
  }
  const bare = host.replace(/^\[|\]$/g, ""); // new URL keeps IPv6 brackets
  return !(
    bare === "" ||
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    /^127\./.test(bare)
  );
}

// ---------------------------------------------------------------------------
// TRUST_PROXY
// ---------------------------------------------------------------------------
// Which peers are allowed to tell us who the client is (Express `trust proxy`,
// and services/netip.ts). The default is LOOPBACK ONLY, and that is the whole
// point: cloudflared runs on this host and reaches the origin over 127.0.0.1,
// so the one hop worth believing is the local one. Trusting private LAN ranges
// as well (an earlier default) meant any machine on the LAN could forge
// CF-Connecting-IP and walk straight past every per-IP limiter.
//
// Vocabulary is deliberately Express's own — the three presets, literal
// addresses, IPv4 CIDRs — plus "none" for an instance with no proxy in front,
// so a value that works here works there and netip.ts agrees with `req.ip`.
const TRUST_PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);
const TRUST_NONE = ["none", "false", "off", "0", "no"];
// `true` is what this code used to hard-code and the obvious thing to write.
// Express reads a literal `true` as "trust every hop", which makes req.ip the
// LEFTMOST X-Forwarded-For entry — i.e. whatever the client typed — so it is
// never passed through. It is read as "the proxy on this host" instead.
const TRUST_LOCAL_PROXY = ["true", "yes", "on", "1", "local", "localhost"];

function validTrustRule(rule: string): boolean {
  if (TRUST_PRESETS.has(rule)) return true;
  if (rule.includes("/")) {
    const [net, bitsRaw] = rule.split("/");
    const bits = Number.parseInt(bitsRaw ?? "", 10);
    // IPv4 only, because that is what netip.ts's matcher implements: accepting
    // an IPv6 CIDR here would trust it in Express and not in netip.ts.
    // bits > 0, not >= 0: proxy-addr rejects a /0 range, so 0.0.0.0/0 passed
    // this check and then threw a raw TypeError out of app.set() at boot —
    // the exact class of failure this validation exists to prevent.
    return isIP(net ?? "") === 4 && Number.isFinite(bits) && bits > 0 && bits <= 32;
  }
  return isIP(rule) !== 0;
}

function parseTrustProxy(raw: string): { list: string[]; warn?: string; error?: string } {
  const v = raw.trim();
  if (!v) return { list: ["loopback"] };
  const low = v.toLowerCase();
  if (TRUST_NONE.includes(low)) return { list: [] };
  if (TRUST_LOCAL_PROXY.includes(low)) {
    return {
      list: ["loopback"],
      warn:
        `TRUST_PROXY="${v}" is read as "loopback" (a reverse proxy on this host, e.g. cloudflared). ` +
        `Express's literal \`true\` would trust every hop and make the client's own X-Forwarded-For ` +
        `authoritative, so it is never used. Name the proxy explicitly (e.g. TRUST_PROXY=10.0.1.5) if it is elsewhere.`,
    };
  }
  const list: string[] = [];
  const bad: string[] = [];
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const rule = part.toLowerCase();
    if (validTrustRule(rule)) list.push(rule);
    else bad.push(part);
  }
  if (bad.length || !list.length) {
    return {
      list: ["loopback"], // safe fallback; assertConfig() refuses to boot anyway
      error:
        `TRUST_PROXY: unrecognised value${bad.length > 1 ? "s" : ""} ${bad.map((b) => JSON.stringify(b)).join(", ") || JSON.stringify(v)}. ` +
        `Expected a comma-separated list of: none | loopback | linklocal | uniquelocal | an IP address | an IPv4 CIDR (e.g. 10.0.1.0/24). ` +
        `Leave it unset for the default ("loopback"), which is right when the tunnel/reverse proxy runs on this host.`,
    };
  }
  return { list };
}

const trustProxyParsed = parseTrustProxy(process.env.TRUST_PROXY ?? "");

export const config = {
  port: int(process.env.PORT, 8787),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ""),
  // Is PUBLIC_URL reachable from another device? .env.example ships a localhost
  // value, so "non-empty" would be a lie on a fresh install — see
  // publicUrlIsReachable above. TV pairing prints this on a television.
  publicUrlUsable: publicUrlIsReachable((process.env.PUBLIC_URL ?? "").trim()),

  // Peers whose forwarding headers we believe. Default: loopback only.
  trustProxy: trustProxyParsed.list,

  dataDir: resolve(process.env.DATA_DIR ?? "./data"),
  libraryDir: resolve(process.env.LIBRARY_DIR ?? "./library"),

  realDebridToken: process.env.REALDEBRID_TOKEN ?? "",

  preferredResolution: int(process.env.PREFERRED_RESOLUTION, 1080),
  minSeeders: int(process.env.MIN_SEEDERS, 1),
  // Default serial (1): finish each download before searching/adding the next on
  // Real-Debrid — avoids bursts of addMagnet calls that trigger RD 451s. Override
  // with DOWNLOAD_CONCURRENCY for premium accounts that can handle parallelism.
  downloadConcurrency: Math.max(1, int(process.env.DOWNLOAD_CONCURRENCY, 1)),

  tmdbApiKey: process.env.TMDB_API_KEY ?? "",

  // Subtitles
  jimakuApiKey: process.env.JIMAKU_API_KEY ?? "",
  openSubtitlesApiKey: process.env.OPENSUBTITLES_API_KEY ?? "",
  // Empty by default = keep all languages (English extracted from the release +
  // Japanese from Jimaku). Set SUBTITLE_LANGS=en to keep only English, etc.
  subtitleLangs: (process.env.SUBTITLE_LANGS ?? "").split(",").map((s) => s.trim()).filter(Boolean),

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

  // TV pairing (short code on a television, approved from a phone). OFF by
  // default and opt-in per instance: approving a code mints a full session for
  // the approver's account, so an instance that has no televisions should not
  // expose the flow at all. Off, the five /api/auth/tv/* endpoints answer 404
  // — not 403 — because clients feature-detect them and hide the option when
  // they are absent, so an instance that has not opted in looks like a build
  // without the feature.
  tvPairing: bool(process.env.TV_PAIRING, false),

  // Auto-downloader (watches auto-flagged titles / AniList CURRENT list)
  autoDownload: bool(process.env.AUTO_DOWNLOAD, false),
  // Clamp: >=5m, <=1 week (Node timers overflow past ~24.8 days and fire instantly).
  autoDownloadIntervalMin: Math.min(7 * 24 * 60, Math.max(5, int(process.env.AUTO_DOWNLOAD_INTERVAL_MIN, 60))),
  autoDownloadMaxPerTick: Math.max(1, int(process.env.AUTO_DOWNLOAD_MAX_PER_TICK, 6)),

  debug: bool(process.env.DEBUG, false),
} as const;

export function assertConfig(): void {
  // Real-Debrid is now per-user (set in Settings). The env token, if present,
  // only seeds the first-run owner account. Nothing to assert about it at boot.

  // A bad TRUST_PROXY used to reach Express untouched and die there with
  // `TypeError: invalid IP address: true` from inside proxy-addr. Say what is
  // wrong and what is accepted, and stop before serving a single request with
  // a trust list the operator did not mean.
  if (trustProxyParsed.error) {
    console.error(`fatal: ${trustProxyParsed.error}`);
    process.exit(1);
  }
  if (trustProxyParsed.warn) console.warn(`warning: ${trustProxyParsed.warn}`);
}
