import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";

const log = logger("tvpairing");

// ---------------------------------------------------------------------------
// TV pairing — the OAuth device-authorisation shape, deliberately.
//
// The TV shows a short `userCode` and holds a secret `deviceCode`; the user
// approves the code in a browser they are ALREADY signed into, and the TV
// collects the resulting session by polling. Only the pairing request knows
// both halves — that separation is the whole security model, so the userCode is
// never a credential and the deviceCode is never displayed.
//
// Pending requests live IN MEMORY on purpose. They last ~10 minutes, and
// db.json is rewritten WHOLE on every save — parking ephemeral state there
// would mean rewriting the entire database on every poll. A restart
// invalidating in-flight pairings is correct: the TV simply asks for a new code.
//
// The `source` every entry point takes is the RESOLVED client address
// (routes/auth.ts passes clientIp()): the socket peer for a device on the LAN,
// and the Cloudflare-attested visitor for anything arriving through the tunnel,
// which on this deployment terminates on this same host. It is shown to the
// approver as "requested from" and it keys every limiter below, so it has to be
// per-visitor — the raw socket peer is 127.0.0.1 for the whole internet here —
// and it has to be unforgeable, which is why only loopback is a trusted proxy
// (config.trustProxy, services/netip.ts).
// ---------------------------------------------------------------------------

export const EXPIRES_IN_S = 600; // ~10 minutes, per the spec
export const INTERVAL_S = 5;     // poll interval we hand the client

const EXPIRY_MS = EXPIRES_IN_S * 1000;

// No 0/O and no 1/I/L: someone is reading this off a television across a room.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 glyphs -> 31^8 ≈ 8.5e11 codes
const CODE_LEN = 8;

// Per-pending-request attempt budget: a request locks after this many failed
// attempts NAMING it, whatever state it is in, so a code that is being probed
// dies rather than staying open for the rest of its 10 minutes.
const MAX_CODE_ATTEMPTS = 5;

// Per-source budgets, keyed on the transport peer.
//  - creating pending requests is a sliding window, so nobody can farm them;
//  - failed code entry is a sliding window too: a counter that a success could
//    clear would be no limit at all, because /code is unauthenticated and an
//    attacker can always hold a valid code of their own to interleave.
const MAX_CODES_PER_SOURCE = 20;          // /code calls per source per window
const CODE_WINDOW_MS = EXPIRY_MS;         // ...over one code lifetime (10 min)
const MAX_LIVE_PER_SOURCE = 10;           // pending requests alive at once per source
const MAX_ATTEMPT_FAILURES = 5;           // failed approve/lookup per source...
const ATTEMPT_WINDOW_MS = 15 * 60_000;    // ...per 15 minutes

// Ceiling on in-flight requests, so /code can never grow the process's memory
// without bound. Far above any plausible real load (that would be 2000 people
// pairing a TV within the same ten minutes) — and reaching it takes the slot
// from whichever source is hogging the most, so a flood eats itself rather than
// everyone else (see makeRoom).
const MAX_PENDING = 2000;

// Ceilings on the per-source limiter tables. They are keyed on the caller's
// address, so without a cap a stream of distinct sources is an unbounded leak:
// 300k of them grew the heap from 4 MB to 214 MB and made a sweep take over a
// second. Two separate limits, because there are two ways to grow them:
//  - MAX_SOURCES: how many addresses are tracked at once. Oldest-first
//    eviction, the same policy the pending table uses — "oldest" here meaning
//    least recently active, which is the least valuable state to lose.
//  - MAX_HITS_PER_SOURCE: how long one address's timestamp list may get.
//    Failures are recorded even while a source is already throttled — that is
//    deliberate, it keeps the sliding window sliding forward under sustained
//    abuse — so the list is a ring: the newest MAX_HITS_PER_SOURCE stamps.
const MAX_SOURCES = 5_000;
const MAX_HITS_PER_SOURCE = 64;

export type PairError = "unknown" | "expired" | "locked" | "used" | "throttled";

type Status = "pending" | "approved" | "denied";

interface Pending {
  userCode: string;
  deviceCode: string;
  deviceName: string;
  ip: string;              // transport peer: shown to the approver AND the limiter key
  createdAt: number;
  expiresAt: number;
  status: Status;
  userId?: string;         // the approver — set only on approval
  attempts: number;        // failed attempts naming this code
  locked: boolean;
}

// Insertion-ordered (JS Map), so "the oldest request from this source" is just
// the first one found while iterating.
const byUserCode = new Map<string, Pending>();
const byDeviceCode = new Map<string, Pending>();
const liveBySource = new Map<string, number>();

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------
function randomCode(): string {
  let out = "";
  while (out.length < CODE_LEN) {
    for (const b of randomBytes(16)) {
      if (b >= 248) continue; // 248 = 31*8: reject the biased tail so glyphs stay uniform
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accept what a human actually types: any case, spaces/dashes wherever. */
export function normalizeUserCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== CODE_LEN) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// deviceName is attacker-controlled and is rendered on the approval screen, in
// the account's device list and in the server log. Beyond controls and angle
// brackets, strip the characters that make text render as something other than
// what it is: bidi overrides and isolates (U+202A-202E, U+2066-2069, U+061C)
// can turn "evil.tv" into "vt.live", and zero-width/invisible formatting
// (U+200B-200F, U+2060-2064, U+FEFF, U+00AD, U+180E) hides content or forges
// word boundaries. Escaping does not help: these are legal text, and the damage
// is done at render time.
const UNSAFE_NAME_CHARS = new RegExp(
  "[" +
    "\\u0000-\\u001f\\u007f-\\u009f" + // C0 and C1 control characters
    "<>" +                             // defence in depth behind the page's own escaping
    "\\u00ad\\u061c\\u180e" +          // soft hyphen, Arabic letter mark, Mongolian vowel separator
    "\\u200b-\\u200f" +                // zero-width space/(non-)joiners, LRM/RLM
    "\\u202a-\\u202e" +                // bidi embeddings and OVERRIDES (U+202E is the classic)
    "\\u2060-\\u2064\\u2066-\\u2069" + // word joiner, invisible operators, bidi isolates
    "\\ufeff" +                       // zero-width no-break space / BOM
  "]",
  "g",
);

function cleanDeviceName(name: string): string {
  const s = name
    .replace(UNSAFE_NAME_CHARS, "")
    .replace(/\s+/g, " ") // tabs/newlines are gone above; collapse the rest
    .trim()
    .slice(0, 64);
  return s || "Unknown device";
}

// ---------------------------------------------------------------------------
// Per-source limiters
//
// Both are sliding windows of timestamps carrying a last-activity stamp, so
// sweep() can expire an entry outright: these maps are keyed on something the
// caller supplies (its address) and are walked linearly, so entries that could
// only ever be pruned by a lockout expiring would be an unbounded leak.
// ---------------------------------------------------------------------------
interface Hits { at: number[]; last: number }

function prune(w: Hits, windowMs: number, now: number): number[] {
  w.at = w.at.filter((t) => now - t < windowMs);
  return w.at;
}

/**
 * Record a hit in a limiter table, keeping the table bounded.
 *
 * The entry is re-inserted on every hit, so the Map's own insertion order IS
 * least-recently-active order and the source to drop is simply the first key —
 * one O(1) delete per insertion, no scan. That matters: the eviction path runs
 * on unauthenticated requests, so anything that walked the table would hand an
 * attacker MAX_SOURCES units of work per request. (Entries whose windows have
 * merely drained are already dropped by sweep(), once a second, in bulk.)
 */
function recordHit(m: Map<string, Hits>, source: string, windowMs: number): Hits {
  const now = Date.now();
  const w = m.get(source) ?? { at: [], last: now };
  prune(w, windowMs, now);
  w.at.push(now);
  // Keep the newest stamps rather than refusing to record: the window has to be
  // able to slide forward, or a source could hold its own lockout open cheaply
  // and still have it expire on schedule while hammering.
  if (w.at.length > MAX_HITS_PER_SOURCE) w.at.splice(0, w.at.length - MAX_HITS_PER_SOURCE);
  w.last = now;
  m.delete(source);
  m.set(source, w); // to the back of the queue
  while (m.size > MAX_SOURCES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined || oldest === source) break;
    m.delete(oldest);
  }
  return w;
}

const codeHits = new Map<string, Hits>();

/** May this source start another pairing? Checks only — see recordCodeRequest. */
function codeRequestAllowed(source: string): boolean {
  const w = codeHits.get(source);
  if (!w) return true;
  const now = Date.now();
  w.last = now;
  return prune(w, CODE_WINDOW_MS, now).length < MAX_CODES_PER_SOURCE;
}

/** Charge the window — only once a request has actually been created, so a
 *  refused call cannot lengthen the caller's own lockout. */
function recordCodeRequest(source: string): void {
  recordHit(codeHits, source, CODE_WINDOW_MS);
}

const attemptFails = new Map<string, Hits>();

function attemptAllowed(source: string): boolean {
  const w = attemptFails.get(source);
  if (!w) return true;
  const now = Date.now();
  w.last = now;
  return prune(w, ATTEMPT_WINDOW_MS, now).length < MAX_ATTEMPT_FAILURES;
}

function recordAttemptFailure(source: string): void {
  const w = recordHit(attemptFails, source, ATTEMPT_WINDOW_MS);
  if (w.at.length === MAX_ATTEMPT_FAILURES) {
    log.warn(`throttling ${source} (${w.at.length} failed pairing codes in 15 minutes)`);
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------
// Every entry point sweeps, but the work is O(pending + sources) and a poll
// storm would otherwise make that quadratic, so it runs at most once a second.
// Nothing depends on its promptness: poll() and resolve() each re-check
// expiresAt themselves.
const SWEEP_MIN_MS = 1_000;
let lastSweep = 0;

function sweep(force = false): void {
  const now = Date.now();
  if (!force && now - lastSweep < SWEEP_MIN_MS) return;
  lastSweep = now;
  for (const p of [...byUserCode.values()]) {
    if (p.expiresAt <= now) retire(p);
  }
  for (const [source, w] of codeHits) {
    if (!prune(w, CODE_WINDOW_MS, now).length && now - w.last > CODE_WINDOW_MS) codeHits.delete(source);
  }
  for (const [source, w] of attemptFails) {
    if (!prune(w, ATTEMPT_WINDOW_MS, now).length && now - w.last > ATTEMPT_WINDOW_MS) {
      attemptFails.delete(source);
    }
  }
}
// unref'd so this timer never keeps the process alive on shutdown.
setInterval(() => sweep(true), 60_000).unref();

// ---------------------------------------------------------------------------
// API used by the routes
// ---------------------------------------------------------------------------
export interface CreatedPairing {
  userCode: string;
  deviceCode: string;
  deviceName: string;
}

function retire(p: Pending): void {
  if (!byUserCode.delete(p.userCode)) return; // already gone: don't double-decrement
  byDeviceCode.delete(p.deviceCode);
  const n = (liveBySource.get(p.ip) ?? 1) - 1;
  if (n > 0) liveBySource.set(p.ip, n);
  else liveBySource.delete(p.ip);
}

/** Drop this source's oldest live request. Returns false if it has none. */
function evictOldestFrom(source: string): boolean {
  for (const p of byUserCode.values()) {
    if (p.ip === source) {
      log.warn(`evicting pairing request "${p.deviceName}" from ${source} to make room`);
      retire(p);
      return true;
    }
  }
  return false;
}

/**
 * Try to free a slot for this caller. Two ceilings:
 *
 *  - the caller's own (MAX_LIVE_PER_SOURCE): always satisfied by dropping the
 *    caller's OWN oldest request, which harms nobody else;
 *  - the global one (MAX_PENDING): satisfied only by taking a slot from a
 *    source holding MORE than this caller would after being served. A hog is
 *    reclaimed from, so one source can never fill the table and lock everyone
 *    else out — but when nothing stands out, the request is REFUSED instead.
 *
 * That refusal is the important half. Evicting "the largest" with a `>` scan
 * from zero silently means "the first key in the map" whenever the counts tie,
 * and this map is insertion-ordered — so a flood of one-request-per-source
 * (2286 sources, one code each, all tied at 1) evicted the honest TV that had
 * been waiting longest, first. When every source is equally light there is no
 * flooder to reclaim from, and a newly arrived request has no better claim to
 * the last slot than one already waiting: first come, first served.
 *
 * Returns false when no slot could be freed.
 */
function makeRoom(source: string): boolean {
  while ((liveBySource.get(source) ?? 0) >= MAX_LIVE_PER_SOURCE) {
    if (!evictOldestFrom(source)) break; // count out of step with the table: stop
  }
  while (byUserCode.size >= MAX_PENDING) {
    const mine = liveBySource.get(source) ?? 0;
    let worst = "";
    let worstN = -1;
    for (const [src, n] of liveBySource) {
      // Ties resolve to the CALLER, never to whoever happens to be first in the
      // map (that is the longest-waiting request — precisely the wrong victim).
      if (n > worstN || (n === worstN && src === source)) { worst = src; worstN = n; }
    }
    // `mine + 1` = what this caller would hold once served. Anything that is not
    // strictly above that is not hogging, so its slot is not ours to take.
    if (worst !== source && worstN <= mine + 1) return false;
    if (!worst || !evictOldestFrom(worst)) return false; // count out of step with the table: stop
  }
  return true;
}

/** Start a pairing. Returns null when this source is over its rate, or when the
 *  instance is globally full of requests no lighter than this one's. */
export function createRequest(deviceName: string, source: string): CreatedPairing | null {
  sweep();
  if (!codeRequestAllowed(source)) {
    log.warn(`refusing pairing request from ${source}: over the per-source rate`);
    return null;
  }
  if (!makeRoom(source)) {
    log.warn(`refusing pairing request from ${source}: ${byUserCode.size} requests pending instance-wide`);
    return null;
  }
  let userCode = randomCode();
  while (byUserCode.has(userCode)) userCode = randomCode(); // collisions are absurdly rare, but free to handle
  // Same generator class as session tokens (32 random bytes, base64url).
  const deviceCode = randomBytes(32).toString("base64url");
  const now = Date.now();
  const p: Pending = {
    userCode,
    deviceCode,
    deviceName: cleanDeviceName(deviceName),
    ip: source,
    createdAt: now,
    expiresAt: now + EXPIRY_MS,
    status: "pending",
    attempts: 0,
    locked: false,
  };
  byUserCode.set(userCode, p);
  byDeviceCode.set(deviceCode, p);
  liveBySource.set(source, (liveBySource.get(source) ?? 0) + 1);
  recordCodeRequest(source);
  return { userCode, deviceCode, deviceName: p.deviceName };
}

export type PollResult =
  | { status: "pending" | "denied" | "expired" }
  | { status: "approved"; userId: string; deviceName: string };

/**
 * Poll for the outcome. A deviceCode is SINGLE-USE: the moment it reports
 * "approved" the request is retired, synchronously and before any await in the
 * caller, so a replayed deviceCode can never mint a second session.
 */
export function poll(deviceCode: string): PollResult {
  sweep();
  const p = deviceCode ? byDeviceCode.get(deviceCode) : undefined;
  if (!p) return { status: "expired" };            // unknown == expired to the client
  if (p.expiresAt < Date.now()) { retire(p); return { status: "expired" }; }
  if (p.status === "pending") return { status: "pending" };
  // "denied" outranks a prior approval: an approval that has not been collected
  // yet can still be taken back (see deny), and this is where that lands.
  if (p.status === "denied") return { status: "denied" }; // kept until expiry: it holds no credential
  retire(p);
  return { status: "approved", userId: p.userId!, deviceName: p.deviceName };
}

export interface PendingView {
  deviceName: string;
  ip: string;
  expiresAt: string;
  status: Status;
}

export type CodeResult =
  | { ok: true; view: PendingView }
  | { ok: false; error: PairError };

/**
 * Resolve a typed userCode for the approval page (and for approve/deny below).
 *
 * Every rejection costs the caller twice where it can: the per-source window
 * always, and the code's OWN attempt budget whenever the attempt named a real
 * request — in any state, which is the point. Charging only the already-used
 * codes (as this did) meant `locked` could never fire for a pending request,
 * i.e. for the only state worth attacking, so §3's per-code lockout did not
 * exist. The code is therefore looked up BEFORE the per-source throttle is
 * applied: a throttled caller that keeps naming one code has to be charged to
 * that code, or it is free to hammer it once its own window is full.
 *
 * `allow` lists the states this caller may act on. Approval is pending-only, so
 * an approved request can never be silently re-bound to a second account.
 */
function resolve(
  userCode: string,
  source: string,
  allow: readonly Status[] = ["pending"],
): { ok: true; p: Pending } | { ok: false; error: PairError } {
  sweep();
  const throttled = !attemptAllowed(source);
  const code = normalizeUserCode(userCode);
  const p = code ? byUserCode.get(code) : undefined;

  if (!p) {
    // A guess that names nothing can only be counted against the source.
    recordAttemptFailure(source);
    return { ok: false, error: throttled ? "throttled" : "unknown" };
  }
  if (p.expiresAt < Date.now()) {
    retire(p);
    recordAttemptFailure(source);
    return { ok: false, error: "expired" };
  }
  if (p.locked) {
    recordAttemptFailure(source);
    return { ok: false, error: "locked" };
  }
  if (throttled) {
    chargeCode(p); // a throttled caller naming this code is an attempt on it
    recordAttemptFailure(source);
    return { ok: false, error: "throttled" };
  }
  if (!allow.includes(p.status)) {
    chargeCode(p);
    recordAttemptFailure(source);
    return { ok: false, error: "used" };
  }
  return { ok: true, p };
}

/** Charge a failed attempt to the request it named, and lock it at the budget. */
function chargeCode(p: Pending): void {
  p.attempts += 1;
  if (!p.locked && p.attempts >= MAX_CODE_ATTEMPTS) {
    p.locked = true;
    log.warn(`pairing request "${p.deviceName}" locked after ${p.attempts} failed attempts`);
  }
}

function view(p: Pending): PendingView {
  return {
    deviceName: p.deviceName,
    ip: p.ip,
    expiresAt: new Date(p.expiresAt).toISOString(),
    status: p.status,
  };
}

/** Show the approver WHAT they are about to approve, before they grant it.
 *  Includes an approved-but-uncollected request, so the page that shows it can
 *  offer the Deny that takes it back. */
export function lookup(userCode: string, source: string): CodeResult {
  const r = resolve(userCode, source, ["pending", "approved"]);
  return r.ok ? { ok: true, view: view(r.p) } : r;
}

/**
 * Bind the pending request to the approver's account. `userId` comes from the
 * approver's OWN session — never from the request body — so the identity
 * granted is always the identity that approved.
 */
export function approve(userCode: string, userId: string, source: string): CodeResult {
  const r = resolve(userCode, source);
  if (!r.ok) return r;
  r.p.status = "approved";
  r.p.userId = userId;
  log.info(`pairing approved: "${r.p.deviceName}" (${r.p.ip}) by user ${userId}`);
  return { ok: true, view: view(r.p) };
}

/**
 * Reject a pairing — including one that has already been APPROVED but not yet
 * collected. Between approve and the TV's next poll there is no session to
 * revoke, so without this an approval made in error (or under a phish) could
 * not be taken back at all until it landed. Clearing userId is what makes it
 * final: poll() reports "denied" and there is nothing left to mint from.
 */
export function deny(userCode: string, source: string): CodeResult {
  const r = resolve(userCode, source, ["pending", "approved"]);
  if (!r.ok) return r;
  const wasApproved = r.p.status === "approved";
  r.p.status = "denied";
  r.p.userId = undefined;
  log.info(
    `pairing denied: "${r.p.deviceName}" (${r.p.ip})${wasApproved ? " — approval taken back before collection" : ""}`,
  );
  return { ok: true, view: view(r.p) };
}

/**
 * Test/diagnostic helper: how big are the in-memory tables right now, after a
 * forced sweep. Every one of them is keyed on something a caller supplies (its
 * address) and walked linearly, so "does this shrink again" is a property worth
 * being able to assert rather than reason about.
 */
export function tableSizes(): { pending: number; sources: number; rateWindows: number; failWindows: number } {
  sweep(true);
  return {
    pending: byUserCode.size,
    sources: liveBySource.size,
    rateWindows: codeHits.size,
    failWindows: attemptFails.size,
  };
}
