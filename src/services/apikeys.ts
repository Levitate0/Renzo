import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import type { UserRecord } from "../types.js";

// Per-user API keys. Each Renzo account gets its own high-entropy key that
// external clients (notably the Jellyfin plugin) present to reach the plugin
// API — every request then runs as THAT user, streaming through their own
// Real-Debrid and serving only their library. Keys are opaque `rk_<random>`
// tokens stored on the user record.
const PREFIX = "rk_";

export function newApiKey(): string {
  return PREFIX + randomBytes(24).toString("base64url");
}

/** Constant-time string compare (guards key lookup against timing probes). */
function keyEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Ensure a user has a stable API key; mint + persist one on first use. */
export async function ensureApiKey(user: UserRecord): Promise<string> {
  if (!user.apiKey) {
    user.apiKey = newApiKey();
    await db.save();
  }
  return user.apiKey;
}

/** Boot migration: give every real (non-system) account an API key. */
export async function ensureAllApiKeys(): Promise<void> {
  let changed = false;
  for (const u of db.users()) {
    if (u.id === "system") continue;
    if (!u.apiKey) { u.apiKey = newApiKey(); changed = true; }
  }
  if (changed) await db.save();
}

/** Rotate a user's key — any client using the old key stops working. */
export async function rotateApiKey(user: UserRecord): Promise<string> {
  user.apiKey = newApiKey();
  await db.save();
  return user.apiKey;
}

/**
 * Resolve a presented API key to its owning user. Also honours the legacy
 * shared RENZO_PLUGIN_KEY (maps to the owner) so pre-existing single-key
 * installs keep working after the move to per-user keys.
 */
export function userByApiKey(key: string): UserRecord | undefined {
  if (!key || !key.length) return undefined;
  const users = db.users().filter((u) => u.id !== "system");
  const match = users.find((u) => u.apiKey && keyEquals(u.apiKey, key));
  if (match) return match;
  if (config.pluginKey && keyEquals(config.pluginKey, key)) {
    return users.find((u) => u.role === "owner") ?? users[0];
  }
  return undefined;
}
