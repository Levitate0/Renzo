import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as auth from "../services/auth.js";
import * as rd from "../services/realdebrid.js";
import type { AuthedRequest } from "../services/auth.js";

const log = logger("auth-routes");
export const authRoutes = Router();

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((e) => {
      log.error(req.method, req.path, String(e));
      if (!res.headersSent) res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
    });
  };
}

function clientIp(req: Request): string {
  // Behind cloudflared: prefer CF's real-client header, then Express's proxy-aware ip.
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

function publicUser(u: {
  id: string; username: string; role: string;
  realDebridToken?: string; anilistToken?: string; malToken?: string;
}) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    realDebridConnected: Boolean(u.realDebridToken),
    anilistConnected: Boolean(u.anilistToken),
    malConnected: Boolean(u.malToken),
  };
}

// --- Session state ----------------------------------------------------------
authRoutes.get("/me", wrap(async (req, res) => {
  if (config.authDisabled) {
    return res.json({ user: { id: "system", username: "local", role: "admin" }, authDisabled: true });
  }
  if (auth.setupRequired()) return res.json({ setupRequired: true });
  const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  const user = auth.sessionUser(token);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  res.json({ user: publicUser(user) });
}));

// --- First-run setup: create the admin account ------------------------------
// `setupClaimed` closes a TOCTOU: it's set synchronously before the first await
// (scrypt), so a second concurrent /setup sees it and is rejected — preventing
// two admins from being minted in the first-run window.
let setupClaimed = false;
authRoutes.post("/setup", wrap(async (req, res) => {
  if (config.authDisabled) return res.status(400).json({ error: "auth is disabled" });
  if (setupClaimed || !auth.setupRequired()) return res.status(403).json({ error: "already set up" });
  setupClaimed = true;
  try {
    const user = await auth.createUser(String(req.body?.username ?? ""), String(req.body?.password ?? ""), "admin");
    const token = await auth.createSession(user.id);
    res.setHeader("Set-Cookie", auth.sessionCookie(token, config.sessionTtlDays * 24 * 3600));
    res.json({ user: publicUser(user) });
  } catch (e) {
    setupClaimed = false; // allow the owner to retry after a validation error
    throw e;
  }
}));

// --- Login / logout ---------------------------------------------------------
authRoutes.post("/login", wrap(async (req, res) => {
  if (config.authDisabled) return res.status(400).json({ error: "auth is disabled" });
  const ip = clientIp(req);
  if (!auth.loginAllowed(ip)) {
    return res.status(429).json({ error: "Too many failed attempts — try again in 15 minutes" });
  }
  const password = String(req.body?.password ?? "");
  const user = db.getUserByName(String(req.body?.username ?? ""));
  const ok = user
    ? await auth.verifyPassword(password, user.passHash)
    : (await auth.dummyVerify(password), false); // equalize timing for unknown users
  if (!ok || !user) {
    auth.recordLoginFailure(ip);
    return res.status(401).json({ error: "Invalid username or password" });
  }
  auth.recordLoginSuccess(ip);
  const token = await auth.createSession(user.id);
  res.setHeader("Set-Cookie", auth.sessionCookie(token, config.sessionTtlDays * 24 * 3600));
  res.json({ user: publicUser(user) });
}));

authRoutes.post("/logout", wrap(async (req, res) => {
  const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  await auth.destroySession(token);
  res.setHeader("Set-Cookie", auth.sessionCookie("", 0));
  res.json({ ok: true });
}));

// --- Authenticated self-service ---------------------------------------------
// (mounted behind requireAuth in server.ts via the /api/account prefix)
export const accountRoutes = Router();

accountRoutes.post("/password", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.id === "system") return res.status(400).json({ error: "auth is disabled" });
  const ok = await auth.verifyPassword(String(req.body?.currentPassword ?? ""), user.passHash);
  if (!ok) return res.status(403).json({ error: "Current password is incorrect" });
  const next = String(req.body?.newPassword ?? "");
  const shapeErr = auth.validCredentialShape(user.username, next);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  user.passHash = await auth.hashPassword(next);
  await db.save();
  // Revoke every other session, then reissue a fresh cookie for this caller so
  // a stolen/old session can't survive a password change.
  const currentToken = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  await db.removeSessionsForUser(user.id, currentToken);
  const fresh = await auth.createSession(user.id);
  await db.removeSession(currentToken ?? "");
  res.setHeader("Set-Cookie", auth.sessionCookie(fresh, config.sessionTtlDays * 24 * 3600));
  res.json({ ok: true });
}));

accountRoutes.post("/trackers", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if ("anilistToken" in (req.body ?? {})) {
    user.anilistToken = String(req.body.anilistToken ?? "").trim() || undefined;
  }
  if ("malToken" in (req.body ?? {})) {
    user.malToken = String(req.body.malToken ?? "").trim() || undefined;
  }
  await db.save();
  res.json(publicUser(user));
}));

// Connect / update Real-Debrid (validated before saving; premium is required
// for actual downloads but we still store a valid free token).
accountRoutes.post("/realdebrid", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  const token = String(req.body?.token ?? "").trim();
  if (!token) {
    user.realDebridToken = undefined;
    await db.save();
    return res.json({ ...publicUser(user), premium: false });
  }
  const acct = await rd.accountInfo(token);
  if (!acct) return res.status(400).json({ error: "Invalid Real-Debrid token" });
  user.realDebridToken = token;
  await db.save();
  res.json({ ...publicUser(user), premium: rd.isPremium(acct), username_rd: acct.username });
}));

// --- Admin: user management --------------------------------------------------
export const userAdminRoutes = Router();

userAdminRoutes.get("/", wrap(async (_req, res) => {
  res.json(db.users().filter((u) => u.id !== "system").map(publicUser));
}));

userAdminRoutes.post("/", wrap(async (req, res) => {
  // Only the owner (the first-run admin) reaches this route, and every account
  // it creates is a regular user — the API can never mint a second admin.
  const user = await auth.createUser(String(req.body?.username ?? ""), String(req.body?.password ?? ""), "user");
  res.json(publicUser(user));
}));

userAdminRoutes.delete("/:id", wrap(async (req: AuthedRequest, res) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: "cannot delete yourself" });
  const target = db.getUser(req.params.id);
  if (!target) return res.status(404).json({ error: "no such user" });
  await db.removeUser(target.id);
  res.json({ ok: true });
}));
