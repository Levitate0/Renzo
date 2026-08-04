// ---------------------------------------------------------------------------
// Central API client — mirrors the old `api()` in public/app.js:20.
//   * same-origin credentials, JSON in/out, /api prefix
//   * 401  -> broadcast the auth-gate event (AuthProvider shows the login gate;
//             never a redirect loop)
//   * 402 realdebrid_required -> open /account/?section=credentials + toast
// Auth-flow endpoints (login/setup/reset/invite) call fetch directly in the
// gates, exactly like the old app, so a 401 there can't re-trigger the gate.
// ---------------------------------------------------------------------------
import { toast } from "sonner";

import { isTv } from "@/lib/native";
import type { ResumeMap, ResumeSaveResult } from "@/lib/types";

/** Fired on any 401 from the API — AuthProvider listens and shows the login gate. */
export const AUTH_GATE_EVENT = "renzo:auth-gate";
/** Fired to open a settings-family route: detail = { href: string }. GateHost routes it. */
export const OPEN_SETTINGS_EVENT = "renzo:open-settings";
/** Fired to open the offline Downloads gate (mode pill; phone/desktop only). */
export const OPEN_DOWNLOADS_EVENT = "renzo:open-downloads";

export function emitAppEvent(name: string, detail?: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Old settings pane name -> its post-IA-split route (Shiori's Account-vs-
 * Settings semantics: per-user panes live under /account/, appearance and
 * users are top-level routes, /settings/ keeps only owner SMTP/Email).
 */
export function settingsHref(pane = "credentials"): string {
  switch (pane) {
    case "credentials":
    case "defaults":
    case "apikey":
      return `/account/?section=${pane}`;
    case "jellyfin": // old hash alias
      return "/account/?section=apikey";
    case "appearance":
      return "/appearance/";
    case "users":
      return "/users/";
    case "smtp":
    case "email":
      return "/settings/";
    default:
      return "/account/";
  }
}

/** Ask the shell to open a settings-family page (e.g. the 402 handler below). */
export function openSettings(pane = "credentials"): void {
  emitAppEvent(OPEN_SETTINGS_EVENT, { href: settingsHref(pane) });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** True when the failure was network-level (server unreachable / offline). */
  get network(): boolean {
    return this.status === 0;
  }
}

export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
  } catch {
    throw new ApiError("Network error — server unreachable", 0);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401) {
      emitAppEvent(AUTH_GATE_EVENT);
      throw new ApiError("unauthorized", 401);
    }
    if (res.status === 402 && err.error === "realdebrid_required") {
      // TV: never auto-open the credentials page — a remote can't type API
      // tokens and the settings-family `modal` root traps D-pad focus there.
      if (isTv()) {
        toast("Connect a debrid service to this account in the Renzo web app");
      } else {
        openSettings("credentials");
        toast("Connect Real-Debrid to stream or download");
      }
      throw new ApiError("realdebrid_required", 402);
    }
    throw new ApiError(err.error || `${res.status}`, res.status);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

// --- Resume position --------------------------------------------------------
// Where playback stopped inside an episode, stored per user on the server so a
// phone and the web player continue each other. The "is this worth keeping"
// policy (too near the start / too near the end -> drop it) lives in
// src/routes/api.ts ONLY: clients post freely and read `saved` back.

/** Every saved position of one title, keyed by episode number. */
export function getResume(titleId: number): Promise<ResumeMap> {
  return api<ResumeMap>(`/titles/${titleId}/resume`);
}

/**
 * Store the current position. `durationMs` may be 0 when unknown.
 * `keepalive` lets the browser finish the request after the page is gone —
 * needed on the pagehide/hidden path, where a normal fetch is cancelled.
 */
export function saveResume(
  titleId: number,
  ep: number,
  positionMs: number,
  durationMs: number,
  keepalive = false,
): Promise<ResumeSaveResult> {
  return api<ResumeSaveResult>(`/titles/${titleId}/resume/${ep}`, {
    method: "POST",
    body: JSON.stringify({ positionMs, durationMs }),
    keepalive,
  });
}
// No client wrapper for DELETE /titles/:id/resume/:ep on purpose: every way the
// UI drops a position (episode ended, mark watched, mark season watched) already
// clears it server-side, so a client-side clear would be an unused second path.
