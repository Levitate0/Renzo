/**
 * Offline downloads — full port of the old `Offline` module plus the
 * reconnect/purge machinery around it (`public/app.js` ~lines 230–446 and the
 * offline-library rendering ~1950–2070, turned into data functions).
 *
 * Save while online, watch with no network, purge on reconnect (after asking).
 * Browsers/PWA store in Cache Storage; native shells store on disk through the
 * RenzoNative bridge (see ./native). Storage layout is a localStorage manifest
 * of `{ id, ep, url, subtitles[] }` keyed `"id:ep"`.
 *
 * This file is framework-free (NO React imports) and SSR-safe. React glue lives
 * in ./offline-react (useOffline). Components re-render via the subscribe /
 * snapshot pair at the bottom.
 */

import {
  getNativeBridge,
  convertFileSrc,
  isTv,
  onDownloadProgress,
  requestDownloadNotifications,
  type NativeSubtitle,
} from "./native";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubtitleTrack {
  label: string;
  lang: string;
  src: string;
}

/** One manifest entry, keyed "id:ep". */
export interface OfflineEntry {
  id: number;
  ep: number;
  /** Playable url — or a `saf:` marker resolved through prepare() at play time. */
  url: string;
  subtitles: SubtitleTrack[];
  label: string;
  at: number;
  /** Background download still in flight (cleared by progress/status reconcile). */
  pending?: boolean;
}

/** What /titles/:id/play/:ep and /titles/:id/offline/:ep return (subset used). */
export interface ResolvedStream {
  source: string;
  url: string;
  subtitles?: Array<{ id?: string | number; label?: string; lang?: string; src?: string }>;
  offline?: boolean;
}

export interface PlaybackSource {
  url: string;
  subtitles: SubtitleTrack[];
}

export interface OfflineEpisodeMeta {
  number: number;
  epTitle: string | null;
  thumbnail: string | null;
  aired: boolean;
}

/** Cached series metadata so offline library/detail render exactly like online. */
export interface OfflineMeta {
  id: number;
  type?: string;
  english?: string;
  romaji?: string;
  description: string;
  genres: string[];
  content: string[];
  banner: string;
  poster: string;
  year: number | null;
  seasonNum: number;
  seasonPart: number | null;
  seasonKind: string;
  seasonFormat: string | null;
  seriesKey: string | number | null;
  duration: number | null;
  episodesTotal: number;
  watchedThrough: number;
  episodeList: OfflineEpisodeMeta[];
  at: number;
}

/** Loose input for setMeta — pass the detail payload the title page fetched. */
export interface TitleDetailLike {
  id: number;
  type?: string;
  english?: string;
  romaji?: string;
  description?: string | null;
  genres?: string[];
  content?: string[];
  banner?: string | null;
  poster?: string | null;
  year?: number | null;
  seasonNum?: number | null;
  seasonPart?: number | null;
  seasonKind?: string | null;
  seasonFormat?: string | null;
  seriesKey?: string | number | null;
  duration?: number | null;
  episodesTotal?: number | null;
  watchedThrough?: number | null;
  episodeList?: Array<{
    number: number;
    epTitle?: string | null;
    thumbnail?: string | null;
    aired?: boolean;
  }>;
}

/** One card of the offline Downloads library (seasons collapsed by seriesKey). */
export interface OfflineLibraryGroup {
  /** Title id to open (latest season of the group, like the online library). */
  repId: number;
  ids: number[];
  title: string;
  poster: string;
  /** Total episodes saved across the group. */
  count: number;
  /** Number of distinct seasons collapsed into this card. */
  seasons: number;
  type: "movie" | "series";
}

/** Detail-page-shaped object built purely from cached meta + saved episodes. */
export interface OfflineTitleDetail {
  id: number;
  type: string;
  english?: string;
  romaji?: string;
  description: string;
  genres: string[];
  content: string[];
  banner: string;
  poster: string;
  year: number | null;
  seasonNum: number;
  seasonPart: number | null;
  seasonKind: string;
  seasonFormat: string | null;
  seasons: never[];
  duration: number | null;
  episodesTotal: number;
  watchedThrough: number;
  episodeList: Array<OfflineEpisodeMeta & { hasFile: boolean }>;
}

export type OfflineEvent =
  | { type: "change" }
  | { type: "purge-prompt"; count: number }
  | { type: "download-done"; key: string; title: string }
  | { type: "download-error"; key?: string; error: string };

// ---------------------------------------------------------------------------
// Constants + storage primitives
// ---------------------------------------------------------------------------

const CACHE = "renzo-offline-v1";
const KEY = "renzo:offline";
const META_KEY = "renzo:offlineMeta";
const WQ_KEY = "renzo:watchQueue";
// "we were offline since the last purge" — survives restart so a
// reconnect-while-closed still purges. See old app.js OFFLINE_FLAG comment.
const OFFLINE_FLAG = "renzo:offlineUsed";

const hasStorage = () => typeof window !== "undefined" && typeof localStorage !== "undefined";

function readJson<T>(key: string, fallback: T): T {
  if (!hasStorage()) return fallback;
  try { return JSON.parse(localStorage.getItem(key) || "") as T; } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void {
  if (!hasStorage()) return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota */ }
}

// ---------------------------------------------------------------------------
// API access — the shell's central client (with its 401/402 handling) is
// injected via setOfflineApi(); until then a minimal same-origin fallback with
// the old app's error semantics keeps this module self-contained.
// ---------------------------------------------------------------------------

export type OfflineApiFetch = (path: string, opts?: RequestInit) => Promise<unknown>;

let apiFetch: OfflineApiFetch = async (path, opts) => {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};

/** Wire the central api client in (call once from the shell provider). */
export function setOfflineApi(fn: OfflineApiFetch): void {
  apiFetch = fn;
}

// ---------------------------------------------------------------------------
// Change notification (drives useOffline re-renders + shell toasts)
// ---------------------------------------------------------------------------

type Listener = (ev: OfflineEvent) => void;
const listeners = new Set<Listener>();
let version = 0;

function emit(ev: OfflineEvent = { type: "change" }): void {
  version++;
  for (const l of [...listeners]) {
    try { l(ev); } catch { /* one listener must not break the rest */ }
  }
}

/** Subscribe to offline-state changes; returns unsubscribe. */
export function subscribeOffline(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Monotonic version for useSyncExternalStore. */
export function offlineVersion(): number {
  return version;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function manifest(): Record<string, OfflineEntry> {
  return readJson<Record<string, OfflineEntry>>(KEY, {});
}
function saveMan(m: Record<string, OfflineEntry>): void {
  writeJson(KEY, m);
  emit();
}
export function offlineKey(id: number, ep: number): string {
  return `${id}:${ep}`;
}
export function hasOffline(id: number, ep: number): boolean {
  return !!manifest()[offlineKey(id, ep)];
}
export function getOffline(id: number, ep: number): OfflineEntry | null {
  return manifest()[offlineKey(id, ep)] || null;
}
export function offlineCount(): number {
  return Object.keys(manifest()).length;
}
export function offlineEntries(): OfflineEntry[] {
  return Object.values(manifest());
}

/** True when this shell stores downloads on disk (Capacitor/Electron bridge). */
export function nativeStore(): boolean {
  return !!getNativeBridge();
}

/**
 * Offline available at all? ALWAYS false on TV (no SD card, no SAF picker,
 * mains + network powered — feature switched off there by user request; the
 * server-side Downloads queue is unaffected).
 */
export function offlineSupported(): boolean {
  if (isTv()) return false;
  if (nativeStore()) return true;
  return typeof navigator !== "undefined" && "serviceWorker" in navigator &&
    typeof window !== "undefined" && "caches" in window;
}

// ---------------------------------------------------------------------------
// Playback + save/remove/purge
// ---------------------------------------------------------------------------

/**
 * Resolve a saved entry to a playable source. SAF entries (a `saf:` marker) are
 * copied to cache on demand via the native bridge; others store a ready URL.
 */
export async function playbackFor(e: OfflineEntry): Promise<PlaybackSource> {
  const bridge = getNativeBridge();
  if (bridge && bridge.prepare && String(e.url).startsWith("saf:")) {
    const p = await bridge.prepare(offlineKey(e.id, e.ep));
    return {
      url: convertFileSrc(p.url),
      subtitles: (p.subs || []).map((s) => ({
        label: s.label || s.lang || "Sub",
        lang: s.lang || "en",
        src: convertFileSrc(s.src),
      })),
    };
  }
  return { url: e.url, subtitles: e.subtitles || [] };
}

/**
 * Pick the resolve endpoint: native shells get token-signed, cookie-free URLs
 * (`/titles/:id/offline/:ep`); the web path reuses the session-cookie one.
 */
export async function fetchSource(id: number, ep: number): Promise<ResolvedStream> {
  return (await apiFetch(
    nativeStore() ? `/titles/${id}/offline/${ep}` : `/titles/${id}/play/${ep}`,
  )) as ResolvedStream;
}

/**
 * Save the video + subtitle tracks. Native shells write to the chosen folder on
 * disk (RenzoDownloader.enqueue → deferred `saf:` url, or RenzoSaf.save);
 * browsers cache via Cache Storage. The manifest entry records a playback `url`
 * + `subtitles: [{label,lang,src}]` resolved per shell.
 */
export async function saveOffline(
  id: number,
  ep: number,
  r: ResolvedStream,
  label?: string,
): Promise<void> {
  if (r.source !== "local") throw new Error("Download this episode to your library first");
  const subs: SubtitleTrack[] = (r.subtitles || []).map((s) => ({
    label: s.label || s.lang || "Sub",
    lang: s.lang || "en",
    src: s.src || `/api/captions/${s.id}.vtt`,
  }));
  let entry: OfflineEntry;
  const bridge = getNativeBridge();
  if (bridge) {
    // → { url, subs:[{label,lang,src}] } with on-disk playable sources.
    const res = await bridge.save({
      key: offlineKey(id, ep),
      video: r.url,
      subs: subs as NativeSubtitle[],
      title: label || `E${ep}`,
    });
    // Background downloader resolves immediately (deferred); the file lands via
    // the foreground service and playback resolves through prepare() later.
    entry = {
      id, ep,
      url: res.url || "",
      subtitles: (res.subs || []).map((s) => ({
        label: s.label || s.lang || "Sub",
        lang: s.lang || "en",
        src: s.src,
      })),
      label: label || "",
      at: Date.now(),
      pending: !!res.deferred,
    };
  } else {
    if (!offlineSupported()) throw new Error("Offline isn't supported in this browser");
    const c = await caches.open(CACHE);
    for (const u of [r.url, ...subs.map((s) => s.src)]) {
      try { await c.add(new Request(u, { credentials: "include" })); } catch { /* subtitle may 404 */ }
    }
    entry = { id, ep, url: r.url, subtitles: subs, label: label || "", at: Date.now() };
  }
  const m = manifest();
  m[offlineKey(id, ep)] = entry;
  saveMan(m);
}

/**
 * Native shells stream into a user-picked folder: make sure one is picked
 * (prompting the SAF picker if not). Returns false if the user cancelled —
 * caller should abort with a "Pick a download folder" toast. Always true on
 * web / bridges without a picker. (Old app.js ~1198 and ~1223.)
 */
export async function ensureDownloadFolder(): Promise<boolean> {
  const bridge = getNativeBridge();
  if (!bridge) return true;
  const folder = await bridge.getFolder();
  if (folder) return true;
  const picked = await bridge.chooseFolder();
  return !!picked;
}

/** Folder helpers for the settings "download folder" row (old app.js ~2653). */
export async function getDownloadFolder(): Promise<string | null> {
  const bridge = getNativeBridge();
  if (!bridge) return null;
  try { return await bridge.getFolder(); } catch { return null; }
}
export async function chooseDownloadFolder(): Promise<string | null> {
  const bridge = getNativeBridge();
  if (!bridge) return null;
  try { return await bridge.chooseFolder(); } catch { return null; }
}

/** Convenience: resolve + save one episode (folder must already be ensured). */
export async function saveEpisodeOffline(id: number, ep: number, label?: string): Promise<void> {
  const r = await fetchSource(id, ep);
  await saveOffline(id, ep, r, label);
}

export async function removeOffline(id: number, ep: number): Promise<void> {
  const e = getOffline(id, ep);
  if (e) {
    const bridge = getNativeBridge();
    if (bridge) {
      await bridge.remove(offlineKey(id, ep)).catch(() => {});
    } else if (offlineSupported()) {
      const c = await caches.open(CACHE);
      for (const u of [e.url, ...(e.subtitles || []).map((s) => s.src)]) {
        await c.delete(u, { ignoreSearch: true }).catch(() => {});
      }
    }
  }
  const m = manifest();
  delete m[offlineKey(id, ep)];
  saveMan(m);
}

export async function purgeAllOffline(): Promise<void> {
  const bridge = getNativeBridge();
  if (bridge) {
    await bridge.purge().catch(() => {});
  } else if (offlineSupported()) {
    try { await caches.delete(CACHE); } catch { /* ignore */ }
  }
  writeJson(KEY, {});
  writeJson(META_KEY, {}); // drop cached series metadata too
  emit();
}

// ---------------------------------------------------------------------------
// Cached series metadata (banner / info / episodes) so the offline library and
// detail page render EXACTLY like online.
// ---------------------------------------------------------------------------

function metaMap(): Record<string, OfflineMeta> {
  return readJson<Record<string, OfflineMeta>>(META_KEY, {});
}
function saveMetaMap(m: Record<string, OfflineMeta>): void {
  writeJson(META_KEY, m);
  emit();
}

/** Cache a title's detail payload — call whenever the online detail loads. */
export function setMeta(d: TitleDetailLike | null | undefined): void {
  if (!d || !d.id) return;
  const m = metaMap();
  const prev = m[String(d.id)];
  m[String(d.id)] = {
    id: d.id,
    type: d.type,
    english: d.english,
    romaji: d.romaji,
    description: d.description || "",
    genres: d.genres || [],
    content: d.content || [],
    banner: d.banner || "",
    poster: d.poster || "",
    year: d.year ?? null,
    seasonNum: d.seasonNum ?? 1,
    seasonPart: d.seasonPart ?? null,
    seasonKind: d.seasonKind ?? "season",
    seasonFormat: d.seasonFormat ?? null,
    seriesKey: d.seriesKey ?? null,
    duration: d.duration ?? null,
    episodesTotal: d.episodesTotal ?? (d.episodeList || []).length,
    watchedThrough: Math.max(prev?.watchedThrough || 0, d.watchedThrough || 0),
    episodeList: (d.episodeList || []).map((e) => ({
      number: e.number,
      epTitle: e.epTitle || null,
      thumbnail: e.thumbnail || null,
      aired: e.aired !== false,
    })),
    at: Date.now(),
  };
  saveMetaMap(m);
}

export function getMeta(id: number): OfflineMeta | null {
  return metaMap()[String(id)] || null;
}

// ---------------------------------------------------------------------------
// Watched marks made offline, flushed to the server on reconnect
// ---------------------------------------------------------------------------

function watchQueue(): Record<string, number> {
  return readJson<Record<string, number>>(WQ_KEY, {});
}

export function queueWatched(id: number, ep: number): void {
  const q = watchQueue();
  q[String(id)] = Math.max(q[String(id)] || 0, ep);
  writeJson(WQ_KEY, q);
  const m = metaMap();
  const meta = m[String(id)];
  if (meta) {
    meta.watchedThrough = Math.max(meta.watchedThrough || 0, ep);
    saveMetaMap(m);
  } else {
    emit();
  }
}

export async function flushWatched(): Promise<void> {
  const q = watchQueue();
  const ids = Object.keys(q);
  if (!ids.length) return;
  for (const id of ids) {
    try {
      await apiFetch(`/titles/${id}/progress`, {
        method: "POST",
        body: JSON.stringify({ ep: q[id] }),
      });
      delete q[id];
    } catch { /* server unreachable — keep for the next reconnect */ }
  }
  writeJson(WQ_KEY, q);
}

// ---------------------------------------------------------------------------
// The "we were offline" flag + purge-on-reconnect prompt state.
// Downloads are purged on RECONNECT — only after we've actually been offline
// (downloads saved while online, prepping for a trip, survive until you've
// gone offline and come back). Never wiped without asking.
// ---------------------------------------------------------------------------

export function markOffline(): void {
  if (!hasStorage()) return;
  try { localStorage.setItem(OFFLINE_FLAG, "1"); } catch { /* ignore */ }
}
export function wasOffline(): boolean {
  if (!hasStorage()) return false;
  try { return localStorage.getItem(OFFLINE_FLAG) === "1"; } catch { return false; }
}
export function clearOfflineFlag(): void {
  if (!hasStorage()) return;
  try { localStorage.removeItem(OFFLINE_FLAG); } catch { /* ignore */ }
}

let purgePrompt: number | null = null; // null = hidden, n = "clear n downloads?"
let purgeTimer: ReturnType<typeof setTimeout> | null = null;

/** Current purge prompt state: null (hidden) or the download count to show. */
export function purgePromptCount(): number | null {
  return purgePrompt;
}

/**
 * Debounced reconnect check: after 8s of staying online AND the server truly
 * answering (/version), ask before clearing (guards flaky-wifi signal bursts).
 */
export function schedulePurge(): void {
  if (!offlineCount() || !wasOffline()) return; // only after an offline session
  if (purgeTimer) clearTimeout(purgeTimer);
  purgeTimer = setTimeout(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return; // dropped again — keep them
    try { await fetch("/version", { cache: "no-store" }); } catch { return; } // server truly reachable?
    if (offlineCount()) promptPurge(); // never wipe without asking
  }, 8000);
}

function promptPurge(): void {
  const n = offlineCount();
  if (!n) { clearOfflineFlag(); return; }
  if (purgePrompt !== null) return; // already asking
  purgePrompt = n;
  emit({ type: "purge-prompt", count: n });
}

/** User confirmed the reconnect purge. Returns how many were cleared. */
export async function confirmPurge(): Promise<number> {
  const n = offlineCount();
  await purgeAllOffline();
  clearOfflineFlag();
  purgePrompt = null;
  emit();
  return n;
}

/** User chose to keep downloads — honoured until the next offline session. */
export function keepDownloads(): void {
  clearOfflineFlag();
  purgePrompt = null;
  emit();
}

// ---------------------------------------------------------------------------
// Background download bookkeeping
// ---------------------------------------------------------------------------

/** A deferred (background) download finished — clear its pending flag. */
export function markOfflineReady(key: string): void {
  const m = manifest();
  const e = m[key];
  if (e && e.pending) {
    e.pending = false;
    saveMan(m);
  }
}

/**
 * Reconcile pending manifest entries against RenzoDownloader.status(): a
 * download that finished while the app was closed has no live job (or a "done"
 * one) — clear its pending flag so it plays. Errored/running jobs stay pending.
 */
export async function reconcilePendingDownloads(): Promise<void> {
  const bridge = getNativeBridge();
  if (!bridge || !bridge.downloadStatus) return;
  const m = manifest();
  const pending = Object.entries(m).filter(([, e]) => e.pending);
  if (!pending.length) return;
  const jobs = await bridge.downloadStatus();
  let changed = false;
  for (const [key, e] of pending) {
    const job = jobs[key];
    if (!job || job.state === "done") {
      e.pending = false;
      changed = true;
    }
  }
  if (changed) saveMan(m);
}

// ---------------------------------------------------------------------------
// Offline library (Downloads gate) — data for the grid + detail page
// ---------------------------------------------------------------------------

const FALLBACK_POSTER = "/android-chrome-512x512.png";

/**
 * Group saved episodes by title id, then collapse seasons of the same series
 * (shared seriesKey) into one card — the latest season's real poster/title,
 * exactly like the online library.
 */
export function offlineLibrary(): OfflineLibraryGroup[] {
  const entries = offlineEntries();
  const byTitle: Record<number, OfflineEntry[]> = {};
  entries.forEach((e) => { (byTitle[e.id] = byTitle[e.id] || []).push(e); });
  const groups: Record<string, number[]> = {};
  Object.keys(byTitle).forEach((tid) => {
    const meta = getMeta(Number(tid));
    const gk = String((meta && meta.seriesKey) || tid);
    (groups[gk] = groups[gk] || []).push(Number(tid));
  });
  return Object.values(groups).map((ids) => {
    const metas = ids.map((id) => getMeta(id)).filter((x): x is OfflineMeta => !!x);
    const rep = metas
      .slice()
      .sort((a, b) => (b.seasonNum || 0) - (a.seasonNum || 0) || (b.year || 0) - (a.year || 0))[0];
    const repId = rep ? rep.id : ids[0]!;
    const count = ids.reduce((n, id) => n + (byTitle[id] ? byTitle[id].length : 0), 0);
    const poster = (rep && (rep.poster || rep.banner)) || FALLBACK_POSTER;
    const firstEntry = (byTitle[ids[0]!] || [])[0];
    const fallbackTitle = (firstEntry?.label || `Title ${ids[0]}`).split(" · ")[0] || `Title ${ids[0]}`;
    const title = rep ? rep.english || rep.romaji || fallbackTitle : fallbackTitle;
    return {
      repId,
      ids,
      title,
      poster,
      count,
      seasons: ids.length,
      type: rep && rep.type === "movie" ? "movie" : "series",
    };
  });
}

/**
 * Rich offline detail from cached metadata (banner/info/episodes) so the page
 * looks identical to online; downloaded episodes are the playable ones.
 */
export function offlineDetail(id: number): OfflineTitleDetail {
  const meta = getMeta(id);
  const saved = offlineEntries().filter((e) => e.id === id).map((e) => e.ep);
  const has = (n: number) => saved.includes(n);
  if (meta) {
    const list: OfflineEpisodeMeta[] =
      meta.episodeList && meta.episodeList.length
        ? meta.episodeList
        : saved
            .slice()
            .sort((a, b) => a - b)
            .map((n) => ({ number: n, epTitle: null, thumbnail: null, aired: true }));
    return {
      id,
      type: meta.type || "series",
      english: meta.english,
      romaji: meta.romaji,
      description: meta.description || "",
      genres: meta.genres || [],
      content: meta.content || [],
      banner: meta.banner || "",
      poster: meta.poster || "",
      year: meta.year ?? null,
      seasonNum: meta.seasonNum ?? 1,
      seasonPart: meta.seasonPart ?? null,
      seasonKind: meta.seasonKind ?? "season",
      seasonFormat: meta.seasonFormat ?? null,
      seasons: [],
      duration: meta.duration ?? null,
      episodesTotal: meta.episodesTotal ?? list.length,
      watchedThrough: meta.watchedThrough || 0,
      episodeList: list.map((e) => ({ ...e, hasFile: has(e.number) })),
    };
  }
  // Fallback for downloads saved before metadata caching existed.
  const eps = offlineEntries().filter((e) => e.id === id).sort((a, b) => a.ep - b.ep);
  const series = (eps[0]?.label || `Title ${id}`).split(" · ")[0] || `Title ${id}`;
  return {
    id,
    type: "series",
    english: series,
    romaji: series,
    description: "",
    genres: [],
    content: [],
    banner: "",
    poster: "",
    year: null,
    seasonNum: 1,
    seasonPart: null,
    seasonKind: "season",
    seasonFormat: null,
    seasons: [],
    duration: null,
    episodesTotal: eps.length,
    watchedThrough: 0,
    episodeList: eps.map((e) => ({
      number: e.ep,
      aired: true,
      hasFile: true,
      epTitle: null,
      thumbnail: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Boot wiring — online/offline listeners, reconnect flush/purge, native
// background progress relay + notification permission. Idempotent; call from
// the shell provider (useOffline calls it too).
// ---------------------------------------------------------------------------

let inited = false;

export function initOffline(): void {
  if (inited || typeof window === "undefined") return;
  inited = true;

  window.addEventListener("online", () => {
    schedulePurge();
    void flushWatched();
    emit();
  });
  window.addEventListener("offline", () => {
    markOffline();
    emit();
  });

  if (!navigator.onLine) markOffline();
  if (navigator.onLine) {
    schedulePurge();
    void flushWatched(); // sync any offline watched marks
  }

  // Native shells: relay background-download progress into the manifest and
  // surface toasts through the event stream; ask for notification permission
  // once (keep-alive is deliberately download-scoped — never requested here).
  const bridge = getNativeBridge();
  if (bridge) {
    onDownloadProgress((ev) => {
      if (ev.state === "done") {
        if (ev.key) markOfflineReady(ev.key);
        emit({ type: "download-done", key: ev.key || "", title: ev.title || "" });
      } else if (ev.state === "error") {
        emit({ type: "download-error", key: ev.key, error: ev.error || "unknown" });
      }
    });
    void requestDownloadNotifications();
    void reconcilePendingDownloads();
  }

  // Register the offline service worker (web offline path).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
