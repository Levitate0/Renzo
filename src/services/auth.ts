import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { newApiKey } from "./apikeys.js";
import { clientIp, isLanAddress, limiterBucket, siteBucket } from "./netip.js";
import type { UserRecord, Role, SessionRecord } from "../types.js";

const scryptRaw = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const log = logger("auth");

// ---------------------------------------------------------------------------
// scrypt concurrency cap
//
// Each scrypt call holds a libuv threadpool thread (default pool: 4) and 16 MB
// for ~50-100 ms. The same pool serves every fs read/write — library streaming,
// db.json saves — so a burst of logins from anywhere used to starve the whole
// server. At most SCRYPT_MAX_ACTIVE run at once; a bounded queue waits behind
// them, and past that the caller is told the server is busy instead of piling
// up more memory and latency.
//
// That refusal is what a flood of sign-ins from strangers aims for, so work
// that is known not to be a stranger's — a login from a network the account
// has signed in from before, a re-check of the password by an already signed-in
// user, hashing a new password — waits in its own PRIORITY lane, served first
// and never refused because the ordinary queue is full.
// ---------------------------------------------------------------------------
const SCRYPT_MAX_ACTIVE = 2;
const SCRYPT_MAX_QUEUED = 32;
const SCRYPT_MAX_PRIORITY_QUEUED = 16;
let scryptActive = 0;
const scryptWaiters: Array<() => void> = [];
const scryptPriority: Array<() => void> = [];

export class AuthBusyError extends Error {
  constructor() { super("Server is busy — try again in a moment"); }
}

/** True when a new scrypt call would be refused right now. */
export function authBusy(priority = false): boolean {
  if (scryptActive < SCRYPT_MAX_ACTIVE) return false;
  return priority
    ? scryptPriority.length >= SCRYPT_MAX_PRIORITY_QUEUED
    : scryptWaiters.length >= SCRYPT_MAX_QUEUED;
}

// Acquires its slot SYNCHRONOUSLY (before the first await), so a caller that
// checked authBusy() and calls straight in cannot be refused in between.
async function scrypt(pw: string, salt: Buffer, len: number, priority = false): Promise<Buffer> {
  if (scryptActive < SCRYPT_MAX_ACTIVE) {
    scryptActive++;
  } else {
    const queue = priority ? scryptPriority : scryptWaiters;
    if (queue.length >= (priority ? SCRYPT_MAX_PRIORITY_QUEUED : SCRYPT_MAX_QUEUED)) throw new AuthBusyError();
    // The releasing call hands its slot straight to us (scryptActive unchanged).
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  try {
    return await scryptRaw(pw, salt, len);
  } finally {
    const next = scryptPriority.shift() ?? scryptWaiters.shift();
    if (next) next();
    else scryptActive--;
  }
}

/** Test/diagnostic: scrypt calls running and queued right now. */
export function scryptLoad(): { active: number; queued: number } {
  return { active: scryptActive, queued: scryptWaiters.length + scryptPriority.length };
}

export const SESSION_COOKIE = "fsa_session";

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------
// Priority: every caller already holds something a stranger does not (a
// session, an invite, a reset link, or the empty first-run server).
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, true);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string, priority = false): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, "hex"), 64, priority);
  const target = Buffer.from(hashHex, "hex");
  return hash.length === target.length && timingSafeEqual(hash, target);
}

// Run a comparable scrypt even when the username is unknown, so login timing
// doesn't reveal which usernames exist. (/login only — /forgot pads its reply
// with a plain timer instead, see forgotPace, so it never takes a scrypt slot.)
const DUMMY_HASH = "00".repeat(16) + ":" + "00".repeat(64);
export async function dummyVerify(password: string): Promise<void> {
  // A busy refusal is re-thrown: swallowing it would answer an unknown name
  // instantly while a known one waits for (or is refused) a slot — a username
  // oracle under load.
  await verifyPassword(password, DUMMY_HASH).catch((e) => { if (e instanceof AuthBusyError) throw e; });
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
  const passHash = await hashPassword(password);
  // Checked again after the await: two parallel creates of the same name (two
  // invites, or an invite racing an admin add) both passed the check above
  // before either had stored its row.
  if (db.getUserByName(username)) throw new Error("Username already exists");
  // The very first account (the owner) inherits any env-provided credentials.
  const seedFromEnv = setupRequired();
  const user: UserRecord = {
    id: randomUUID(),
    username,
    passHash,
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
//
// Reuse detection. Handing the current token to ANY holder of the previous one
// meant a stolen cookie followed every rotation for ever. The previous token is
// now answered with the current one only until the current one is first used
// (`curUsedAt`) — the lost-response case, where the client never saw it. After
// that, the previous token still authenticates for REUSE_GRACE_MS without being
// given anything (in-flight requests, and a Hub external player such as mpv
// that was launched with the old cookie and keeps it for a whole movie), and
// a reuse later than that means two parties hold this session: it is revoked,
// signing out the thief and the real device alike, as refresh-token reuse
// detection does everywhere.
//
// Media fetches are the exception. A Hub desktop player captures the cookie
// once (mpv's stream, the built-in player's subtitle loader), and a TV left
// paused overnight comes back on it hours after the app moved on: revoking
// then signed the user out of everything. A GET for a file or caption on the
// previous token is therefore answered (read-only, and never past prevUntil)
// without being treated as reuse. Anything else on it still is.
//
// Rotation also slides a remembered session's expiry, which let one holder
// keep a session alive for ever. It is capped at SESSION_MAX_AGE_FACTOR times
// the TTL from the original sign-in (at least 180 days), after which the
// device signs in again.
// ---------------------------------------------------------------------------
const ROTATE_EVERY_MS = 24 * 3600_000;
const PREV_GRACE_MS = 24 * 3600_000;
const REUSE_GRACE_MS = 6 * 3600_000;
const SESSION_MAX_AGE_FACTOR = 2;
const SESSION_MAX_AGE_MIN_DAYS = 180;
const MEDIA_PATH = /^\/(?:files|sharedfiles|dl\/captions|api\/captions)\//;

/** Can a request on the previous token be a long-lived media fetch? */
export function isMediaRequest(req: Request): boolean {
  return (req.method === "GET" || req.method === "HEAD") && MEDIA_PATH.test(req.originalUrl.split("?")[0]);
}

function sessionHardEnd(s: SessionRecord): number {
  const ttlDays = s.tv ? config.tvSessionTtlDays : config.sessionTtlDays;
  const days = Math.max(SESSION_MAX_AGE_MIN_DAYS, ttlDays * SESSION_MAX_AGE_FACTOR);
  return new Date(s.createdAt).getTime() + days * 24 * 3600_000;
}

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

export function sessionUser(token: string | undefined, media = false): UserRecord | undefined {
  if (!token) return undefined;
  const hit = resolveSession(token);
  if (!hit) return undefined;
  const { s, viaPrev } = hit;
  const now = Date.now();
  if (new Date(s.expiresAt).getTime() < now) return undefined;
  if (viaPrev) {
    const usedAt = s.curUsedAt ? new Date(s.curUsedAt).getTime() : 0;
    if (usedAt && now - usedAt > REUSE_GRACE_MS && !media) {
      // The replaced token came back long after its replacement was in use.
      log.warn(`session reuse detected for user ${s.userId}${s.deviceName ? ` ("${s.deviceName}")` : ""} — revoked`);
      void destroySession(s.token).catch(() => {});
      return undefined;
    }
  } else if (s.prevToken && !s.curUsedAt) {
    // First request on the current token since it was issued: from here on the
    // previous token is no longer handed the current one.
    s.curUsedAt = new Date(now).toISOString();
    void db.save(); // fire-and-forget: once per rotation
  }
  touchSession(s);
  return db.getUser(s.userId);
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
  // client ends up holding exactly what it should have received — but only
  // while nobody has used it yet. Once it is in use, its holder already has it
  // and the caller on the old token is not given it (see reuse detection).
  if (viaPrev) return s.curUsedAt ? null : sessionCookie(s.token, maxAge(), secure);

  const rotatedAt = s.rotatedAt ? new Date(s.rotatedAt).getTime() : new Date(s.createdAt).getTime();
  if (now - rotatedAt < ROTATE_EVERY_MS) return null;

  const next = randomBytes(32).toString("base64url");
  s.prevToken = s.token;
  s.prevUntil = new Date(now + PREV_GRACE_MS).toISOString();
  s.token = next;
  s.rotatedAt = new Date(now).toISOString();
  s.curUsedAt = undefined;
  // A remembered session that is in use stays alive. Its lifetime used to run
  // from sign-in no matter what, so a device used every day was still signed
  // out once a month. Each rotation now restarts it, as Shiori's refresh does
  // (RefreshSessionService.RotateAsync). An idle device still lapses after the
  // full TTL, and a session cookie ("Remember me" off) keeps its fixed end.
  if (s.remember !== false) {
    const ttlDays = s.tv ? config.tvSessionTtlDays : config.sessionTtlDays;
    s.expiresAt = new Date(Math.min(now + ttlDays * 24 * 3600_000, sessionHardEnd(s))).toISOString();
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
// Login rate limiting. Three layers:
//
// 1. Per client: 5 failures -> 15 min lockout, counted per client (IPv6
//    bucketed by /64, see limiterBucket) and per username AND client. The
//    second key stops a success on the attacker's OWN account from wiping the
//    count for the name they are guessing. A success only refunds its own
//    reservation on the client key — it used to delete it, so signing in to
//    your own account after every 4 failures reset the count for ever.
// 2. Per IPv6 /48 (siteBucket): 50 failures -> 15 min. One tunnel-broker /48
//    is 65,536 /64s, which multiplied layer 1 into a flood.
// 3. Per ACCOUNT, across every address: after ACCT_FREE_FAILS failures within
//    the hour, further attempts on that name are tarpitted — one attempt at a
//    time, each wait doubling up to ACCT_MAX_DELAY_MS — but only for clients
//    the account has not used before. A network the account has signed in
//    from WITH ITS PASSWORD skips this layer (see trustedClient),
//    so a distributed guesser is slowed to a trickle without locking the real
//    user out of their own account. Unknown names are tracked exactly like
//    real ones, so the throttle does not reveal which accounts exist.
//
// The attempt is RESERVED (counted as a failure) synchronously, before scrypt
// runs, and only refunded by a success. Checking first and counting after the
// await let any number of parallel requests through on one "allowed" check.
// ---------------------------------------------------------------------------
interface Attempt { count: number; lockedUntil: number; at: number }
const attempts = new Map<string, Attempt>();
const MAX_ATTEMPTS = 5;
const SITE_MAX_ATTEMPTS = 50;
const LOCKOUT_MS = 15 * 60_000;

interface AcctThrottle { fails: number; nextAt: number; at: number }
const ACCT_FREE_FAILS = 10;
const ACCT_WINDOW_MS = 60 * 60_000;
const ACCT_MAX_DELAY_MS = 5 * 60_000;
// Real accounts are kept apart from guessed names: the guessed-name map is the
// one an attacker can fill, and evicting from it must never drop the throttle
// on a real account. Real ones are bounded by the number of users.
const acctReal = new Map<string, AcctThrottle>();
const acctOther = new Map<string, AcctThrottle>();

// Separate throttle for password-reset requests: a real per-request limiter so
// /forgot can't be used to spam reset emails or probe the endpoint. Keyed per
// client (/64), per IPv6 site (/48) and once globally — per-/64 alone let one
// tunnel-broker /48 send 10k requests in seconds by stepping through /64s.
const forgotHits = new Map<string, number[]>();
const FORGOT_PER_CLIENT = 3;    // per /64 (or IPv4 address) per 15 min
const FORGOT_PER_SITE = 10;     // per IPv6 /48 per 15 min
const FORGOT_GLOBAL = 60;       // whole server per 15 min
let forgotGlobal: number[] = [];

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
  for (const m of [acctReal, acctOther]) {
    for (const [k, a] of m) if (a.nextAt < now && now - a.at >= ACCT_WINDOW_MS) m.delete(k);
  }
  evictOldest(attempts);
  evictOldest(forgotHits);
  evictOldest(acctOther);
}

function locked(key: string, now: number): boolean {
  const a = attempts.get(key);
  return Boolean(a && a.lockedUntil >= now);
}

/** Count one failure; true when THIS failure started a lockout. */
function countFailure(key: string, now: number, label: string, max = MAX_ATTEMPTS): boolean {
  const prev = attempts.get(key);
  // The count decays: it is "5 failures within the window", not five failures
  // ever. Without this, four typos spread over months locked the account out
  // on a fifth attempt years later.
  const a: Attempt =
    prev && now - prev.at < LOCKOUT_MS ? prev : { count: 0, lockedUntil: prev?.lockedUntil ?? 0, at: now };
  a.count += 1;
  a.at = now;
  let lockedNow = false;
  if (a.count >= max) {
    a.lockedUntil = now + LOCKOUT_MS;
    a.count = 0;
    lockedNow = true;
    log.warn(`lockout for ${label} (too many failed attempts)`);
  }
  attempts.set(key, a);
  return lockedNow;
}

/** Give back one reserved failure (and the lockout it caused, if any). */
function refund(key: string, lockedByIt: boolean, max: number): void {
  const a = attempts.get(key);
  if (!a) return;
  if (lockedByIt) { a.lockedUntil = 0; a.count = max - 1; }
  else a.count = Math.max(0, a.count - 1);
}

function acctDelay(fails: number): number {
  if (fails < ACCT_FREE_FAILS) return 0;
  return Math.min(ACCT_MAX_DELAY_MS, 1000 * 2 ** Math.min(20, fails - ACCT_FREE_FAILS));
}

// --- Networks an account is known to use -----------------------------------
// Persisted on the user as keyed hashes of the limiter bucket (no address is
// written to db.json), refreshed by every successful PASSWORD sign-in only.
// Networks that merely presented a session cookie used to count too, which
// let a stolen cookie make every network its thief used "the user's own" and
// skip the per-account throttle on /login (~72k guesses a day).
const KNOWN_BUCKETS = 20;

function bucketTag(bucket: string): string {
  return createHmac("sha256", db.dtokenSecret()).update("login-bucket:" + bucket).digest("base64url").slice(0, 22);
}

/** Has this account signed in with its password from `ip`'s network? */
export function trustedClient(user: UserRecord, ip: string): boolean {
  return Boolean(user.loginBuckets?.includes(bucketTag(limiterBucket(ip))));
}

export interface LoginTicket {
  keys: Array<{ key: string; lockedByIt: boolean; max: number; drop: boolean }>;
  acct?: string;
}
export type LoginGate = { ok: true; ticket: LoginTicket } | { ok: false; retryAfterSec: number };

/**
 * Reserve one login attempt for (ip, username), or say how long to wait. The
 * reservation already counts as a failure; call loginSucceeded() if the
 * password turns out to be right. `trusted`: the client is on a network the
 * account is known to use (trustedClient), which skips the per-account layer.
 */
export function beginLogin(ip: string, username: string, trusted = false): LoginGate {
  sweepLimiters();
  const now = Date.now();
  const bucket = limiterBucket(ip);
  const site = siteBucket(ip);
  // Bounded: the name is caller input and becomes part of a map key.
  const name = username.trim().toLowerCase().slice(0, 64);
  const keys = [
    { key: `ip:${bucket}`, max: MAX_ATTEMPTS, drop: false, label: bucket },
    { key: `user:${name}@${bucket}`, max: MAX_ATTEMPTS, drop: true, label: `one username from ${bucket}` },
    ...(site ? [{ key: `site:${site}`, max: SITE_MAX_ATTEMPTS, drop: false, label: site }] : []),
  ];
  const lockedKey = keys.find((k) => locked(k.key, now));
  if (lockedKey) {
    return { ok: false, retryAfterSec: Math.ceil((attempts.get(lockedKey.key)!.lockedUntil - now) / 1000) };
  }
  let acct: string | undefined;
  if (!trusted) {
    const map = db.getUserByName(name) ? acctReal : acctOther;
    let a = map.get(name);
    if (a && now - a.at >= ACCT_WINDOW_MS && a.nextAt < now) a = undefined; // window passed
    if (a && now < a.nextAt) return { ok: false, retryAfterSec: Math.ceil((a.nextAt - now) / 1000) };
    a ??= { fails: 0, nextAt: 0, at: now };
    a.fails += 1;
    a.at = now;
    a.nextAt = now + acctDelay(a.fails);
    if (a.fails === ACCT_FREE_FAILS) log.warn("sign-in throttle engaged for one account (failures from many networks)");
    map.set(name, a);
    acct = name;
  }
  // The attempted name is never logged: people type passwords into it.
  return {
    ok: true,
    ticket: {
      keys: keys.map((k) => ({ key: k.key, max: k.max, drop: k.drop, lockedByIt: countFailure(k.key, now, k.label, k.max) })),
      acct,
    },
  };
}

/** The password was right: refund the reservation and remember the network. */
export function loginSucceeded(t: LoginTicket, user?: UserRecord, ip?: string): void {
  for (const k of t.keys) {
    if (k.drop) attempts.delete(k.key);
    else refund(k.key, k.lockedByIt, k.max);
  }
  // The password was right, so whoever was failing on this name was not
  // guessing it; the throttle has nothing left to protect.
  if (t.acct) { acctReal.delete(t.acct); acctOther.delete(t.acct); }
  if (user && ip) {
    const tag = bucketTag(limiterBucket(ip));
    user.loginBuckets = [tag, ...(user.loginBuckets ?? []).filter((b) => b !== tag)].slice(0, KNOWN_BUCKETS);
  }
}

// --- Re-checking the password of a signed-in user --------------------------
// /account/email and /account/password ask for the current password, which is
// only a gate if it cannot be guessed: with no limit, a stolen cookie could try
// ~45 passwords a second and then point the reset email at its own inbox.
// Keyed on the account (the session already proves which one), 5 failures ->
// 15 min. A thief can use this to block the real user from changing their
// password for 15 minutes; signing out the other devices still works.
export function beginReauth(userId: string): LoginTicket | null {
  sweepLimiters();
  const now = Date.now();
  const key = `reauth:${userId}`;
  if (locked(key, now)) return null;
  return { keys: [{ key, max: MAX_ATTEMPTS, drop: true, lockedByIt: countFailure(key, now, "a password re-check", MAX_ATTEMPTS) }] };
}

export function reauthSucceeded(t: LoginTicket): void {
  loginSucceeded(t);
}

/**
 * One /forgot request from `ip`: true when it may proceed. A refused request is
 * not counted, so every list stays bounded by its own limit however hard a
 * client keeps knocking.
 */
export function forgotAllowed(ip: string): boolean {
  sweepLimiters();
  const now = Date.now();
  const site = siteBucket(ip);
  const lists: Array<[string, number]> = [[limiterBucket(ip), FORGOT_PER_CLIENT]];
  if (site) lists.push([`site:${site}`, FORGOT_PER_SITE]);
  const live = lists.map(([k]) => (forgotHits.get(k) ?? []).filter((t) => now - t < LOCKOUT_MS));
  forgotGlobal = forgotGlobal.filter((t) => now - t < LOCKOUT_MS);
  if (forgotGlobal.length >= FORGOT_GLOBAL || live.some((h, i) => h.length >= lists[i][1])) return false;
  lists.forEach(([k], i) => forgotHits.set(k, [...live[i], now]));
  forgotGlobal.push(now);
  return true;
}

// A /forgot reply takes the same time whether or not the account exists, has
// an email, or was mailed. It used to run a dummy scrypt for that, in the
// ordinary scrypt lane — so a /forgot flood filled the queue and refused real
// sign-ins with 503. A timer costs nothing: every reply is held until
// FORGOT_PACE_MS (about one scrypt verify) plus jitter after it arrived, and
// the mail itself is sent in the background.
const FORGOT_PACE_MS = 90;
const FORGOT_JITTER_MS = 60;
export async function forgotPace(startedAt: number): Promise<void> {
  const wait = startedAt + FORGOT_PACE_MS + Math.random() * FORGOT_JITTER_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// One reset mail per account per this long, from anywhere: a still-fresh
// token is neither replaced nor re-sent, so nobody can mail-bomb an inbox or
// keep invalidating the link the real user is about to click.
export const RESET_TTL_MS = 30 * 60_000;
const RESET_REISSUE_MS = 10 * 60_000;
export function resetTokenFresh(user: UserRecord, now = Date.now()): boolean {
  return Boolean(user.resetToken && user.resetExpires && user.resetExpires - RESET_TTL_MS + RESET_REISSUE_MS > now);
}

/** Test/diagnostic: how many sources are tracked right now, after a sweep. */
export function limiterSizes(): { attempts: number; forgot: number; accounts: number } {
  sweepLimiters(true);
  return { attempts: attempts.size, forgot: forgotHits.size, accounts: acctReal.size + acctOther.size };
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

/**
 * AUTH_DISABLED hands every caller the owner account, so it is honoured only
 * for a request that provably came from this host or its LAN — never one that
 * came down the Cloudflare tunnel (cloudflared runs on this host, so its
 * requests have a loopback peer and must be recognised by their headers), and
 * never one a proxy says it forwarded for a non-LAN client. A LAN device that
 * forges these headers only locks itself out.
 */
export function authDisabledAllowed(req: Request): boolean {
  const h = req.headers;
  if (h["cf-ray"] !== undefined || h["cf-connecting-ip"] !== undefined || h["cf-visitor"] !== undefined) return false;
  const forwarded = [h["x-forwarded-for"], h["x-real-ip"]]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (h["forwarded"] !== undefined) return false; // RFC 7239: not parsed, so not trusted
  // DNS rebinding: a page on attacker.example that re-points its own name at
  // this server's LAN address is "same-origin" to the browser (csrfGuard's
  // Sec-Fetch-Site says so), and the request does come from a LAN address. Its
  // Host (and Origin) still say attacker.example, so only names a public page
  // can never have are accepted.
  if (!lanHostName(h.host)) return false;
  if (typeof h.origin === "string" && h.origin !== "null") {
    try { if (!lanHostName(new URL(h.origin).host)) return false; } catch { return false; }
  }
  return forwarded.every(isLanAddress) && isLanAddress(clientIp(req));
}

/** Host header value naming this server on its LAN: localhost, a LAN IP
 *  literal, a single-label or LAN-only-suffix name, or PUBLIC_URL's host. */
function lanHostName(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.trim().toLowerCase();
  const host = raw.startsWith("[") ? raw.slice(1, raw.indexOf("]")) : raw.replace(/:\d+$/, "");
  if (!host) return false;
  if (isIP(host) !== 0) return isLanAddress(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".")) return true; // "nas", "renzo": resolved by the LAN's own DNS
  if (/\.(?:local|lan|home\.arpa|internal)$/.test(host)) return true;
  try { return host === new URL(config.publicUrl).hostname.toLowerCase(); } catch { return false; }
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (config.authDisabled) {
    if (!authDisabledAllowed(req)) {
      res.status(403).json({ error: "This server has sign-in disabled and only answers its local network" });
      return;
    }
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
  const user = sessionUser(token, isMediaRequest(req));
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
function mintScopedToken(userId: string, scope: string, ttlMs: number): string {
  const body = `${userId}.${Date.now() + ttlMs}.${scopeHash(scope)}`;
  const sig = createHmac("sha256", db.dtokenSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function userFromScopedToken(token: string | undefined, scope: string): UserRecord | undefined {
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
  return db.getUser(userId);
}

export function mintDownloadToken(userId: string, scope: string): string {
  return mintScopedToken(userId, scope, DTOKEN_TTL_MS);
}

export function userFromDownloadToken(token: string | undefined, scope: string): UserRecord | undefined {
  const u = userFromScopedToken(token, scope);
  if (!u || u.downloadsDenied) return undefined;          // denied accounts can't use outstanding tokens
  return u;
}

// --- Jellyfin stream tokens --------------------------------------------------
// The Jellyfin plugin's playback URLs used to carry the long-lived per-user API
// key in ?key=, and the server re-embedded it in its own redirects — so the key
// sat in Jellyfin's DB, ffmpeg command lines and any proxy log. Playback now
// goes through a URL signed for ONE episode path (same HMAC as dtokens, but a
// distinct "jf-stream:" scope so the two can never stand in for each other).
// Longer TTL than a dtoken: Jellyfin keeps re-requesting ranges through a long,
// paused movie. Streaming stays allowed for download-denied accounts, as in
// the browser, so there is no downloadsDenied check here.
const STREAM_TOKEN_TTL_MS = 6 * 60 * 60_000;
export function mintStreamToken(userId: string, path: string): string {
  return mintScopedToken(userId, "jf-stream:" + path, STREAM_TOKEN_TTL_MS);
}
export function userFromStreamToken(token: string | undefined, path: string): UserRecord | undefined {
  return userFromScopedToken(token, "jf-stream:" + path);
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
