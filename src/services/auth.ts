import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
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
export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
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

// Back-compat alias (owner-level).
export const requireAdmin = requireOwner;
