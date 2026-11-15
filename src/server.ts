import express, { type Request, type Response, type NextFunction } from "express";
import { resolve, join, sep } from "node:path";
import { promises as fs, readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { config, assertConfig } from "./config.js";
import { logger } from "./logger.js";
import { db } from "./db.js";
import { api } from "./routes/api.js";
import { authRoutes, accountRoutes, userAdminRoutes, inviteRoutes, smtpRoutes } from "./routes/auth.js";
import { requireAuth, requireStaff, requireOwner, downloadAuth, type AuthedRequest } from "./services/auth.js";
import * as anilist from "./services/anilist.js";
import * as captions from "./services/captions.js";
import { queue, sharedCopy, readSharedSub } from "./services/downloader.js";
import { jellyfinPluginRoutes } from "./routes/jellyfin.js";
import { userRoot, mediaHeaders } from "./services/library.js";
import * as apikeys from "./services/apikeys.js";
import * as autodl from "./services/autodl.js";

const log = logger("server");

// Security headers — safe defaults for a public (cloudflared) deployment.
// Inline-script hashes for the Next UI bootstrap (populated at boot when the
// static export is served; empty for the legacy UI, which has no inline scripts —
// this keeps CSP hash-based instead of falling back to 'unsafe-inline').
let scriptSrcExtra = "";

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // allow-popups (not same-origin) so an OAuth connect popup keeps window.opener,
  // letting the auth site postMessage the oauth-success callback back to us.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' https: data:",
      "media-src 'self' https: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'" + scriptSrcExtra,
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  // HSTS only on genuine HTTPS requests (req.secure via trust-proxy), so plain
  // HTTP LAN access keeps working.
  if (req.secure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
}

// CSRF defense-in-depth: modern browsers stamp Sec-Fetch-Site. Same-origin
// fetches from our own UI send "same-origin"; a malicious cross-site page sends
// "cross-site". Combined with SameSite=Lax cookies, this blocks cross-site
// requests (including side-effecting GETs like /play) from riding the session.
function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") {
    res.status(403).json({ error: "cross-origin request blocked" });
    return;
  }
  next();
}

async function main() {
  assertConfig();
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.libraryDir, { recursive: true });
  await db.init();
  // Every Title on disk already carries its malId, so the MAL -> AniList map
  // can be rebuilt for free at boot. Without it a restart loses the mapping and
  // the MAL fallback has to spend AniList requests to resolve a click — during
  // the rate limit that caused the fallback in the first place.
  anilist.primeMalIds(db.titles());
  await apikeys.ensureAllApiKeys(); // every account gets a per-user API key
  await autodl.migrateAutoFlags();  // legacy title-level auto-flags -> per-user autoTitles
  await queue.resume();
  autodl.start();

  const app = express();
  app.disable("x-powered-by");
  // Behind the cloudflared tunnel, but ALSO published straight onto the LAN
  // (network_mode: host). Forwarding headers are believed only from the peers
  // in config.trustProxy — by default just loopback, because that is where
  // cloudflared connects from and nothing else on the network has any business
  // saying who a client is. Never `true`: Express would then take the leftmost
  // X-Forwarded-For entry, i.e. whatever the client typed. req.secure, req.ip,
  // the login limiter and TV pairing all hang off this.
  app.set("trust proxy", config.trustProxy);
  log.info(
    `trust proxy: ${config.trustProxy.length ? config.trustProxy.join(", ") : "nothing (no proxy in front)"}`,
  );
  app.use(securityHeaders);
  app.use("/api", csrfGuard);
  // Avatar uploads are small base64 images (client resizes to ~128px) but can
  // exceed the general 64kb cap; give that one route its own parser. Mounted
  // FIRST — the global parser below skips bodies that are already consumed.
  // inflate:false — the size limit counts bytes AFTER decompression, but the
  // inflating itself runs before auth on any request; no client of ours sends
  // a Content-Encoding'd body, so refuse them (415) instead of decompressing.
  app.use("/api/account/avatar", express.json({ limit: "512kb", inflate: false }));
  app.use(express.json({ limit: "64kb", inflate: false }));
  // Return JSON (not HTML) for malformed bodies / payloads that are too large.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      return res.status(400).json({ error: "invalid request body" });
    }
    if (err?.type === "encoding.unsupported") {
      return res.status(415).json({ error: "compressed request bodies are not accepted" });
    }
    next(err);
  });

  // --- Auth (public: setup/login/logout/me) ---
  app.use("/api/auth", authRoutes);
  // --- Authenticated self-service + admin ---
  app.use("/api/account", requireAuth, accountRoutes);
  app.use("/api/users", requireAuth, requireStaff, userAdminRoutes);
  app.use("/api/invites", requireAuth, requireStaff, inviteRoutes);
  app.use("/api/smtp", requireAuth, requireOwner, smtpRoutes);
  // --- Everything else requires a session ---
  app.use("/api", requireAuth, api);
  // An unmatched /api GET used to fall through to the SPA catch-all and answer
  // 200 with index.html — so a client that fetched a route this build doesn't
  // have (an older server, a renamed endpoint) wrote HTML into whatever it was
  // expecting, e.g. a .vtt sidecar. The API must always answer as an API.
  app.use("/api", (_req, res) => { res.status(404).json({ error: "not found" }); });
  // --- Jellyfin plugin API (public; guarded by per-user API keys / stream tokens) ---
  app.use("/jellyfin", jellyfinPluginRoutes);

  // Caption download for native offline savers — accepts a ?dtoken= (downloads
  // only) so Capacitor's downloader can fetch subtitles without the session cookie.
  app.get("/dl/captions/:id.vtt", downloadAuth, async (req: AuthedRequest, res) => {
    // A household shared copy's track (same rule as /api/captions).
    const shared = req.user ? await readSharedSub(req.params.id, req.user) : undefined;
    if (shared !== undefined) {
      if (shared) res.type("text/vtt").send(shared);
      else res.status(404).type("text/vtt").send("");
      return;
    }
    captions.fetchAsVtt(req.params.id, req.user?.jimakuKey, (rel) => req.user ? captions.readUserVtt(req.user.id, rel) : Promise.resolve(null))
      .then((vtt) => res.type("text/vtt").send(vtt))
      .catch(() => res.status(502).type("text/vtt").send(""));
  });

  // Downloaded media + sidecar subtitles — gated AND isolated per user: each
  // request is served only from that user's own library subdirectory, so no
  // user can reach another's files (even by guessing paths).
  const userStatic = new Map<string, express.RequestHandler>();
  app.use("/files", downloadAuth, (req, res, next) => {
    const uid = (req as AuthedRequest).user!.id;
    let handler = userStatic.get(uid);
    if (!handler) {
      // fallthrough:false is load-bearing, not tidiness. express.static defaults
      // to true, so a missing file (renamed, deleted, or still a .part) fell
      // through to the SPA catch-all and answered 200 with index.html. A
      // downloading client reads 200 as success and not-206 as "server ignored
      // my Range", so it discarded its partial file and wrote 27 KB of HTML in
      // place of a 2 GB episode. Missing media must 404.
      handler = express.static(userRoot(uid), {
        acceptRanges: true, dotfiles: "ignore", fallthrough: false,
        // NEVER let a shared cache hold these. express.static defaults to
        // `Cache-Control: public, max-age=0`, and /files paths are relative to
        // each user's own root — so /files/Library/Show/S01E01.mkv is the SAME
        // URL for every account with different bytes behind it. A `public`
        // response in front of a CDN is a cross-user content leak waiting to
        // happen, and this hostname sits behind Cloudflare.
        // mediaHeaders also forces anything that is not video/subtitle/artwork
        // to an octet-stream attachment, so a stray .html can't run here.
        setHeaders: (res, p) => {
          for (const [k, v] of Object.entries(mediaHeaders(p))) res.setHeader(k, v);
        },
      });
      userStatic.set(uid, handler);
    }
    handler(req, res, next);
  });
  // fallthrough:false hands a 404 to the error chain; answer it as JSON, the
  // same shape /sharedfiles uses, instead of Express's default HTML page.
  app.use("/files", (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(err); return; }
    const status = (err as { statusCode?: number; status?: number })?.statusCode
      ?? (err as { status?: number })?.status ?? 404;
    res.status(status >= 400 && status < 600 ? status : 404).json({ error: "not found" });
  });

  // Cross-account read-only media sharing (household dedupe): stream another
  // user's DOWNLOADED episode instead of re-resolving it through debrid.
  //   /sharedfiles/ep/<titleId>/<ep>/<name> — what resolveStream hands out. It
  //     names only the episode; the copy is re-resolved here with sharedCopy(),
  //     so no other account's id or folder names reach the client. <name> is
  //     cosmetic (players like a file extension) and ignored.
  //   /sharedfiles/<ownerId>/<path> — the old form, still answered so offline
  //     entries saved before the change keep playing. Only exact file paths
  //     recorded on the owner's episode records are served — a whitelist, not
  //     a browse surface.
  // Either way sendFile's root option also contains any traversal attempt.
  app.use("/sharedfiles", downloadAuth, async (req, res) => {
    const segs = req.path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    let ownerId: string | undefined, rel = "";
    if (segs[0] === "ep") { // user ids are UUIDs, so "ep" can't be an owner id
      const copy = await sharedCopy(Number(segs[1]), Number(segs[2]), (req as AuthedRequest).user!.id);
      if (copy) { ownerId = copy.owner.id; rel = copy.ownerEp.filePath!; }
    } else {
      ownerId = segs.shift();
      rel = segs.join("/");
      const owner = ownerId ? db.users().find((u) => u.id === ownerId) : undefined;
      const known = owner && Object.values(owner.eps ?? {}).some(
        (e) => e.status === "downloaded" && e.filePath === rel,
      );
      if (!known) ownerId = undefined;
    }
    if (!ownerId || !rel) { res.status(404).json({ error: "not found" }); return; }
    res.sendFile(rel, {
      root: userRoot(ownerId), acceptRanges: true, dotfiles: "deny",
      // Same reasoning as /files: per-user content on a shareable URL, and no
      // non-media file served inline.
      headers: mediaHeaders(rel),
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "not found" });
    });
  });

  // Build id for clients (Electron desktop) to poll and auto-refresh on deploy.
  // Unauthenticated + no-store so the poll is cheap and always current.
  const BUILD = Date.now().toString(36);
  // CORS on /version only: the native clients' first-run "connect to your server"
  // page runs on a capacitor origin (https://localhost) and probes reachability by
  // fetching <server>/version — without this header that fetch is blocked as
  // cross-origin and every server reads as unreachable. Unauthenticated build id,
  // safe to expose.
  app.get("/version", (_req, res) =>
    res.set("Cache-Control", "no-store").set("Access-Control-Allow-Origin", "*").json({ build: BUILD }));

  // --- Web UI: the Next.js static export (frontend/out) is the UI (permanent
  // cutover, user-approved 2026-08-01). The legacy SPA stays in the image purely
  // as an emergency escape hatch: set LEGACY_UI=1 to serve it instead.
  const nextOut = resolve("frontend/out");
  const legacyForced = ["1", "true", "yes", "on"].includes((process.env.LEGACY_UI ?? "").toLowerCase());
  const useNextUi = !legacyForced && existsSync(join(nextOut, "index.html"));
  if (useNextUi) {
    // Next bootstraps with inline <script>s; collect their sha256 hashes at boot so
    // CSP stays hash-based (no 'unsafe-inline'). The export is immutable per build,
    // so boot-time hashing is complete.
    const hashes = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".html")) {
          const html = readFileSync(p, "utf8");
          for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
            const body = m[1] ?? "";
            if (body.trim()) hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
          }
        }
      }
    };
    walk(nextOut);
    scriptSrcExtra = hashes.size ? " " + [...hashes].join(" ") : "";
    log.info(`web UI: Next static export (frontend/out), ${hashes.size} inline-script hashes in CSP`);
    app.use(
      express.static(nextOut, {
        setHeaders: (res, p) => {
          if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
          else if (p.includes(`${sep}_next${sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    const spaFallback = readFileSync(join(nextOut, "index.html"), "utf8");
    app.get("*", (_req, res) => res.set("Cache-Control", "no-store").type("html").send(spaFallback));
  } else {
    // Legacy SPA. Cache-bust app.js/styles.css per build so clients never run
    // stale JS against fresh markup (index.html itself is served no-store).
    const publicDir = resolve("public");
    const indexHtml = readFileSync(resolve(publicDir, "index.html"), "utf8")
      .replace('href="/styles.css"', `href="/styles.css?v=${BUILD}"`)
      .replace('src="/app.js"', `src="/app.js?v=${BUILD}"`)
      .replace('src="/tvnav.js"', `src="/tvnav.js?v=${BUILD}"`);
    const sendIndex = (res: Response) => res.set("Cache-Control", "no-store").type("html").send(indexHtml);
    app.use(express.static(publicDir, { index: false }));
    app.get("/", (_req, res) => sendIndex(res));
    app.get("*", (_req, res) => sendIndex(res));
  }

  app.listen(config.port, () => {
    log.info(`Renzo listening on ${config.publicUrl} (port ${config.port})`);
    log.info(`library: ${config.libraryDir}  |  data: ${config.dataDir}`);
    if (config.authDisabled) {
      // Loud on purpose: every LAN caller is the OWNER in this mode.
      log.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      log.warn("AUTH_DISABLED=true — NO LOGIN: every caller on this host/LAN acts as the owner.");
      log.warn("Requests from public addresses or through the Cloudflare tunnel are refused (403).");
      log.warn("Unset AUTH_DISABLED before exposing this server anywhere you do not fully trust.");
      log.warn("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    }
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
