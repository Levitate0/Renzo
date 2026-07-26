import express, { type Request, type Response, type NextFunction } from "express";
import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import { config, assertConfig } from "./config.js";
import { logger } from "./logger.js";
import { db } from "./db.js";
import { api } from "./routes/api.js";
import { authRoutes, accountRoutes, userAdminRoutes, inviteRoutes, smtpRoutes } from "./routes/auth.js";
import { requireAuth, requireStaff, requireOwner, type AuthedRequest } from "./services/auth.js";
import { queue } from "./services/downloader.js";
import { userRoot } from "./services/library.js";
import * as autodl from "./services/autodl.js";

const log = logger("server");

// Security headers — safe defaults for a public (cloudflared) deployment.
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
      "script-src 'self'",
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
  await queue.resume();
  autodl.start();

  const app = express();
  app.disable("x-powered-by");
  // Behind the cloudflared tunnel; trust proxy so req.ip / req.secure reflect
  // the real client (also used for login rate-limiting).
  app.set("trust proxy", true);
  app.use(securityHeaders);
  app.use("/api", csrfGuard);
  app.use(express.json({ limit: "64kb" }));
  // Return JSON (not HTML) for malformed bodies / payloads that are too large.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      return res.status(400).json({ error: "invalid request body" });
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

  // Downloaded media + sidecar subtitles — gated AND isolated per user: each
  // request is served only from that user's own library subdirectory, so no
  // user can reach another's files (even by guessing paths).
  const userStatic = new Map<string, express.RequestHandler>();
  app.use("/files", requireAuth, (req, res, next) => {
    const uid = (req as AuthedRequest).user!.id;
    let handler = userStatic.get(uid);
    if (!handler) {
      handler = express.static(userRoot(uid), { acceptRanges: true, dotfiles: "ignore" });
      userStatic.set(uid, handler);
    }
    handler(req, res, next);
  });

  // Static web UI (login shell + app). Public so the login page can load.
  const publicDir = resolve("public");
  app.use(express.static(publicDir));
  app.get("*", (_req, res) => res.sendFile(resolve(publicDir, "index.html")));

  app.listen(config.port, () => {
    log.info(`Renzo listening on ${config.publicUrl} (port ${config.port})`);
    log.info(`library: ${config.libraryDir}  |  data: ${config.dataDir}`);
    if (config.authDisabled) log.warn("AUTH_DISABLED=true — no login required (trusted-LAN mode)");
  });
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
