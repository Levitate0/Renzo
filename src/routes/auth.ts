import { Router, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import * as auth from "../services/auth.js";
import * as apikeys from "../services/apikeys.js";
import * as rd from "../services/realdebrid.js";
import * as mailer from "../services/mailer.js";
import type { AuthedRequest } from "../services/auth.js";
import type { Role, InviteRecord, SmtpSettings, ThemeSettings } from "../types.js";

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
  id: string; username: string; role: string; email?: string;
  realDebridToken?: string; anilistToken?: string; malToken?: string; theme?: ThemeSettings;
}) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    email: u.email ?? null,
    realDebridConnected: Boolean(u.realDebridToken),
    anilistConnected: Boolean(u.anilistToken),
    malConnected: Boolean(u.malToken),
    theme: u.theme ?? null,
  };
}

// --- Session state ----------------------------------------------------------
authRoutes.get("/me", wrap(async (req, res) => {
  if (config.authDisabled) {
    return res.json({ user: { id: "system", username: "local", role: "owner" }, authDisabled: true });
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
    const user = await auth.createUser(String(req.body?.username ?? ""), String(req.body?.password ?? ""), "owner");
    log.info(`owner account created: ${user.username}`);
    const token = await auth.createSession(user.id);
    res.setHeader("Set-Cookie", auth.sessionCookie(token, config.sessionTtlDays * 24 * 3600, req.secure));
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
  log.info(`login ok: ${user.username} from ${ip}`);
  const token = await auth.createSession(user.id);
  res.setHeader("Set-Cookie", auth.sessionCookie(token, config.sessionTtlDays * 24 * 3600, req.secure));
  res.json({ user: publicUser(user) });
}));

authRoutes.post("/logout", wrap(async (req, res) => {
  const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
  await auth.destroySession(token);
  res.setHeader("Set-Cookie", auth.sessionCookie("", 0, req.secure));
  res.json({ ok: true });
}));

// --- Invite acceptance (public) ---------------------------------------------
authRoutes.get("/invite/:token", wrap(async (req, res) => {
  const inv = db.getInvite(req.params.token);
  if (!inv || inv.usedAt || new Date(inv.expiresAt).getTime() < Date.now()) {
    return res.status(404).json({ valid: false, error: "This invite is invalid or has expired" });
  }
  res.json({ valid: true, role: inv.role, username: inv.username ?? null, presetUsername: Boolean(inv.username) });
}));

authRoutes.post("/invite/accept", wrap(async (req, res) => {
  const inv = db.getInvite(String(req.body?.token ?? ""));
  if (!inv || inv.usedAt || new Date(inv.expiresAt).getTime() < Date.now()) {
    return res.status(404).json({ error: "This invite is invalid or has expired" });
  }
  const username = inv.username || String(req.body?.username ?? "");
  const user = await auth.createUser(username, String(req.body?.password ?? ""), inv.role, inv.email);
  inv.usedAt = new Date().toISOString();
  await db.save();
  const token = await auth.createSession(user.id);
  res.setHeader("Set-Cookie", auth.sessionCookie(token, config.sessionTtlDays * 24 * 3600, req.secure));
  log.info(`invite accepted: ${user.username} (${inv.role})`);
  res.json({ user: publicUser(user) });
}));

// --- Password reset (public; username-gated + no account enumeration) -------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Requires the USERNAME. Always responds identically so it can't be used to
// discover which accounts (or emails) exist. Only sends a link when the account
// exists, has an email, and SMTP is configured.
authRoutes.post("/forgot", wrap(async (req, res) => {
  const ip = clientIp(req);
  if (!auth.forgotAllowed(ip)) {
    return res.status(429).json({ error: "Too many requests — try again in 15 minutes" });
  }
  const username = String(req.body?.username ?? "").trim();
  const user = username ? db.getUserByName(username) : undefined;
  if (user && user.id !== "system" && user.email && mailer.smtpConfigured()) {
    const token = randomBytes(24).toString("base64url");
    user.resetToken = token;
    user.resetExpires = Date.now() + 30 * 60_000;
    await db.save();
    const link = `${config.publicUrl}/?reset=${token}`;
    mailer.sendMail(
      user.email,
      "Reset your Renzo password",
      `<p>A password reset was requested for <b>${escapeHtml(user.username)}</b>.</p>
       <p><a href="${link}">Reset your password</a> — valid for 30 minutes.</p>
       <p>If you didn't request this, ignore this email.</p>`,
      `Reset your Renzo password: ${link} (valid 30 minutes). If you didn't request this, ignore this email.`,
    ).catch((e) => log.warn("reset mail failed", String(e)));
  } else {
    await auth.dummyVerify("timing-equalizer"); // keep response time uniform
  }
  res.json({ ok: true });
}));

// Validate a reset token for the reset page.
authRoutes.get("/reset/:token", wrap(async (req, res) => {
  const user = db.users().find((u) => u.resetToken === req.params.token && (u.resetExpires ?? 0) > Date.now());
  if (!user) return res.status(404).json({ valid: false, error: "This reset link is invalid or has expired" });
  res.json({ valid: true, username: user.username });
}));

authRoutes.post("/reset", wrap(async (req, res) => {
  const token = String(req.body?.token ?? "");
  const user = token
    ? db.users().find((u) => u.resetToken === token && (u.resetExpires ?? 0) > Date.now())
    : undefined;
  if (!user) return res.status(400).json({ error: "This reset link is invalid or has expired" });
  const password = String(req.body?.password ?? "");
  const shapeErr = auth.validCredentialShape(user.username, password);
  if (shapeErr) return res.status(400).json({ error: shapeErr });
  user.passHash = await auth.hashPassword(password);
  user.resetToken = undefined;
  user.resetExpires = undefined;
  await db.removeSessionsForUser(user.id); // a reset invalidates every existing session
  await db.save();
  const session = await auth.createSession(user.id);
  res.setHeader("Set-Cookie", auth.sessionCookie(session, config.sessionTtlDays * 24 * 3600, req.secure));
  log.info(`password reset completed: ${user.username}`);
  res.json({ user: publicUser(user) });
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
  res.setHeader("Set-Cookie", auth.sessionCookie(fresh, config.sessionTtlDays * 24 * 3600, req.secure));
  res.json({ ok: true });
}));

// Save my appearance/theme (validated; applied client-side).
accountRoutes.post("/theme", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.id === "system") return res.status(400).json({ error: "auth is disabled" });
  const body = req.body ?? {};
  const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
  const theme: ThemeSettings = {
    preset: (String(body.preset ?? "renzo").replace(/[^\w-]/g, "").slice(0, 32)) || "renzo",
  };
  const accent = hex(body.accent); if (accent) theme.accent = accent;
  const bg = hex(body.bg); if (bg) theme.bg = bg;
  user.theme = theme;
  await db.save();
  res.json(publicUser(user));
}));

// Change my own email (used for password-reset delivery).
accountRoutes.post("/email", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.id === "system") return res.status(400).json({ error: "auth is disabled" });
  const email = String(req.body?.email ?? "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  user.email = email || undefined;
  await db.save();
  res.json(publicUser(user));
}));

// --- Personal API key (Jellyfin plugin / external clients) ------------------
// Each account has its own key; the Jellyfin plugin uses it so streams play
// through THIS user's Real-Debrid and library. Only ever returned to the
// authenticated owner of the key.
accountRoutes.get("/apikey", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.id === "system") return res.status(400).json({ error: "auth is disabled" });
  const apiKey = await apikeys.ensureApiKey(user);
  res.json({
    apiKey,
    renzoUrl: config.publicUrl,
    manifestUrl: config.pluginManifestUrl, // GitHub-hosted plugin repo
  });
}));

// Regenerate my key (any client still using the old one stops working).
accountRoutes.post("/apikey/rotate", wrap(async (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.id === "system") return res.status(400).json({ error: "auth is disabled" });
  const apiKey = await apikeys.rotateApiKey(user);
  log.info(`api key rotated: ${user.username}`);
  res.json({ apiKey });
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

// --- Staff: user management (owner + manager) -------------------------------
export const userAdminRoutes = Router();

function assignableRole(actorRole: string, requested: unknown): Role {
  const r = requested === "manager" ? "manager" : "user";
  // Only the owner can create managers; managers can only create plain users.
  return actorRole === "owner" ? r : "user";
}

userAdminRoutes.get("/", wrap(async (_req, res) => {
  res.json(db.users().filter((u) => u.id !== "system").map(publicUser));
}));

userAdminRoutes.post("/", wrap(async (req: AuthedRequest, res) => {
  const role = assignableRole(req.user!.role, req.body?.role);
  const user = await auth.createUser(
    String(req.body?.username ?? ""), String(req.body?.password ?? ""), role, String(req.body?.email ?? "") || undefined,
  );
  log.info(`${role} added: ${user.username} by ${req.user!.username}`);
  res.json(publicUser(user));
}));

// Owner-only: change a user's role.
userAdminRoutes.post("/:id/role", wrap(async (req: AuthedRequest, res) => {
  if (req.user!.role !== "owner") return res.status(403).json({ error: "owner only" });
  const target = db.getUser(req.params.id);
  if (!target) return res.status(404).json({ error: "no such user" });
  if (target.role === "owner") return res.status(400).json({ error: "cannot change the owner's role" });
  const role: Role = req.body?.role === "manager" ? "manager" : "user";
  target.role = role;
  await db.save();
  log.info(`role changed: ${target.username} -> ${role}`);
  res.json(publicUser(target));
}));

userAdminRoutes.delete("/:id", wrap(async (req: AuthedRequest, res) => {
  const actor = req.user!;
  if (req.params.id === actor.id) return res.status(400).json({ error: "cannot delete yourself" });
  const target = db.getUser(req.params.id);
  if (!target) return res.status(404).json({ error: "no such user" });
  if (target.role === "owner") return res.status(400).json({ error: "cannot delete the owner" });
  // Managers may only remove plain users.
  if (actor.role !== "owner" && target.role !== "user") return res.status(403).json({ error: "managers can only remove users" });
  await db.removeUser(target.id);
  log.info(`user removed: ${target.username} by ${actor.username}`);
  res.json({ ok: true });
}));

// --- Invites (staff create; public accept) ----------------------------------
export const inviteRoutes = Router();

inviteRoutes.get("/", wrap(async (_req, res) => {
  const now = Date.now();
  res.json(db.invites()
    .filter((i) => !i.usedAt && new Date(i.expiresAt).getTime() > now)
    .map((i) => ({ token: i.token, role: i.role, email: i.email ?? null, username: i.username ?? null,
      expiresAt: i.expiresAt, url: `${config.publicUrl}/invite/${i.token}` })));
}));

inviteRoutes.post("/", wrap(async (req: AuthedRequest, res) => {
  const role: Role = req.user!.role === "owner" && req.body?.role === "manager" ? "manager" : "user";
  const invite: InviteRecord = {
    token: randomBytes(24).toString("base64url"),
    role,
    email: String(req.body?.email ?? "").trim() || undefined,
    username: String(req.body?.username ?? "").trim() || undefined,
    createdBy: req.user!.id,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  };
  await db.addInvite(invite);
  const url = `${config.publicUrl}/invite/${invite.token}`;
  let emailed = false;
  if (invite.email && mailer.smtpConfigured()) {
    try {
      await mailer.sendMail(invite.email, "You're invited to Renzo",
        `<p>You've been invited to <b>Renzo</b>.</p><p><a href="${url}">Click here to set your password and join</a>.</p><p>This link expires in 7 days.</p>`);
      emailed = true;
    } catch (e) { log.warn("invite email failed", String(e)); }
  }
  log.info(`invite created (${role})${invite.email ? ` for ${invite.email}` : ""} by ${req.user!.username}`);
  res.json({ token: invite.token, role, url, emailed });
}));

inviteRoutes.delete("/:token", wrap(async (req, res) => {
  await db.removeInvite(req.params.token);
  res.json({ ok: true });
}));

// --- SMTP (owner-only) ------------------------------------------------------
export const smtpRoutes = Router();

function readSmtp(body: Record<string, unknown>, keepPass?: string): SmtpSettings {
  const passIn = String(body.pass ?? "");
  return {
    host: String(body.host ?? "").trim(),
    port: Number.parseInt(String(body.port ?? "587"), 10) || 587,
    secure: Boolean(body.secure),
    user: String(body.user ?? "").trim(),
    pass: passIn || keepPass || "", // blank keeps the existing password
    from: String(body.from ?? "").trim(),
  };
}

smtpRoutes.get("/", wrap(async (_req, res) => {
  res.json(mailer.smtpPublic());
}));

smtpRoutes.post("/", wrap(async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.host ?? "").trim()) { await db.setSmtp(undefined); return res.json({ ok: true, cleared: true }); }
  const settings = readSmtp(b, db.smtp()?.pass);
  if (!settings.from) return res.status(400).json({ error: "From Address is required" });
  await db.setSmtp(settings);
  log.info("SMTP settings saved");
  res.json({ ok: true });
}));

smtpRoutes.post("/test", wrap(async (req: AuthedRequest, res) => {
  const to = String(req.body?.to ?? "").trim();
  if (!to) return res.status(400).json({ error: "recipient required" });
  if (!mailer.smtpConfigured()) return res.status(400).json({ error: "Save SMTP settings first" });
  await mailer.sendMail(to, "Renzo SMTP test", "<p>✅ Your Renzo SMTP settings work.</p>");
  res.json({ ok: true });
}));
