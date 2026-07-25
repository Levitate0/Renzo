import { config } from "../config.js";
import { logger } from "../logger.js";

const log = logger("authsite");

export type Provider = "anilist" | "myanimelist";

interface Cached {
  token: string | null; // null = known-not-connected (negative cache)
  until: number;        // epoch ms until which this entry is valid
}

// Cache the central token until ~1 min before it expires (the auth site refreshes
// itself, so we just re-fetch). Negative results are cached briefly so an
// unconnected/unreachable auth site doesn't get hammered on every scrobble.
const cache = new Map<Provider, Cached>();
const NEGATIVE_TTL_MS = 30_000;
const FALLBACK_TTL_MS = 5 * 60_000;

interface TokenResponse {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number;
  accountName?: string;
}

export function configured(): boolean {
  return Boolean(config.authsiteUrl && config.authsiteServiceKey);
}

/**
 * Fetch a provider access token from the self-hosted auth site.
 * Returns null (and treats the tracker as disconnected) for any non-200:
 *   404 not connected · 502 reconnectRequired · 401 bad key · 503 disabled ·
 *   network error. Never throws — callers degrade gracefully.
 */
export async function getToken(provider: Provider): Promise<string | null> {
  if (!configured()) return null;

  const hit = cache.get(provider);
  if (hit && Date.now() < hit.until) return hit.token;

  try {
    const res = await fetch(`${config.authsiteUrl}/api/token/${provider}`, {
      headers: { "X-Service-Key": config.authsiteServiceKey, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 200) {
      const body = (await res.json()) as TokenResponse;
      const token = body.accessToken || null;
      const until = token ? cacheUntil(body.expiresAt) : Date.now() + NEGATIVE_TTL_MS;
      cache.set(provider, { token, until });
      return token;
    }

    if (res.status === 404) {
      // Account not connected yet in the auth site dashboard.
      cache.set(provider, { token: null, until: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
    if (res.status === 502) {
      log.warn(`${provider}: token expired and refresh failed — reconnect required`);
      cache.set(provider, { token: null, until: Date.now() + NEGATIVE_TTL_MS });
      return null;
    }
    if (res.status === 401) log.warn("auth site rejected the service key (401) — check AUTHSITE_SERVICE_KEY");
    else if (res.status === 503) log.warn("auth site token API is disabled (503)");
    else log.warn(`${provider}: unexpected auth site status ${res.status}`);
    cache.set(provider, { token: null, until: Date.now() + NEGATIVE_TTL_MS });
    return null;
  } catch (e) {
    log.warn(`${provider}: auth site unreachable (${String(e)})`);
    cache.set(provider, { token: null, until: Date.now() + NEGATIVE_TTL_MS });
    return null;
  }
}

function cacheUntil(expiresAt: string | number | undefined): number {
  const now = Date.now();
  if (expiresAt != null) {
    const ms = typeof expiresAt === "number"
      ? (expiresAt < 1e12 ? expiresAt * 1000 : expiresAt) // seconds vs ms epoch
      : Date.parse(expiresAt);
    if (Number.isFinite(ms) && ms > now) {
      return Math.max(now + 10_000, ms - 60_000); // refresh ~1 min before expiry
    }
  }
  return now + FALLBACK_TTL_MS;
}
