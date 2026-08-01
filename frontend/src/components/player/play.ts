// ---------------------------------------------------------------------------
// startWatch — the port of old `play(id, ep)` (public/app.js:1290). Every play
// button anywhere calls this: mint/reuse a per-series watch id via
// POST /titles/:id/watch, then navigate to /watch/?id=<watchId>&ep=<n>.
// Offline there is no server to mint a link, so we route to the synthetic
// `offline:<titleId>` watch id and the player plays the saved copy directly.
//
// CONTRACT for other agents (detail/browse): import { startWatch } from
// "@/components/player/play" and call it with your router — do not POST
// /titles/:id/watch yourself.
// ---------------------------------------------------------------------------

import { toast } from "sonner";

import { api } from "@/lib/api";
import type { WatchStart } from "@/lib/types";

/** Resolve the /watch/ URL for a title+episode (offline-aware). */
export async function watchHref(id: number, ep = 1): Promise<string> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return `/watch/?id=offline%3A${id}&ep=${ep}`;
  }
  const r = await api<WatchStart>(`/titles/${id}/watch`, { method: "POST" });
  return `/watch/?id=${encodeURIComponent(r.watchId)}&ep=${ep}`;
}

/** Minimal router surface so callers can pass Next's useRouter() instance. */
export interface RouterLike {
  push(href: string): void;
}

// --- came-from-title flag ---------------------------------------------------
// Port of old `detailShownId` (public/app.js:781, 1566-1573): the player's
// orange series link pops back (no duplicate history entry) ONLY when the
// entry behind the player is that title's page; otherwise it navigates to the
// series page. Callers that push /watch/ FROM a title page call
// markWatchFromTitle(id); every other entry into /watch/ clears it (null).

const FROM_TITLE_KEY = "renzo-watch-from-title";

export function markWatchFromTitle(id: number | null): void {
  try {
    if (id == null) sessionStorage.removeItem(FROM_TITLE_KEY);
    else sessionStorage.setItem(FROM_TITLE_KEY, String(id));
  } catch {
    /* storage unavailable — series link simply navigates */
  }
}

/** True when the history entry behind the player is title `id`'s page. */
export function cameFromTitle(id: number): boolean {
  try {
    return sessionStorage.getItem(FROM_TITLE_KEY) === String(id);
  } catch {
    return false;
  }
}

/** Old play(): resolve the watch link and navigate; toasts on failure. */
export async function startWatch(router: RouterLike, id: number, ep = 1): Promise<void> {
  try {
    const href = await watchHref(id, ep);
    markWatchFromTitle(null); // in-player title switches: no title page behind us
    router.push(href);
  } catch (e) {
    toast((e as Error).message || String(e));
  }
}
