import crypto from "node:crypto";
import { db } from "../db.js";
import type { UserRecord, WatchToken } from "../types.js";

// Per-series watch URLs. Saved titles (in the user's library/lists) get a stable
// per-user id that's reused across sessions so the URL is consistent; unsaved
// titles get an ephemeral temp id. Both are scoped to the owning user.
const TEMP_TTL_MS = 7 * 24 * 60 * 60_000; // ~1 week
const MAX_TEMP_PER_USER = 200;

function newId(prefix: string): string {
  return prefix + crypto.randomBytes(9).toString("base64url");
}

export function watchTokenFor(user: UserRecord, titleId: number, saved: boolean): string {
  const store = db.watch();

  if (saved) {
    user.watchIds ??= {};
    const existing = user.watchIds[String(titleId)];
    if (existing && store[existing]) return existing;
    const id = newId("wu_");
    user.watchIds[String(titleId)] = id;
    store[id] = { userId: user.id, titleId, temp: false, createdAt: Date.now() };
    return id;
  }

  // Reuse a live temp token for the same user+title if one exists.
  for (const [id, w] of Object.entries(store)) {
    if (w.temp && w.userId === user.id && w.titleId === titleId) return id;
  }
  pruneTemp(store, user.id);
  const id = newId("wt_");
  store[id] = { userId: user.id, titleId, temp: true, createdAt: Date.now() };
  return id;
}

/** Resolve a watch id to its token — only for the requesting user. */
export function resolveWatch(user: UserRecord, watchId: string): WatchToken | null {
  const w = db.watch()[watchId];
  if (!w || w.userId !== user.id) return null;
  return w;
}

/** Forget a user's watch links for a title (called when it leaves their library). */
export function dropWatch(user: UserRecord, titleId: number): void {
  const store = db.watch();
  const stable = user.watchIds?.[String(titleId)];
  if (stable) { delete store[stable]; delete user.watchIds![String(titleId)]; }
  for (const [id, w] of Object.entries(store)) {
    if (w.userId === user.id && w.titleId === titleId) delete store[id];
  }
}

function pruneTemp(store: Record<string, WatchToken>, userId: string): void {
  const now = Date.now();
  for (const [id, w] of Object.entries(store)) {
    if (w.temp && now - w.createdAt > TEMP_TTL_MS) delete store[id];
  }
  // Cap is PER-USER so one user's browsing can't evict another user's tokens.
  const mine = Object.entries(store)
    .filter(([, w]) => w.temp && w.userId === userId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (let i = 0; i < mine.length - MAX_TEMP_PER_USER; i++) delete store[mine[i][0]];
}
