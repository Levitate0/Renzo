import { config } from "../config.js";
import { logger } from "../logger.js";

const log = logger("jellyfin");

export function jellyfinConfigured(): boolean {
  return Boolean(config.jellyfinUrl && config.jellyfinApiKey);
}

/**
 * Ask Jellyfin to rescan its libraries so a freshly-downloaded file shows up.
 * No-op (logged) when Jellyfin isn't configured.
 */
export async function triggerScan(): Promise<boolean> {
  if (!jellyfinConfigured()) {
    log.debug("skip scan — Jellyfin not configured");
    return false;
  }
  try {
    const res = await fetch(`${config.jellyfinUrl}/Library/Refresh`, {
      method: "POST",
      headers: { "X-Emby-Token": config.jellyfinApiKey },
    });
    if (!res.ok) {
      log.warn("scan request failed", res.status);
      return false;
    }
    log.info("triggered library scan");
    return true;
  } catch (e) {
    log.warn("scan error", String(e));
    return false;
  }
}

export async function ping(): Promise<boolean> {
  if (!jellyfinConfigured()) return false;
  try {
    const res = await fetch(`${config.jellyfinUrl}/System/Info?api_key=${config.jellyfinApiKey}`);
    return res.ok;
  } catch {
    return false;
  }
}
