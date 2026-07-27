import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { newApiKey } from "./apikeys.js";
import type { UserRecord, Role } from "../types.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const log = logger("auth");

export const SESSION_COOKIE = "fsa_session";

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, "hex"), 64);
  const target = Buffer.from(hashHex, "hex");
  return hash.length === target.length && timingSafeEqual(hash, target);
}

// Run a comparable scrypt even when the username is unknown, so login timing
// doesn't reveal which usernames exist.
const DUMMY_HASH = "00".repeat(16) + ":" + "00".repeat(64);
export async function dummyVerify(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH).catch(() => {});
}

export function validCredentialShape(username: string, password: string): string | null {
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    return "Username must be 2-32 chars (letters, digits, . _ -)";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Password must be 8-128 characters";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export function setupRequired(): boolean {
  return db.users().length === 0;
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  email?: string,
): Promise<UserRecord> {
  const shapeErr = validCredentialShape(username, password);
  if (shapeErr) throw new Error(shapeErr);
  if (db.getUserByName(username)) throw new Error("Username already exists");
  // The very first account (the owner) inherits any env-provided credentials.
  const seedFromEnv = setupRequired();
  const user: UserRecord = {
    id: randomUUID(),
    username,
    passHash: await hashPassword(password),
    role,
    email: email || undefined,
    createdAt: new Date().toISOString(),
    library: [],
    lists: {},
    apiKey: newApiKey(),
    realDebridToken: seedFromEnv && config.realDebridToken ? config.realDebridToken : undefined,
    anilistToken: seedFromEnv && config.anilistToken ? config.anilistToken : undefined,
    malToken: seedFromEnv && config.malToken ? config.malToken : undefined,
  };
  await db.upsertUser(user);
  log.info(`created ${role} user "${username}"`);
  return user;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
export const ROLES: Role[] = ["owner", "manager", "user"];
export function isStaff(role: Role | undefined): boolean {
  return role === "owner" || role === "manager";
}
export function requireOwner(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "owner") { res.status(403).json({ error: "owner only" }); return; }
  next();
}
export function requireStaff(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!isStaff(req.user?.role)) { res.status(403).json({ error: "staff only" }); return; }
  next();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.addSession({
    token,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.sessionTtlDays * 24 * 3600_000).toISOString(),
  });
  return token;
}

export function sessionUser(token: string | undefined): UserRecord | undefined {
  if (!token) return undefined;
  const s = db.getSession(token);
  if (!s) return undefined;
  if (new Date(s.expiresAt).getTime() < Date.now()) return undefined;
  return db.getUser(s.userId);
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await db.removeSession(token);
}

// ---------------------------------------------------------------------------
// Login rate limiting (per source IP: 5 failures -> 15 min lockout)
// ---------------------------------------------------------------------------
const attempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.lockedUntil < Date.now();
}
export function recordLoginFailure(ip: string): void {
  const a = attempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = Date.now() + LOCKOUT_MS;
    a.count = 0;
    log.warn(`lockout for ${ip} (too many failed logins)`);
  }
  attempts.set(ip, a);
}
export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

// Separate throttle for password-reset requests (per IP): a real per-request
// limiter so /forgot can't be used to spam reset emails or probe the endpoint.
const forgotHits = new Map<string, number[]>();
export function forgotAllowed(ip: string): boolean {
  const now = Date.now();
  const hits = (forgotHits.get(ip) ?? []).filter((t) => now - t < LOCKOUT_MS);
  hits.push(now);
  forgotHits.set(ip, hits);
  return hits.length <= 3; // max 3 reset requests / 15 min / IP
}

// ---------------------------------------------------------------------------
// Cookies & middleware
// ---------------------------------------------------------------------------
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// `secure` is decided PER REQUEST (req.secure) so HTTPS clients get a Secure
// cookie while plain-HTTP LAN clients still work (a Secure cookie wouldn't be
// sent back over http).
// maxAgeSec: a number sets a persistent cookie (Max-Age); `null` makes it a
// SESSION cookie (no Max-Age → the browser drops it on close, i.e. "Remember me"
// unchecked); 0 deletes the cookie (logout).
export function sessionCookie(token: string, maxAgeSec: number | null, secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSec !== null) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export interface AuthedRequest extends Request {
  user?: UserRecord;
}

// A stand-in user when AUTH_DISABLED=true (trusted LAN mode).
const systemUser: UserRecord = {
  id: "system",
  username: "local",
  passHash: "",
  role: "owner",
  createdAt: new Date(0).toISOString(),
  library: [],
  lists: {},
};

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (config.authDisabled) {
    // Persist the system user's lists across restarts by storing it in the db.
    let u = db.getUser("system");
    if (!u) {
      u = { ...systemUser };
      db.upsertUser(u).catch(() => {});
    }
    req.user = u;
    return next();
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const user = sessionUser(token);
  if (!user) {
    res.status(401).json({ error: setupRequired() ? "setup_required" : "unauthorized" });
    return;
  }
  req.user = user;
  next();
}

// --- Download tokens -------------------------------------------------------
// Short-lived, HMAC-signed tokens authorizing DOWNLOADS ONLY (files + captions),
// for native downloaders (Capacitor) that can't read the httpOnly session cookie.
// Format: <userId>.<expMs>.<hmac>. Never grants general API access.
const DTOKEN_TTL_MS = 2 * 60 * 60_000; // 2h — enough for large downloads, short blast radius

// Keyed hash binding a token to ONE resource path, so a leaked token authorizes
// only that exact file/caption (not the user's whole library).
function scopeHash(scope: string): string {
  return createHmac("sha256", db.dtokenSecret()).update("scope:" + scope).digest("base64url").slice(0, 22);
}
export function mintDownloadToken(userId: string, scope: string): string {
  const body = `${userId}.${Date.now() + DTOKEN_TTL_MS}.${scopeHash(scope)}`;
  const sig = createHmac("sha256", db.dtokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function userFromDownloadToken(token: string | undefined, scope: string): UserRecord | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 4) return undefined;
  const [userId, expStr, sh, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return undefined;
  const expected = createHmac("sha256", db.dtokenSecret()).update(`${userId}.${expStr}.${sh}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  if (sh !== scopeHash(scope)) return undefined;          // token minted for a different path
  const u = db.getUser(userId);
  if (!u || u.downloadsDenied) return undefined;          // denied accounts can't use outstanding tokens
  return u;
}

// Middleware for the file + caption download routes: accept a ?dtoken= scoped to
// THIS request's path as an alternative to the session cookie; else normal auth.
export function downloadAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const dt = typeof req.query?.dtoken === "string" ? req.query.dtoken : undefined;
  const scope = req.originalUrl.split("?")[0]; // the exact requested pathname
  const u = userFromDownloadToken(dt, scope);
  if (u) { req.user = u; return next(); }
  return requireAuth(req, res, next);
}

// Back-compat alias (owner-level).
export const requireAdmin = requireOwner;
