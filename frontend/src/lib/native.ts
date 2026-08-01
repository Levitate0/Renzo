/**
 * Native shell access — typed wrappers around the Capacitor plugins the shipped
 * Android APK (vc21) and the Electron desktop shell expose. This file is
 * framework-free (NO React imports) and SSR-safe: every entry point guards
 * `typeof window`, so it can be imported from anywhere.
 *
 * Ground truth: `public/app.js` `setupCapacitorBridge()` (~lines 154–228) and
 * `maybeSetupNativeBackground()` (~lines 421–440). The bridge object we build is
 * ALSO published as `window.RenzoNative` — the old app did this and the shells
 * may look for it; an Electron preload that injects its own `window.RenzoNative`
 * is picked up untouched.
 */

// ---------------------------------------------------------------------------
// Wire shapes (exact plugin call shapes — do not change, shipped clients rely
// on them)
// ---------------------------------------------------------------------------

/** A subtitle track as the bridge sees it (src is absolute or file://). */
export interface NativeSubtitle {
  label?: string;
  lang?: string;
  src: string;
}

/** Payload for RenzoDownloader.enqueue / RenzoSaf.save. URLs must be absolute. */
export interface NativeSavePayload {
  key: string;
  video: string;
  title: string;
  subs: NativeSubtitle[];
}

/**
 * Result of a save/enqueue. The background downloader resolves immediately with
 * `deferred: true` and a `saf:`-marker url — the file lands later via the
 * foreground service and playback resolves through `prepare()`.
 */
export interface NativeSaveResult {
  url?: string;
  subs?: NativeSubtitle[];
  deferred?: boolean;
}

/** `RenzoSaf.prepare({key})` → on-disk playable copies (file:// urls). */
export interface SafPrepareResult {
  url: string;
  subs?: NativeSubtitle[];
}

/** One entry of `RenzoDownloader.status().jobs` (keyed by manifest key). */
export interface NativeDownloadJob {
  state?: "queued" | "running" | "done" | "error" | string;
  progress?: number;
  total?: number;
  title?: string;
  error?: string;
}

/** Payload of the RenzoDownloader "progress" event. */
export interface DownloadProgressEvent {
  key?: string;
  state?: "queued" | "running" | "done" | "error" | string;
  title?: string;
  error?: string;
  progress?: number;
  total?: number;
}

// ---------------------------------------------------------------------------
// Plugin interfaces (window.Capacitor.Plugins.*)
// ---------------------------------------------------------------------------

export interface RenzoSafPlugin {
  getFolder(): Promise<{ path?: string | null }>;
  pickFolder(): Promise<{ path?: string | null }>;
  save(payload: NativeSavePayload): Promise<NativeSaveResult>;
  /** Copy a saved episode to cache on demand → playable file:// urls. */
  prepare(opts: { key: string }): Promise<SafPrepareResult>;
  remove(opts: { key: string }): Promise<unknown>;
  purge(): Promise<unknown>;
  list(): Promise<{ keys?: string[] }>;
}

export interface RenzoDownloaderPlugin {
  /** Background foreground-service download (continues when the app is closed). */
  enqueue(payload: NativeSavePayload): Promise<NativeSaveResult>;
  status(): Promise<{ jobs?: Record<string, NativeDownloadJob> }>;
  requestNotifications(): Promise<unknown>;
  requestKeepAlive(): Promise<unknown>;
  isKeepAliveEnabled(): Promise<{ enabled?: boolean }>;
  addListener?(
    event: "progress",
    cb: (ev: DownloadProgressEvent) => void,
  ): Promise<{ remove(): Promise<void> }> | { remove(): void };
}

/** "Change server" (native clients have no server compiled in). */
export interface RenzoServerPlugin {
  get(): Promise<{ url?: string | null }>;
  set(opts: { url: string }): Promise<unknown>;
  clear(): Promise<unknown>;
}

/** @capacitor/filesystem subset used by the legacy fallback (pre-SAF builds). */
interface CapFilesystemPlugin {
  mkdir(o: { path: string; directory: string; recursive?: boolean }): Promise<unknown>;
  downloadFile(o: { url: string; path: string; directory: string; recursive?: boolean }): Promise<unknown>;
  getUri(o: { path: string; directory: string }): Promise<{ uri: string }>;
  rmdir(o: { path: string; directory: string; recursive?: boolean }): Promise<unknown>;
  readdir(o: { path: string; directory: string }): Promise<{ files: Array<{ name?: string } | string> }>;
}

export interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  convertFileSrc?: (url: string) => string;
  Plugins?: {
    RenzoSaf?: RenzoSafPlugin;
    RenzoDownloader?: RenzoDownloaderPlugin;
    RenzoServer?: RenzoServerPlugin;
    Filesystem?: CapFilesystemPlugin;
  };
}

// ---------------------------------------------------------------------------
// The RenzoNative bridge — the shape the rest of the app codes against.
// Identical to the object the old app.js published on window.RenzoNative.
// ---------------------------------------------------------------------------

export interface RenzoNativeBridge {
  platform: string;
  getFolder(): Promise<string | null>;
  chooseFolder(): Promise<string | null>;
  save(p: { key: string; video: string; subs?: NativeSubtitle[]; title?: string }): Promise<NativeSaveResult>;
  /** Present on SAF builds only — resolves a `saf:` entry to playable urls. */
  prepare?(key: string): Promise<SafPrepareResult>;
  remove(key: string): Promise<unknown>;
  purge(): Promise<unknown>;
  list(): Promise<string[]>;
  /** Downloads keep running outside the app (RenzoDownloader present). */
  background?: boolean;
  keepAliveSupported?: boolean;
  keepAlive?(): Promise<unknown>;
  keepAliveEnabled?(): Promise<boolean>;
  requestNotifications?(): Promise<unknown>;
  downloadStatus?(): Promise<Record<string, NativeDownloadJob>>;
  onProgress?(cb: (ev: DownloadProgressEvent) => void): void;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
    RenzoNative?: RenzoNativeBridge;
    /** Authoritative TV flag set by the Android shell (FEATURE_LEANBACK). */
    __RENZO_TV?: boolean;
    /** Provided by public/tvnav.js — the Android MainActivity calls these. */
    RenzoTV?: {
      enable: () => void;
      isOn: () => boolean;
      /** Returns true if it consumed Back. */
      back: () => boolean;
      playPause: () => boolean;
    };
  }
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  return window.Capacitor ?? null;
}

export function isCapacitorNative(): boolean {
  const cap = capacitor();
  return !!(cap && cap.isNativePlatform && cap.isNativePlatform());
}

/** Capacitor's file:// → webview-servable url conversion (identity on web). */
export function convertFileSrc(url: string): string {
  const cap = capacitor();
  return cap && cap.convertFileSrc ? cap.convertFileSrc(url) : url;
}

/**
 * TV detection per CONTRACTS: the shell flag OR the tv-nav class tvnav.js puts
 * on <html>/<body>. On TV every offline feature is OFF (mains-powered, no SD
 * card, useless without wifi) — check this before showing offline UI.
 */
export function isTv(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  return (
    !!window.__RENZO_TV ||
    document.documentElement.classList.contains("tv-nav") ||
    document.body.classList.contains("tv-nav")
  );
}

/** True in any native shell (Capacitor Android or an injected RenzoNative). */
export function isNativeShell(): boolean {
  return getNativeBridge() !== null;
}

/**
 * The RenzoServer plugin, or null. The "Change server" control must only render
 * when this is non-null (browsers can't honour it) — old app.js near #serverBtn.
 */
export function renzoServer(): RenzoServerPlugin | null {
  const cap = capacitor();
  return (cap && cap.Plugins && cap.Plugins.RenzoServer) || null;
}

// ---------------------------------------------------------------------------
// Bridge construction (port of setupCapacitorBridge in app.js)
// ---------------------------------------------------------------------------

const abs = (u: string): string =>
  u.startsWith("http") ? u : (typeof location !== "undefined" ? location.origin : "") + u;

let bridgeResolved = false;
let cachedBridge: RenzoNativeBridge | null = null;

/**
 * Resolve (once) the native disk-store bridge:
 * 1. a pre-injected `window.RenzoNative` (Electron preload / future shells);
 * 2. the RenzoSaf plugin (user-picked folder, background RenzoDownloader);
 * 3. legacy @capacitor/filesystem fallback (app Documents, no picker).
 * Returns null on the plain web — offline then uses Cache Storage instead.
 */
export function getNativeBridge(): RenzoNativeBridge | null {
  if (bridgeResolved) return cachedBridge;
  if (typeof window === "undefined") return null; // don't cache during SSR
  bridgeResolved = true;

  if (window.RenzoNative) {
    cachedBridge = window.RenzoNative;
    return cachedBridge;
  }
  if (!isCapacitorNative()) return null;

  const cap = window.Capacitor!;
  const Saf = cap.Plugins && cap.Plugins.RenzoSaf;
  const Dl = cap.Plugins && cap.Plugins.RenzoDownloader;

  if (Saf) {
    const bridge: RenzoNativeBridge = {
      platform: "capacitor-saf",
      getFolder: async () => {
        try { return (await Saf.getFolder()).path || null; } catch { return null; }
      },
      chooseFolder: async () => {
        try { return (await Saf.pickFolder()).path || null; } catch { return null; }
      },
      // Prefer the native background downloader (continues when app is closed);
      // fall back to RenzoSaf.save (in-app thread) on older builds without it.
      save: ({ key, video, subs, title }) => {
        const payload: NativeSavePayload = {
          key,
          video: abs(video),
          title: title || "Episode",
          subs: (subs || []).map((s) => ({ label: s.label, lang: s.lang, src: abs(s.src) })),
        };
        return Dl ? Dl.enqueue(payload) : Saf.save(payload);
      },
      prepare: (key) => Saf.prepare({ key }), // → { url: file://, subs:[{label,lang,src:file://}] }
      remove: (key) => Saf.remove({ key }),
      purge: () => Saf.purge(),
      list: async () => {
        try { return (await Saf.list()).keys || []; } catch { return []; }
      },
      background: !!Dl, // downloads keep running outside the app
      keepAliveSupported: !!Dl,
      keepAlive: () => (Dl ? Dl.requestKeepAlive() : Promise.resolve()),
      keepAliveEnabled: async () => {
        try { return Dl ? !!(await Dl.isKeepAliveEnabled()).enabled : false; } catch { return false; }
      },
      requestNotifications: () => (Dl ? Dl.requestNotifications() : Promise.resolve()),
      downloadStatus: async () => {
        try { return (Dl ? (await Dl.status()).jobs : {}) || {}; } catch { return {}; }
      },
      onProgress: (cb) => {
        try { if (Dl && Dl.addListener) void Dl.addListener("progress", cb); } catch { /* no live events */ }
      },
    };
    window.RenzoNative = bridge; // old-app parity: shells/devtools may look here
    cachedBridge = bridge;
    return bridge;
  }

  // Fallback: @capacitor/filesystem into app Documents (no folder picker).
  const FS = cap.Plugins && cap.Plugins.Filesystem;
  if (!FS) return null;
  const DIR = "DOCUMENTS";
  const dirFor = (key: string) => `Renzo/${String(key).replace(/[^\w.-]/g, "_")}`;
  const fileSrc = async (path: string) =>
    convertFileSrc((await FS.getUri({ path, directory: DIR })).uri);
  const bridge: RenzoNativeBridge = {
    platform: "capacitor",
    getFolder: async () => "Documents/Renzo",
    chooseFolder: async () => "Documents/Renzo", // app Documents (SAF picker TBD)
    async save({ key, video, subs }) {
      const dir = dirFor(key);
      await FS.mkdir({ path: dir, directory: DIR, recursive: true }).catch(() => {});
      const base = video.split("?")[0] ?? video;
      const ext = (base.match(/\.(\w{2,4})$/) || [])[1] || "mp4";
      const vpath = `${dir}/video.${ext}`;
      await FS.downloadFile({ url: abs(video), path: vpath, directory: DIR, recursive: true });
      const saved: Array<{ label?: string; lang?: string; path: string }> = [];
      const list = subs || [];
      for (let i = 0; i < list.length; i++) {
        const s = list[i]!;
        const p = `${dir}/sub${i}.vtt`;
        try {
          await FS.downloadFile({ url: abs(s.src), path: p, directory: DIR });
          saved.push({ label: s.label, lang: s.lang, path: p });
        } catch { /* missing subtitle is fine */ }
      }
      return {
        url: await fileSrc(vpath),
        subs: await Promise.all(
          saved.map(async (s) => ({ label: s.label, lang: s.lang, src: await fileSrc(s.path) })),
        ),
      };
    },
    remove: (key) => FS.rmdir({ path: dirFor(key), directory: DIR, recursive: true }).catch(() => {}),
    purge: () => FS.rmdir({ path: "Renzo", directory: DIR, recursive: true }).catch(() => {}),
    async list() {
      try {
        return (await FS.readdir({ path: "Renzo", directory: DIR })).files.map((f) =>
          typeof f === "string" ? f : f.name || "",
        );
      } catch { return []; }
    },
  };
  window.RenzoNative = bridge;
  cachedBridge = bridge;
  return bridge;
}

// ---------------------------------------------------------------------------
// Background download progress — single native listener fanned out to any
// number of subscribers (the old app attached exactly one listener at boot).
// ---------------------------------------------------------------------------

const progressSubs = new Set<(ev: DownloadProgressEvent) => void>();
let progressAttached = false;

/**
 * Subscribe to native background-download progress events. Attaches the
 * underlying RenzoDownloader listener once, on first use. Returns unsubscribe.
 * No-op (still returns a working unsubscribe) outside native shells.
 */
export function onDownloadProgress(cb: (ev: DownloadProgressEvent) => void): () => void {
  progressSubs.add(cb);
  if (!progressAttached) {
    const bridge = getNativeBridge();
    if (bridge && bridge.onProgress) {
      progressAttached = true;
      bridge.onProgress((ev) => {
        if (!ev) return;
        for (const fn of [...progressSubs]) {
          try { fn(ev); } catch { /* subscriber error must not kill the fan-out */ }
        }
      });
    }
  }
  return () => { progressSubs.delete(cb); };
}

/**
 * Ask the OS for download notifications (Android 13+ runtime permission) — only
 * meaningful when the background downloader exists. Old app.js called this once
 * at boot (maybeSetupNativeBackground). Keep-alive is deliberately NOT
 * requested: the download foreground service scopes process residency itself.
 */
export async function requestDownloadNotifications(): Promise<void> {
  const bridge = getNativeBridge();
  if (!bridge || !bridge.background || !bridge.requestNotifications) return;
  try { await bridge.requestNotifications(); } catch { /* ignore */ }
}
