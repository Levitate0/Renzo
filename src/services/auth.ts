import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { newApiKey } from "./apikeys.js";
import type { UserRecord, Role, SessionRecord } from "../types.js";

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
// `deviceName` is only set for sessions minted by TV pairing — it labels the
// device in "your devices". Everything else about the session is identical to a
// typed login: nothing downstream can tell a paired TV apart from a browser.
export async function createSession(
  userId: string,
  deviceName?: string,
  remember = true,
  tv = false,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const ttlDays = tv ? config.tvSessionTtlDays : config.sessionTtlDays;
  await db.addSession({
    token,
    id: randomUUID(),
    remember,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 24 * 3600_000).toISOString(),
    deviceName,
    tv: tv || undefined,
    lastSeenAt: new Date(now).toISOString(),
    rotatedAt: new Date(now).toISOString(),
  });
  return token;
}

// ---------------------------------------------------------------------------
// Session-token rotation
//
// The cookie used to be fixed for the whole SESSION_TTL_DAYS, so a token that
// leaked once — a shared machine, a backup of db.json, a proxy log — stayed
// good until it expired. Rotating shrinks that to a day.
//
// Renzo is NOT adopting the JWT half of Shiori's refresh design, deliberately:
// its sessions are opaque handles looked up on every request, so revoking one
// takes effect instantly, and access tokens would reintroduce a window where a
// revoked device keeps working. Rotation is applied to the opaque handle
// instead, which keeps that property.
//
// The grace is Shiori's idea and its reasoning holds here (see
// RefreshSessionService: a mobile handoff kills the response, not the request,
// so the client keeps a token the server has already replaced and only the
// server can forgive it). Shiori needs two windows — 90 seconds in memory to
// replay the same replacement, and 24 hours on the row — because a JWT is
// gone once issued. Here the replacement is simply the row's CURRENT token, so
// one persisted window does both jobs: any request arriving on the previous
// token is answered with the current one.
// ---------------------------------------------------------------------------
const ROTATE_EVERY_MS = 24 * 3600_000;
const PREV_GRACE_MS = 24 * 3600_000;

/** Stable per-device id, assigned lazily for rows predating rotation. */
export function stableSessionId(s: SessionRecord): string {
  if (!s.id) {
    s.id = randomUUID();
    void db.save();
  }
  return s.id;
}

/** Find a session by its current token, or by one it recently replaced. */
function resolveSession(token: string): { s: SessionRecord; viaPrev: boolean } | undefined {
  const cur = db.getSession(token);
  if (cur) return { s: cur, viaPrev: false };
  const prev = db.getSessionByPrevToken(token);
  return prev ? { s: prev, viaPrev: true } : undefined;
}

/**
 * Opaque handle for a session, derived with sha256 from its token. The device
 * list is rendered and revoked with THIS, never the token, so a live credential
 * is never handed to a page (or logged, or put in a URL).
 */
export function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

// Last-seen tracking. db.json is rewritten IN FULL on every save, so stamping
// lastSeenAt per request would rewrite the entire database on every API call:
// the live value is kept in memory and persisted at most once an hour per
// session. A stamp lost to a restart is cosmetic.
const LAST_SEEN_PERSIST_MS = 60 * 60_000;
const lastSeen = new Map<string, number>();

function touchSession(s: SessionRecord): void {
  const now = Date.now();
  lastSeen.set(s.token, now);
  // Sessions expire and get pruned from the db; their in-memory stamps would
  // otherwise linger forever, so drop the dead ones once the map gets big.
  if (lastSeen.size > 500) {
    const live = new Set(db.sessions().map((x) => x.token));
    for (const t of lastSeen.keys()) if (!live.has(t)) lastSeen.delete(t);
  }
  const persisted = s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0;
  if (now - persisted >= LAST_SEEN_PERSIST_MS) {
    s.lastSeenAt = new Date(now).toISOString();
    void db.save(); // fire-and-forget: never make a request wait on a disk write
  }
}

/** Freshest last-use we know for a session (memory beats the hourly stamp). */
export function sessionLastSeen(s: SessionRecord): string {
  const t = Math.max(
    lastSeen.get(s.token) ?? 0,
    s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : 0,
    new Date(s.createdAt).getTime(),
  );
  return new Date(t).toISOString();
}

export function sessionUser(token: string | undefined): UserRecord | undefined {
  if (!token) return undefined;
  const hit = resolveSession(token);
  if (!hit) return undefined;
  if (new Date(hit.s.expiresAt).getTime() < Date.now()) return undefined;
  touchSession(hit.s);
  return db.getUser(hit.s.userId);
}

/**
 * Post-authentication upkeep for a request that has already been accepted:
 * rotate the token when it is due, and hand back the current token to a client
 * that presented one we replaced. Returns the Set-Cookie value to send, or null
 * when nothing needs to change. Never fails a request — a rotation that cannot
 * be persisted leaves the existing token working.
 */
export function maintainSession(token: string | undefined, secure: boolean): string | null {
  if (!token || config.authDisabled) return null;
  const hit = resolveSession(token);
  if (!hit) return null;
  const { s, viaPrev } = hit;
  const now = Date.now();
  const maxAge = () =>
    s.remember === false ? null : Math.max(1, Math.floor((new Date(s.expiresAt).getTime() - now) / 1000));

  // Arrived on the replaced token: the response carrying the replacement was
  // lost. Re-send the SAME replacement rather than rotating again, so the
  // client ends up holding exactly what it should have received.
  if (viaPrev) return sessionCookie(s.token, maxAge(), secure);

  const rotatedAt = s.rotatedAt ? new Date(s.rotatedAt).getTime() : new Date(s.createdAt).getTime();
  if (now - rotatedAt < ROTATE_EVERY_MS) return null;

  const next = randomBytes(32).toString("base64url");
  s.prevToken = s.token;
  s.prevUntil = new Date(now + PREV_GRACE_MS).toISOString();
  s.token = next;
  s.rotatedAt = new Date(now).toISOString();
  // A remembered session that is in use stays alive. Its lifetime used to run
  // from sign-in no matter what, so a device used every day was still signed
  // out once a month. Each rotation now restarts it, as Shiori's refresh does
  // (RefreshSessionService.RotateAsync). An idle device still lapses after the
  // full TTL, and a session cookie ("Remember me" off) keeps its fixed end.
  if (s.remember !== false) {
    const ttlDays = s.tv ? config.tvSessionTtlDays : config.sessionTtlDays;
    s.expiresAt = new Date(now + ttlDays * 24 * 3600_000).toISOString();
  }
  // The in-memory last-seen map is keyed by token; move the stamp with it.
  const seen = lastSeen.get(s.prevToken);
  if (seen !== undefined) { lastSeen.delete(s.prevToken); lastSeen.set(next, seen); }
  void db.save(); // fire-and-forget: never make a request wait on a disk write
  return sessionCookie(next, maxAge(), secure);
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  // Resolve the row first: the caller may hold either the current token or the
  // one it replaced, and the in-memory lastSeen map is keyed by token — dropping
  // only the token we were handed would strand the sibling key for the lifetime
  // of the process.
  const s = db.getSession(token) ?? db.getSessionByPrevToken(token);
  lastSeen.delete(token);
  if (s) {
    lastSeen.delete(s.token);
    if (s.prevToken) lastSeen.delete(s.prevToken);
  }
  await db.removeSession(token);
}

// ---------------------------------------------------------------------------
// Login rate limiting (per source IP: 5 failures -> 15 min lockout)
// ---------------------------------------------------------------------------
interface Attempt { count: number; lockedUntil: number; at: number }
const attempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

// Separate throttle for password-reset requests (per IP): a real per-request
// limiter so /forgot can't be used to spam reset emails or probe the endpoint.
const forgotHits = new Map<string, number[]>();

// Both maps are keyed on an address the CALLER supplies, so neither may grow
// without bound: an attacker sourcing from an IPv6 /64 has 18 quintillion keys
// to hand out, and nothing here ever deleted a key that didn't come back.
// Entries expire once their window has passed, and the maps are capped
// oldest-first as a backstop. Same policy the TV-pairing tables use.
const MAX_TRACKED_SOURCES = 5_000;
const SWEEP_EVERY_MS = 60_000;
let sweptAt = 0;

function evictOldest(m: Map<string, unknown>): void {
  // JS Maps iterate in insertion order, and re-setting an existing key keeps
  // its original position — so the front of the map is the least recently
  // FIRST-SEEN source, which is the right one to drop.
  while (m.size > MAX_TRACKED_SOURCES) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

function sweepLimiters(force = false): void {
  const now = Date.now();
  if (!force && now - sweptAt < SWEEP_EVERY_MS) return;
  sweptAt = now;
  for (const [ip, a] of attempts) {
    // Dead once it is neither locked nor recently active.
    if (a.lockedUntil < now && now - a.at >= LOCKOUT_MS) attempts.delete(ip);
  }
  for (const [ip, hits] of forgotHits) {
    const live = hits.filter((t) => now - t < LOCKOUT_MS);
    if (live.length) forgotHits.set(ip, live);
    else forgotHits.delete(ip);
  }
  evictOldest(attempts);
  evictOldest(forgotHits);
}

export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.lockedUntil < Date.now();
}
export function recordLoginFailure(ip: string): void {
  sweepLimiters();
  const now = Date.now();
  const prev = attempts.get(ip);
  // The count decays: it is "5 failures within the window", not five failures
  // ever. Without this, four typos spread over months locked the account out
  // on a fifth attempt years later.
  const a: Attempt =
    prev && now - prev.at < LOCKOUT_MS ? prev : { count: 0, lockedUntil: prev?.lockedUntil ?? 0, at: now };
  a.count += 1;
  a.at = now;
  if (a.count >= MAX_ATTEMPTS) {
    a.lockedUntil = now + LOCKOUT_MS;
    a.count = 0;
    log.warn(`lockout for ${ip} (too many failed logins)`);
  }
  attempts.set(ip, a);
}
export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

export function forgotAllowed(ip: string): boolean {
  sweepLimiters();
  const now = Date.now();
  const hits = (forgotHits.get(ip) ?? []).filter((t) => now - t < LOCKOUT_MS);
  hits.push(now);
  forgotHits.set(ip, hits);
  return hits.length <= 3; // max 3 reset requests / 15 min / IP
}

/** Test/diagnostic: how many sources are tracked right now, after a sweep. */
export function limiterSizes(): { attempts: number; forgot: number } {
  sweepLimiters(true);
  return { attempts: attempts.size, forgot: forgotHits.size };
}

// ---------------------------------------------------------------------------
// Cookies & middleware
// ---------------------------------------------------------------------------
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const val = part.slice(i + 1).trim();
    // A malformed %-sequence in ANY cookie (another app's, on a shared domain)
    // threw "URI malformed" and turned every request into a 500. Keep it raw.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(val);
    } catch {
      out[part.slice(0, i).trim()] = val;
    }
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
  // Only ever ADDS a Set-Cookie; a route that sets its own (login, logout,
  // pairing) has already written one by the time it responds and is not
  // reached through here with a token to maintain.
  const refreshed = maintainSession(token, req.secure);
  if (refreshed) res.append("Set-Cookie", refreshed);
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
