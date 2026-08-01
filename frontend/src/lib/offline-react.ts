"use client";
/**
 * React glue for ./offline (which stays framework-free). `useOffline()` gives
 * components a hydration-safe snapshot of offline state plus the actions; it
 * also boots the module (initOffline) and wires the download done/failed toasts
 * exactly once per page.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  chooseDownloadFolder,
  clearOfflineFlag,
  confirmPurge,
  ensureDownloadFolder,
  fetchSource,
  flushWatched,
  getDownloadFolder,
  getMeta,
  getOffline,
  hasOffline,
  initOffline,
  keepDownloads,
  manifest,
  markOffline,
  nativeStore,
  offlineCount,
  offlineDetail,
  offlineEntries,
  offlineLibrary,
  offlineSupported,
  offlineVersion,
  playbackFor,
  purgeAllOffline,
  purgePromptCount,
  queueWatched,
  removeOffline,
  saveEpisodeOffline,
  saveOffline,
  schedulePurge,
  setMeta,
  subscribeOffline,
  type OfflineEvent,
} from "./offline";
import { isNativeShell, isTv, renzoServer } from "./native";
import { api } from "./api";
import { setOfflineApi } from "./offline";

// Toasts are wired once (module-level), no matter how many components mount
// the hook — mirrors the old single boot-time listener (app.js ~425).
let toastsWired = false;
function wireToasts(): void {
  if (toastsWired) return;
  toastsWired = true;
  subscribeOffline((ev: OfflineEvent) => {
    if (ev.type === "download-done") toast(`Downloaded ${ev.title}`.trim());
    else if (ev.type === "download-error") toast(`Download failed: ${ev.error}`);
  });
}

const subscribe = (cb: () => void) => subscribeOffline(() => cb());
const getServerVersion = () => -1;

export interface OfflineSnapshot {
  /** navigator.onLine (true until mounted — render online chrome for SSR). */
  online: boolean;
  /** TV shell — hide ALL offline UI when true (mode pill display-only). */
  tv: boolean;
  /** Offline saving available at all (false on TV and unsupported browsers). */
  supported: boolean;
  /** Downloads stored on disk via a native bridge (Capacitor/Electron). */
  native: boolean;
  /** RenzoServer plugin present → show "Change server" in the account menu. */
  canChangeServer: boolean;
  /** Number of saved downloads. */
  count: number;
  /** Purge-on-reconnect prompt: null hidden, else the count to confirm. */
  purgePrompt: number | null;
  /** False until after first client render — gate offline-dependent UI on it. */
  ready: boolean;
}

const INITIAL: OfflineSnapshot = {
  online: true,
  tv: false,
  supported: false,
  native: false,
  canChangeServer: false,
  count: 0,
  purgePrompt: null,
  ready: false,
};

/**
 * Offline state + actions for components. State is snapshotted in an effect
 * (never from browser globals during render) so static-export hydration always
 * matches; gate anything offline-dependent on `ready`.
 */
export function useOffline() {
  const version = useSyncExternalStore(subscribe, offlineVersion, getServerVersion);
  const [snap, setSnap] = useState<OfflineSnapshot>(INITIAL);

  useEffect(() => {
    // Route offline's API calls through the central client (401 → auth gate,
    // 402 → credentials pane) — the core stays framework-free by injection.
    setOfflineApi((path, opts) => api(path, opts));
    initOffline();
    wireToasts();
  }, []);

  useEffect(() => {
    setSnap({
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      tv: isTv(),
      supported: offlineSupported(),
      native: nativeStore(),
      canChangeServer: !!renzoServer(),
      count: offlineCount(),
      purgePrompt: purgePromptCount(),
      ready: true,
    });
  }, [version]);

  return useMemo(
    () => ({
      ...snap,
      // manifest queries (read localStorage at call time — use in handlers/effects)
      has: hasOffline,
      get: getOffline,
      entries: offlineEntries,
      manifest,
      getMeta,
      setMeta,
      // library data
      library: offlineLibrary,
      detail: offlineDetail,
      // actions
      save: saveOffline,
      saveEpisode: saveEpisodeOffline,
      remove: removeOffline,
      purgeAll: purgeAllOffline,
      fetchSource,
      playbackFor,
      ensureDownloadFolder,
      getDownloadFolder,
      chooseDownloadFolder,
      queueWatched,
      flushWatched,
      markOffline,
      clearOfflineFlag,
      schedulePurge,
      confirmPurge,
      keepDownloads,
    }),
    [snap],
  );
}

/** Convenience for components that only need the shell flags. */
export function useNativeShell(): { native: boolean; tv: boolean; ready: boolean } {
  const [state, setState] = useState({ native: false, tv: false, ready: false });
  useEffect(() => {
    setState({ native: isNativeShell(), tv: isTv(), ready: true });
  }, []);
  return state;
}
