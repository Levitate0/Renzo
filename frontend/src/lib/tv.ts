// ---------------------------------------------------------------------------
// TV mode — React glue ONLY. tvnav.js (public/tvnav.js, loaded verbatim from
// layout.tsx) owns ALL D-pad logic and the `window.RenzoTV` contract; nothing
// here re-implements it. These hooks (a) report whether TV mode is on and
// (b) keep the body state classes tvnav.js reads (`watching`, `detailing`)
// in sync with React page state. See CONTRACTS "DOM contract for tvnav.js".
//
// isTv() — the ONE contract check every component uses (CONTRACTS.md):
//   isTv() = window.__RENZO_TV || <html>.tv-nav || <body>.tv-nav
// On TV: no offline features anywhere, no offline gate, mode pill is
// display-only. The framework-free implementation lives in lib/native.ts
// (offline.ts needs it without React); re-exported here so both import paths
// stay valid.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { isTv } from "./native";

export { isTv } from "./native";

/**
 * True when running on a TV (shell flag or the `tv-nav` class tvnav.js sets).
 * Always false on the server and the very first client render (hydration-safe
 * for static export); flips as soon as tvnav enables TV mode — a
 * MutationObserver watches the class because enabling can happen well after
 * load (gamepadconnected event, the deferred UA-sniff timer, or the shell
 * calling RenzoTV.enable()).
 */
export function useIsTv(): boolean {
  const [tv, setTv] = useState(false);
  useEffect(() => {
    const update = () => setTv(isTv());
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return tv;
}

function useBodyFlag(name: string, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    document.body.classList.add(name);
    return () => document.body.classList.remove(name);
  }, [name, on]);
}

/**
 * Keep tvnav.js's body state classes in sync with the app:
 * - `watching`  — the player is open (Back → watchBack click, centre button
 *   becomes play/pause, focus scoped to the player)
 * - `detailing` — the title page is open (Back → Escape cascade)
 * Mount from the watch/title pages with the matching flag; classes are removed
 * on unmount so navigating away can never leave stale state behind.
 */
export function useTvBodyState(state: { watching?: boolean; detailing?: boolean }): void {
  useBodyFlag("watching", !!state.watching);
  useBodyFlag("detailing", !!state.detailing);
}
