"use strict";

// history.length when the app loaded — lets Back tell genuine in-app navigation
// (hash pushes) from pre-load entries, so deep-linked users are never ejected.
const START_LEN = history.length;

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) { showAuthGate(); throw new Error("unauthorized"); }
    if (res.status === 402 && err.error === "realdebrid_required") {
      openSettings("credentials");
      toast("Connect Real-Debrid to stream or download");
      throw new Error("realdebrid_required");
    }
    throw new Error(err.error || `${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  if (location.hash) location.hash = ""; // leave any player/detail overlay (hashchange -> route tears it down)
  document.querySelectorAll(".tabs button, .drawer-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "library") loadLibrary();
  if (name === "downloads") loadJobs();
  if (name === "updates") loadUpdates();
  if (name === "history") loadHistory();
  if (name === "appearance") renderAppearance();
}

// --- Navigation chrome: tab icons + mobile drawer + ⌘K search (Shiori-style) ---
const NAV_ICONS = {
  discover: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  updates: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  history: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  downloads: '<path d="M12 13v8"/><path d="m8 17 4 4 4-4"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>',
};
function navSvg(name, cls) {
  // Explicit width/height attributes (not just CSS) — some webviews render a
  // viewBox-only inline SVG at its huge default size otherwise.
  return `<svg class="${cls}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[name] || ""}</svg>`;
}
function setupNav() {
  // Desktop: prepend an icon to each tab pill.
  document.querySelectorAll(".tabs button").forEach((b) => {
    const t = b.dataset.tab;
    if (t && NAV_ICONS[t] && !b.querySelector(".nav-ic")) b.insertAdjacentHTML("afterbegin", navSvg(t, "nav-ic"));
  });
  // Mobile drawer rows mirror the tabs (label + any badge).
  const list = $("#drawerTabs");
  if (list) {
    list.innerHTML = "";
    document.querySelectorAll(".tabs button").forEach((b) => {
      const t = b.dataset.tab;
      if (!t) return;
      const label = (b.querySelector(".badge") ? b.textContent.replace(/\d+$/, "") : b.textContent).trim();
      const row = el("button", "drawer-tab" + (b.classList.contains("active") ? " active" : ""));
      row.dataset.tab = t;
      row.innerHTML = navSvg(t, "nav-ic") + `<span>${esc(label)}</span>`;
      row.addEventListener("click", () => { switchTab(t); closeDrawer(); });
      list.append(row);
    });
  }
}
function openDrawer() { $("#navDrawer")?.classList.remove("hidden"); $("#navScrim")?.classList.remove("hidden"); }
function closeDrawer() { $("#navDrawer")?.classList.add("hidden"); $("#navScrim")?.classList.add("hidden"); }
$("#navToggle")?.addEventListener("click", openDrawer);
$("#navClose")?.addEventListener("click", closeDrawer);
$("#navScrim")?.addEventListener("click", closeDrawer);
// ⌘K / Ctrl-K focuses search.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!$("#view-discover")?.classList.contains("active")) switchTab("discover");
    $("#search")?.focus();
  }
});
setupNav();

// Stop the browser's password manager from treating every text box (search,
// folder names, etc.) as a login username. It classifies fields that way when the
// page contains type=password inputs — so once signed in, convert all NON-login
// password fields to masked text and opt every non-auth field out of autofill.
// The auth gates (login/setup/reset) keep real password fields; logout reloads.
function suppressAutofill() {
  // Only ever called once authenticated (auth gates are hidden and logout reloads
  // the page), so it's safe to neutralize every password field — leaving no login
  // form for the browser to anchor to.
  document.querySelectorAll('input[type="password"]').forEach((n) => {
    n.type = "text";
    n.classList.add("masked");
  });
  // The reliable cross-browser opt-out: browsers/managers don't autofill or pop
  // their dropdown on a READONLY field. Start read-only, unlock on first focus/tap.
  document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=range]), textarea")
    .forEach((n) => {
      n.setAttribute("autocomplete", "off");
      n.setAttribute("data-1p-ignore", "");
      n.setAttribute("data-lpignore", "true");
      n.setAttribute("data-form-type", "other");
      if (n.dataset.afGuard) return;
      n.dataset.afGuard = "1";
      if (n.readOnly) return; // readonly by design (e.g. the API-key display) — leave it
      n.setAttribute("readonly", "");
      const unlock = () => n.removeAttribute("readonly");
      n.addEventListener("focus", unlock);
      n.addEventListener("pointerdown", unlock);
    });
}

async function loadHistory() {
  try {
    const items = await api("/history");
    const grid = $("#historyGrid");
    renderGrid(grid, items);
    if (!items.length) grid.innerHTML = '<div class="empty">Nothing watched yet — mark episodes watched or finish one in the player.</div>';
  } catch { /* ignore */ }
}

// Capacitor (Android) offline bridge — defined here (served remotely) so the app
// gets native disk downloads without bundling anything; uses the Filesystem +
// Network plugins baked into the APK. Set up before Offline reads window.RenzoNative.
(function setupCapacitorBridge() {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform() || window.RenzoNative) return;
  const abs = (u) => (u.startsWith("http") ? u : location.origin + u);

  // Preferred: the RenzoSaf plugin — user picks any folder (SD card, etc.), files
  // stream into it, and playback copies to cache on demand (prepare()).
  const Saf = Cap.Plugins && Cap.Plugins.RenzoSaf;
  const Dl = Cap.Plugins && Cap.Plugins.RenzoDownloader; // background foreground-service downloader
  if (Saf) {
    window.RenzoNative = {
      platform: "capacitor-saf",
      getFolder: async () => { try { return (await Saf.getFolder()).path || null; } catch { return null; } },
      chooseFolder: async () => { try { return (await Saf.pickFolder()).path || null; } catch { return null; } },
      // Prefer the native background downloader (continues when app is closed);
      // fall back to RenzoSaf.save (in-app thread) on older builds without it.
      save: ({ key, video, subs, title }) => {
        const payload = {
          key, video: abs(video), title: title || "Episode",
          subs: (subs || []).map((s) => ({ label: s.label, lang: s.lang, src: abs(s.src) })),
        };
        return Dl ? Dl.enqueue(payload) : Saf.save(payload);
      },
      prepare: (key) => Saf.prepare({ key }),      // -> { url: file://, subs:[{label,lang,src:file://}] }
      remove: (key) => Saf.remove({ key }),
      purge: () => Saf.purge(),
      list: async () => { try { return (await Saf.list()).keys || []; } catch { return []; } },
      background: !!Dl,     // downloads keep running outside the app
      // Keep-alive: exempt Renzo from battery optimisation so a backgrounded
      // WebView process isn't killed (which would force a reload on return).
      keepAliveSupported: !!Dl,
      keepAlive: () => (Dl ? Dl.requestKeepAlive() : Promise.resolve()),
      keepAliveEnabled: async () => { try { return Dl ? (await Dl.isKeepAliveEnabled()).enabled : false; } catch { return false; } },
      requestNotifications: () => (Dl ? Dl.requestNotifications() : Promise.resolve()),
      downloadStatus: async () => { try { return Dl ? (await Dl.status()).jobs : {}; } catch { return {}; } },
      onProgress: (cb) => { try { if (Dl && Dl.addListener) Dl.addListener("progress", cb); } catch { /* no live events */ } },
    };
    return;
  }

  // Fallback: @capacitor/filesystem into app Documents (no folder picker).
  const FS = Cap.Plugins && Cap.Plugins.Filesystem;
  if (!FS) return;
  const DIR = "DOCUMENTS";
  const dirFor = (key) => `Renzo/${String(key).replace(/[^\w.-]/g, "_")}`;
  const src = async (path) => Cap.convertFileSrc((await FS.getUri({ path, directory: DIR })).uri);
  window.RenzoNative = {
    platform: "capacitor",
    getFolder: async () => "Documents/Renzo",
    chooseFolder: async () => "Documents/Renzo", // Android app Documents (SAF picker TBD)
    async save({ key, video, subs }) {
      const dir = dirFor(key);
      await FS.mkdir({ path: dir, directory: DIR, recursive: true }).catch(() => {});
      const ext = ((video.split("?")[0].match(/\.(\w{2,4})$/) || [, "mp4"])[1]) || "mp4";
      const vpath = `${dir}/video.${ext}`;
      await FS.downloadFile({ url: abs(video), path: vpath, directory: DIR, recursive: true });
      const saved = [];
      for (let i = 0; i < (subs || []).length; i++) {
        const p = `${dir}/sub${i}.vtt`;
        try { await FS.downloadFile({ url: abs(subs[i].src), path: p, directory: DIR }); saved.push({ label: subs[i].label, lang: subs[i].lang, path: p }); }
        catch { /* missing subtitle is fine */ }
      }
      return {
        url: await src(vpath),
        subs: await Promise.all(saved.map(async (s) => ({ label: s.label, lang: s.lang, src: await src(s.path) }))),
      };
    },
    remove: (key) => FS.rmdir({ path: dirFor(key), directory: DIR, recursive: true }).catch(() => {}),
    purge: () => FS.rmdir({ path: "Renzo", directory: DIR, recursive: true }).catch(() => {}),
    async list() { try { return (await FS.readdir({ path: "Renzo", directory: DIR })).files.map((f) => f.name || f); } catch { return []; } },
  };
})();

// ---------------------------------------------------------------------------
// Offline downloads — save while online, watch with no network, auto-purge on
// reconnect. The browser/PWA path stores in the SW cache; native shells
// (Electron/Capacitor) provide window.RenzoNative for on-disk storage. Storage
// layout is a localStorage manifest of { id, ep, url, subtitles[] } keyed "id:ep".
// ---------------------------------------------------------------------------
const Offline = {
  CACHE: "renzo-offline-v1",
  KEY: "renzo:offline",
  bridge: (typeof window !== "undefined" && window.RenzoNative) || null, // native shell disk store
  supported() { if (isTv()) return false; return !!this.bridge || ("serviceWorker" in navigator && "caches" in window); },
  native() { return !!this.bridge; },
  man() { try { return JSON.parse(localStorage.getItem(this.KEY) || "{}"); } catch { return {}; } },
  saveMan(m) { try { localStorage.setItem(this.KEY, JSON.stringify(m)); } catch { /* quota */ } },
  k(id, ep) { return `${id}:${ep}`; },
  has(id, ep) { return !!this.man()[this.k(id, ep)]; },
  get(id, ep) { return this.man()[this.k(id, ep)] || null; },
  count() { return Object.keys(this.man()).length; },
  // Resolve a saved entry to a playable source. SAF entries (a "saf:" marker) are
  // copied to cache on demand via the native bridge; others store a ready URL.
  async playbackFor(e) {
    if (this.native() && this.bridge.prepare && String(e.url).startsWith("saf:")) {
      const p = await this.bridge.prepare(this.k(e.id, e.ep));
      const conv = (u) => (window.Capacitor && window.Capacitor.convertFileSrc ? window.Capacitor.convertFileSrc(u) : u);
      return { url: conv(p.url), subtitles: (p.subs || []).map((s) => ({ label: s.label, lang: s.lang, src: conv(s.src) })) };
    }
    return { url: e.url, subtitles: e.subtitles || [] };
  },
  // Save the video + subtitle tracks. Native shells write to the chosen folder on
  // disk (RenzoNative); browsers/PWA cache via the service worker. Manifest entry
  // records a playback `url` + `subtitles: [{label,lang,src}]` resolved per shell.
  // Pick the resolve endpoint: native shells get token-signed, cookie-free URLs.
  async fetchSource(id, ep) {
    return api(this.native() ? `/titles/${id}/offline/${ep}` : `/titles/${id}/play/${ep}`);
  },
  async save(id, ep, r, label) {
    if (r.source !== "local") throw new Error("Download this episode to your library first");
    const subs = (r.subtitles || []).map((s) => ({ label: s.label || s.lang || "Sub", lang: s.lang || "en", src: s.src || `/api/captions/${s.id}.vtt` }));
    let entry;
    if (this.native()) {
      // { url, subs:[{label,lang,src}] } with on-disk playable sources.
      const res = await this.bridge.save({ key: this.k(id, ep), video: r.url, subs, title: label || `E${ep}` });
      // Background downloader resolves immediately (deferred); the file lands via
      // the foreground service and playback resolves through prepare() later.
      entry = { id, ep, url: res.url, subtitles: res.subs || [], label: label || "", at: Date.now(), pending: !!res.deferred };
    } else {
      if (!this.supported()) throw new Error("Offline isn't supported in this browser");
      const c = await caches.open(this.CACHE);
      for (const u of [r.url, ...subs.map((s) => s.src)]) {
        try { await c.add(new Request(u, { credentials: "include" })); } catch { /* subtitle may 404 */ }
      }
      entry = { id, ep, url: r.url, subtitles: subs, label: label || "", at: Date.now() };
    }
    const m = this.man(); m[this.k(id, ep)] = entry; this.saveMan(m);
  },
  async remove(id, ep) {
    const e = this.get(id, ep);
    if (e) {
      if (this.native()) { await this.bridge.remove(this.k(id, ep)).catch(() => {}); }
      else if (this.supported()) {
        const c = await caches.open(this.CACHE);
        for (const u of [e.url, ...(e.subtitles || []).map((s) => s.src)]) await c.delete(u, { ignoreSearch: true }).catch(() => {});
      }
    }
    const m = this.man(); delete m[this.k(id, ep)]; this.saveMan(m);
  },
  async purgeAll() {
    if (this.native()) { await this.bridge.purge().catch(() => {}); }
    else if (this.supported()) { try { await caches.delete(this.CACHE); } catch { /* ignore */ } }
    this.saveMan({});
    this.saveMetaMap({}); // drop cached series metadata too
  },

  // --- cached series metadata (banner / info / episodes) so the offline library
  // and detail page render EXACTLY like online -----------------------------
  META_KEY: "renzo:offlineMeta",
  meta() { try { return JSON.parse(localStorage.getItem(this.META_KEY) || "{}"); } catch { return {}; } },
  saveMetaMap(m) { try { localStorage.setItem(this.META_KEY, JSON.stringify(m)); } catch { /* quota */ } },
  setMeta(d) {
    if (!d || !d.id) return;
    const m = this.meta();
    const prev = m[d.id] || {};
    m[d.id] = {
      id: d.id, type: d.type, english: d.english, romaji: d.romaji,
      description: d.description || "", genres: d.genres || [], content: d.content || [],
      banner: d.banner || "", poster: d.poster || "", year: d.year ?? null,
      seasonNum: d.seasonNum ?? 1, seasonPart: d.seasonPart ?? null, seasonKind: d.seasonKind ?? "season", seasonFormat: d.seasonFormat ?? null, seriesKey: d.seriesKey ?? null,
      duration: d.duration ?? null, episodesTotal: d.episodesTotal ?? (d.episodeList || []).length,
      watchedThrough: Math.max(prev.watchedThrough || 0, d.watchedThrough || 0),
      episodeList: (d.episodeList || []).map((e) => ({
        number: e.number, epTitle: e.epTitle || null, thumbnail: e.thumbnail || null, aired: e.aired !== false,
      })),
      at: Date.now(),
    };
    this.saveMetaMap(m);
  },
  getMeta(id) { return this.meta()[id] || null; },

  // --- watched marks made offline, flushed to the server on reconnect ------
  WQ_KEY: "renzo:watchQueue",
  watchQueue() { try { return JSON.parse(localStorage.getItem(this.WQ_KEY) || "{}"); } catch { return {}; } },
  queueWatched(id, ep) {
    const q = this.watchQueue(); q[id] = Math.max(q[id] || 0, ep);
    try { localStorage.setItem(this.WQ_KEY, JSON.stringify(q)); } catch { /* quota */ }
    const m = this.meta(); if (m[id]) { m[id].watchedThrough = Math.max(m[id].watchedThrough || 0, ep); this.saveMetaMap(m); }
  },
  async flushWatched() {
    const q = this.watchQueue(); const ids = Object.keys(q);
    if (!ids.length) return;
    for (const id of ids) {
      try { await api(`/titles/${id}/progress`, { method: "POST", body: JSON.stringify({ ep: q[id] }) }); delete q[id]; }
      catch { /* server unreachable — keep for the next reconnect */ }
    }
    try { localStorage.setItem(this.WQ_KEY, JSON.stringify(q)); } catch { /* quota */ }
  },
};

// Downloads are purged on RECONNECT — i.e. only after we've actually been
// offline (so downloads saved while online, prepping for a trip, survive until
// you've gone offline and come back). The flag records "we were offline since the
// last purge"; it survives an app restart so a reconnect-while-closed still purges.
const OFFLINE_FLAG = "renzo:offlineUsed";
// Android TV is mains-powered and network-dependent: there is no SD card to save
// to, no SAF picker, and the box is useless without wifi anyway. So the whole
// save-for-offline feature is switched off there (user request) — the server-side
// Downloads queue is unaffected.
function isTv() {
  return !!window.__RENZO_TV
    || document.documentElement.classList.contains("tv-nav")
    || document.body.classList.contains("tv-nav");
}
function markOffline() { try { localStorage.setItem(OFFLINE_FLAG, "1"); } catch { /* ignore */ } }
function wasOffline() { try { return localStorage.getItem(OFFLINE_FLAG) === "1"; } catch { return false; } }
function clearOfflineFlag() { try { localStorage.removeItem(OFFLINE_FLAG); } catch { /* ignore */ } }

let _purgeTimer = null;
function schedulePurge() {
  if (!Offline.count() || !wasOffline()) return;         // only after an offline session
  clearTimeout(_purgeTimer);
  _purgeTimer = setTimeout(async () => {
    if (!navigator.onLine) return;                       // dropped again — keep them (debounce flaky wifi)
    try { await fetch("/version", { cache: "no-store" }); } catch { return; } // server truly reachable?
    if (Offline.count()) promptPurge();                  // never wipe without asking (guards signal bursts)
  }, 8000);
}

// Ask before clearing downloads on reconnect (a short blip shouldn't nuke them).
function promptPurge() {
  const n = Offline.count();
  if (!n) { clearOfflineFlag(); return; }
  const box = $("#offlinePurgePrompt");
  if (!box || !box.classList.contains("hidden")) return; // already asking
  $("#offlinePurgeText").textContent = `Back online — clear ${n} offline download${n === 1 ? "" : "s"}?`;
  box.classList.remove("hidden");
}
async function confirmPurge() {
  const n = Offline.count();
  await Offline.purgeAll();
  clearOfflineFlag();
  $("#offlinePurgePrompt").classList.add("hidden");
  updateOfflineUi();
  if (current && !$("#detail").classList.contains("hidden")) { detailShownId = null; enterDetail(current.id); }
  if (n) toast(`Cleared ${n} offline download${n === 1 ? "" : "s"}`);
}
function keepDownloads() {
  clearOfflineFlag(); // honoured for now; re-prompts after the next offline session
  $("#offlinePurgePrompt").classList.add("hidden");
}
$("#offlinePurgeClear").addEventListener("click", confirmPurge);
$("#offlinePurgeKeep").addEventListener("click", keepDownloads);
function updateOfflineUi() {
  const off = !navigator.onLine;
  const bar = $("#offlineBar");
  if (bar) {
    bar.classList.toggle("hidden", !off);
    if (off) bar.textContent = Offline.count()
      ? `● Offline — ${Offline.count()} download${Offline.count() === 1 ? "" : "s"} available`
      : "● Offline — no downloads saved";
  }
  // Topbar mode indicator (also the button that opens your Downloads).
  const pill = $("#modePill");
  if (pill) { pill.textContent = off ? "● Offline" : "● Online"; pill.classList.toggle("offline", off); }
}
$("#modePill") && $("#modePill").addEventListener("click", () => { if (!isTv()) openDownloads(); });
window.addEventListener("online", () => { schedulePurge(); updateOfflineUi(); Offline.flushWatched(); });
window.addEventListener("offline", () => { markOffline(); updateOfflineUi(); });
if (!navigator.onLine) markOffline();
updateOfflineUi();                         // reflect current state on boot
if (navigator.onLine) { schedulePurge(); Offline.flushWatched(); } // sync any offline watched marks

// Native shells (Capacitor): relay background-download progress and, once, ask the
// OS to keep Renzo alive so backgrounding it doesn't force a full reload on return.
async function maybeSetupNativeBackground() {
  const b = Offline.bridge;
  if (!b) return;
  if (b.onProgress) b.onProgress((ev) => {
    if (!ev) return;
    if (ev.state === "done") { markOfflineReady(ev.key); toast(`Downloaded ${ev.title || ""}`.trim()); }
    else if (ev.state === "error") toast(`Download failed: ${ev.error || "unknown"}`);
  });
  // Keep-alive is intentionally DOWNLOAD-SCOPED: the foreground download service
  // keeps the process resident only while downloads are running, so tabbing out
  // won't restart the app until they finish — then normal behaviour resumes. We
  // deliberately do NOT request a permanent battery-optimisation exemption.
  try { if (b.background && b.requestNotifications) await b.requestNotifications(); } catch { /* ignore */ }
}
// A deferred (background) download finished — clear the pending flag on its entry.
function markOfflineReady(key) {
  const m = Offline.man();
  if (m[key] && m[key].pending) { m[key].pending = false; Offline.saveMan(m); }
}

// Register the offline service worker (kept here, not inline in index.html, so it
// passes the strict CSP script-src 'self').
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// The player/detail overlays sit below the sticky topbar; keep their top offset
// in sync with the topbar's real height (it wraps taller on narrow screens).
function syncTopbarH() {
  const bar = document.querySelector(".topbar");
  if (bar) document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
}
window.addEventListener("resize", syncTopbarH);
syncTopbarH();

// ---------------------------------------------------------------------------
// Themes (per-user, persisted; applied via CSS variables)
// ---------------------------------------------------------------------------
const THEMES = {
  renzo:    { name: "Renzo", vars: {} },
  amoled:   { name: "AMOLED", vars: { "--bg": "#000000", "--s1": "#0a0a0c", "--s2": "#101014", "--s3": "#17171e", "--line": "#1d1d26", "--line-2": "#2b2b36", "--glow-1": "transparent", "--glow-2": "transparent" } },
  midnight: { name: "Midnight", vars: { "--bg": "#0a0e1a", "--s1": "#0f1424", "--s2": "#141b2e", "--s3": "#1d2540", "--line": "#232c46", "--line-2": "#34406a", "--accent": "#6c8cff", "--accent-2": "#9a86ff", "--glow-1": "#12203f", "--glow-2": "#161a36" } },
  sakura:   { name: "Sakura", vars: { "--accent": "#ff8fb3", "--accent-2": "#c792ea", "--glow-1": "#2a1826", "--glow-2": "#241a2e" } },
  matcha:   { name: "Matcha", vars: { "--accent": "#4fc98a", "--accent-2": "#8bc34a", "--glow-1": "#122318", "--glow-2": "#16211a" } },
  ember:    { name: "Ember", vars: { "--accent": "#ff7a45", "--accent-2": "#ffb347", "--glow-1": "#2a170f", "--glow-2": "#241a12" } },
  ocean:    { name: "Ocean", vars: { "--bg": "#08131a", "--s1": "#0c1c26", "--s2": "#102631", "--s3": "#173544", "--line": "#1e3949", "--line-2": "#2b5266", "--accent": "#22c1c3", "--accent-2": "#3f8cff", "--glow-1": "#0d2733", "--glow-2": "#0c1f2e" } },
  light:    { name: "Daylight", vars: { "--bg": "#eef1f6", "--s1": "#ffffff", "--s2": "#ffffff", "--s3": "#e9edf4", "--line": "#dfe4ee", "--line-2": "#cbd3e1", "--fg": "#141824", "--muted": "#5b6473", "--faint": "#8a93a3", "--accent": "#e0356f", "--accent-2": "#3f6bff", "--glow-1": "transparent", "--glow-2": "transparent", "--shadow": "0 18px 50px rgba(20,30,60,.15)" } },
};
const THEME_VARS = ["--bg", "--s1", "--s2", "--s3", "--line", "--line-2", "--fg", "--muted", "--faint", "--accent", "--accent-2", "--glow-1", "--glow-2", "--shadow"];
let currentTheme = { preset: "renzo" };

function applyTheme(theme) {
  const preset = theme && THEMES[theme.preset] ? theme.preset : "renzo";
  const root = document.documentElement;
  THEME_VARS.forEach((v) => root.style.removeProperty(v)); // reset previously-managed vars
  Object.entries(THEMES[preset].vars).forEach(([k, v]) => root.style.setProperty(k, v));
  if (theme?.accent) root.style.setProperty("--accent", theme.accent);
  if (theme?.bg) root.style.setProperty("--bg", theme.bg);
  currentTheme = { preset, ...(theme?.accent ? { accent: theme.accent } : {}), ...(theme?.bg ? { bg: theme.bg } : {}) };
}

// Apply the saved theme instantly (before /me) to avoid a flash of the default.
try { const s = JSON.parse(localStorage.getItem("renzo:theme") || "null"); if (s) applyTheme(s); } catch { /* ignore */ }

function persistTheme() {
  try { localStorage.setItem("renzo:theme", JSON.stringify(currentTheme)); } catch { /* ignore */ }
  if (typeof me !== "undefined" && me) me.theme = currentTheme;
  api("/account/theme", { method: "POST", body: JSON.stringify(currentTheme) }).catch(() => {});
}
function selectTheme(theme) { applyTheme(theme); persistTheme(); renderAppearance(); }

function renderAppearance() {
  const grid = $("#themeGrid");
  if (!grid) return;
  grid.innerHTML = "";
  Object.entries(THEMES).forEach(([id, t]) => {
    const bg = t.vars["--bg"] || "#0b0c10";
    const s2 = t.vars["--s2"] || "#1a1d29";
    const accent = t.vars["--accent"] || "#ff5c8a";
    const sw = el("div", "theme-swatch" + (currentTheme.preset === id ? " active" : ""));
    sw.innerHTML = `<div class="sw-prev" style="background:${bg}">
        <span class="sw-card" style="background:${s2}"></span>
        <span class="sw-accent" style="background:${accent}"></span>
      </div><div class="sw-name">${esc(t.name)}</div>`;
    sw.addEventListener("click", () => selectTheme({ preset: id, accent: currentTheme.accent }));
    grid.append(sw);
  });
  const pick = $("#accentPick");
  if (pick) pick.value = currentTheme.accent || THEMES[currentTheme.preset]?.vars["--accent"] || "#ff5c8a";
}

$("#accentPick").addEventListener("input", () => selectTheme({ preset: currentTheme.preset, accent: $("#accentPick").value }));
$("#accentClear").addEventListener("click", () => selectTheme({ preset: currentTheme.preset }));
$("#appearanceBtn").addEventListener("click", () => { $("#acctMenu").classList.add("hidden"); switchTab("appearance"); });

async function loadUpdates() {
  try {
    const items = await api("/updates");
    const badge = $("#updBadge");
    badge.textContent = items.length;
    badge.classList.toggle("hidden", items.length === 0);
    const cards = items.map((u) => ({
      id: u.id, type: u.type, title: u.title, poster: u.poster, year: u.year,
      updKind: u.kind, ep: u.ep, upcoming: u.upcoming, season: u.season,
    }));
    renderGrid($("#updatesGrid"), cards);
    if (!items.length) $("#updatesGrid").innerHTML = '<div class="empty">You\'re all caught up — no new episodes or seasons.</div>';
  } catch (e) { /* ignore */ }
}
async function refreshUpdatesBadge() {
  try {
    const items = await api("/updates");
    const badge = $("#updBadge");
    badge.textContent = items.length;
    badge.classList.toggle("hidden", items.length === 0);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
async function loadStatus() {
  try {
    const s = await api("/health");
    const rdMap = { premium: "RD ✓", "not-premium": "RD ⚠ (free)", connected: "RD ✓", "not-connected": "RD ✗", invalid: "RD ✗" };
    const rd = rdMap[s.realdebrid] || "RD ✗";
    const tr = [s.trackers.anilist && "AniList", s.trackers.mal && "MAL"].filter(Boolean).join("+");
    $("#status").textContent = [rd, tr && `⇄ ${tr}`].filter(Boolean).join("  ·  "); // Jellyfin hidden
  } catch {
    $("#status").textContent = "offline";
  }
}

// ---------------------------------------------------------------------------
// content filters (hentai / ecchi / erotica) — on-page chips, not in Settings
// ---------------------------------------------------------------------------
// Graduated "show up to" content level: none < ecchi < erotica < hentai
// (cumulative). e.g. "erotica" shows ecchi + erotica but hides hentai. Persisted;
// default "ecchi" (ecchi is mainstream; erotica + hentai hidden by default).
const CONTENT_LEVEL_KEY = "renzo:contentLevel";
const CONTENT_LADDER = ["none", "ecchi", "erotica", "hentai"]; // ascending
const CONTENT_LABELS = { none: "Off", ecchi: "Ecchi", erotica: "Erotica", hentai: "Hentai" };
const CAT_RANK = { ecchi: 1, erotica: 2, hentai: 3 };
let contentLevel = loadContentLevel();
function loadContentLevel() {
  try { const v = localStorage.getItem(CONTENT_LEVEL_KEY); return CONTENT_LADDER.includes(v) ? v : "ecchi"; }
  catch { return "ecchi"; }
}
function saveContentLevel() { try { localStorage.setItem(CONTENT_LEVEL_KEY, contentLevel); } catch {} }
function levelRank(level) { return CONTENT_LADDER.indexOf(level); } // none=0 … hentai=3
// A card's adult categories: prefer the server-computed `content`, else derive
// from genres (covers MAL fallback cards, which carry genres but no `content`).
function contentCatsOf(item) {
  if (item && item.content && item.content.length) return item.content;
  const g = (item.genres || []).map((x) => String(x).toLowerCase());
  const cats = [];
  if (g.includes("hentai")) cats.push("hentai");
  if (g.includes("ecchi")) cats.push("ecchi");
  return cats;
}
function isHidden(item) {
  const cats = contentCatsOf(item);
  if (!cats.length) return false;                        // non-adult always shown
  const itemRank = Math.max(...cats.map((c) => CAT_RANK[c] || 0));
  return itemRank > levelRank(contentLevel);             // hide anything above the chosen level
}
// Segmented "show up to" control — doubles as the current-mode indicator.
function renderContentChips() {
  document.querySelectorAll(".content-chips").forEach((box) => {
    box.innerHTML = "";
    box.append(el("span", "content-chips-label", "🔞 Show up to"));
    CONTENT_LADDER.forEach((level) => {
      const on = level === contentLevel;
      const chip = el("button", "chip content-chip" + (on ? " active" : ""), CONTENT_LABELS[level]);
      chip.title = level === "none" ? "Hide all adult content" : `Show up to ${CONTENT_LABELS[level]} (and everything milder)`;
      chip.addEventListener("click", () => { contentLevel = level; saveContentLevel(); renderContentChips(); reflowGrids(); });
      box.append(chip);
    });
  });
}
// Re-render every grid from its cached items so a filter change takes effect
// instantly without refetching. Browse rows re-append their trailing "More" tile.
function reflowGrids() {
  document.querySelectorAll(".grid").forEach((g) => {
    const items = gridCache.get(g);
    if (items) renderGrid(g, items);
  });
  [["#trendingGrid", "trending"], ["#recommendedGrid", "recommended"], ["#newSeasonGrid", "newSeason"]]
    .forEach(([sel, key]) => { const g = $(sel); if (g && gridCache.get(g)) appendMoreTile(g, key); });
}

// ---------------------------------------------------------------------------
// cards + grids
// ---------------------------------------------------------------------------
function makeCard(item) {
  const c = el("div", "card");
  const sTag = item.season ? `S${item.season} ` : "";
  const ribbon = item.updKind === "episode" ? `<span class="upd-ribbon">New · ${sTag}E${item.ep}</span>`
    : item.updKind === "season" ? `<span class="upd-ribbon season">${item.upcoming ? "Soon" : "New season"}${item.season ? ` · S${item.season}` : ""}</span>`
    : item.updKind === "movie" ? `<span class="upd-ribbon">Available</span>` : "";
  const upnext = item.upNext ? `<div class="upnext">▶ Up next · E${item.upNext}</div>` : "";
  c.innerHTML = `
    ${ribbon || `<span class="pill">${item.type === "movie" ? "Movie" : "Series"}</span>`}
    ${item.downloaded ? '<span class="dot" title="downloaded episodes"></span>' : ""}
    <img class="poster" loading="lazy" src="${esc(item.poster || "")}" alt="" onerror="this.style.opacity=.15" />
    <div class="cap">
      <div class="t">${esc(item.title)}</div>
      <div class="m">${[item.year, (item.genres || [])[0], item.seasonCount > 1 ? `${item.seasonCount} seasons` : ""].filter(Boolean).map(esc).join(" · ")}</div>
      ${upnext}
    </div>`;
  c.addEventListener("click", async () => {
    if (item.source === "mal") { // AniList-down fallback card — resolve id first
      try { const r = await api(`/titles/resolve?mal=${item.malId}`); openDetail(r.id); }
      catch { toast("Details unavailable right now — try again in a moment"); }
      return;
    }
    if (item.updKind === "episode" || item.updKind === "movie") play(item.id, item.ep || 1, item.title);
    else openDetail(item.id);
  });
  return c;
}
const gridCache = new WeakMap(); // grid element -> last items (for instant content-filter reflow)
function renderGrid(target, items) {
  if (!target) return;
  gridCache.set(target, items);
  target.innerHTML = "";
  const vis = (items || []).filter((it) => !isHidden(it));
  if (!vis.length) { target.append(el("div", "empty", "Nothing here yet.")); return; }
  vis.forEach((it) => target.append(makeCard(it)));
}

const browseData = {};
const CAT_LABELS = { trending: "Trending", recommended: "Recommended", newSeason: "New & this season" };
async function loadBrowse() {
  $("#searchWrap").classList.add("hidden");
  $("#browseWrap").classList.remove("hidden");
  const rows = [
    ["#trendingGrid", "/discover/trending", "trending"],
    ["#recommendedGrid", "/discover/recommended", "recommended"],
    ["#newSeasonGrid", "/discover/new-season", "newSeason"],
  ];
  await Promise.all(rows.map(async ([sel, url, key]) => {
    try {
      const items = await api(url);
      browseData[key] = items;
      renderGrid($(sel), items);
      appendMoreTile($(sel), key);        // "More →" tile at the end of the scroll row
    } catch { browseData[key] = []; renderGrid($(sel), []); }
  }));
}
function appendMoreTile(target, key) {
  if (!target || !(browseData[key] || []).length) return;
  const more = el("div", "more-tile");
  more.innerHTML = `<div class="more-ic">›</div><div class="more-lbl">More</div>`;
  more.addEventListener("click", () => showCategory(key));
  target.append(more);
}
// Full-category view (from the "See all" arrow or the "More" tile) — reuses the
// search results grid; unaffected by the mobile horizontal-scroll layout.
function showCategory(key) {
  $("#browseWrap").classList.add("hidden");
  $("#searchWrap").classList.remove("hidden");
  $("#discoverHeading").textContent = CAT_LABELS[key] || "Browse";
  renderGrid($("#discoverGrid"), browseData[key] || []);
  window.scrollTo(0, 0);
}
document.querySelectorAll(".row-more").forEach((b) => b.addEventListener("click", () => showCategory(b.dataset.cat)));
$("#discoverBack").addEventListener("click", () => { $("#search").value = ""; loadBrowse(); });

let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 320);
});
$("#searchType").addEventListener("change", doSearch);
async function doSearch() {
  const q = $("#search").value.trim();
  switchTab("discover");
  if (!q) { $("#searchWrap").classList.add("hidden"); $("#browseWrap").classList.remove("hidden"); return; }
  $("#browseWrap").classList.add("hidden");
  $("#searchWrap").classList.remove("hidden");
  $("#discoverHeading").textContent = `Results for “${q}”`;
  try {
    const type = $("#searchType").value;
    renderGrid($("#discoverGrid"), await api(`/discover/search?q=${encodeURIComponent(q)}&type=${type}`));
  } catch (e) { toast("Search failed: " + e.message); }
}

let activeList = "";
let activeFolder = "";
async function loadLibrary() {
  try {
    const q = new URLSearchParams();
    if (activeList) q.set("list", activeList);
    if (activeFolder) q.set("folder", activeFolder);
    const [items, lists, folders] = await Promise.all([
      api(`/library${q.toString() ? "?" + q.toString() : ""}`),
      api("/lists"),
      api("/folders"),
    ]);
    renderFolderChips(folders);
    renderChips(lists);
    renderGrid($("#libraryGrid"), items);
  } catch (e) { toast("Library failed: " + e.message); }
}

function renderFolderChips(folders) {
  const wrap = $("#folderChips");
  wrap.innerHTML = "";
  const all = el("button", "chip folder-chip" + (activeFolder === "" ? " active" : ""), "📁 All");
  all.addEventListener("click", () => { activeFolder = ""; loadLibrary(); });
  wrap.append(all);
  (folders || []).forEach((f) => {
    const chip = el("button", "chip folder-chip" + (activeFolder === f.name ? " active" : ""),
      `${esc(f.name)}${f.count ? `<span class="cnt">${f.count}</span>` : ""}`);
    chip.addEventListener("click", () => { activeFolder = f.name; loadLibrary(); });
    wrap.append(chip);
  });
  const add = el("button", "chip new-chip", "+ New folder");
  add.addEventListener("click", async () => {
    const name = (prompt("New folder name") || "").trim();
    if (!name) return;
    try {
      await api("/folders", { method: "POST", body: JSON.stringify({ name }) });
      activeFolder = name; loadLibrary(); toast("Folder created");
    } catch (e) { toast(e.message); }
  });
  wrap.append(add);
}

function renderChips(counts) {
  const wrap = $("#listChips");
  wrap.innerHTML = "";
  const names = [...new Set(["watchlist", "favorites", ...Object.keys(counts)])];
  const all = el("button", "chip" + (activeList === "" ? " active" : ""), "All");
  all.addEventListener("click", () => { activeList = ""; loadLibrary(); });
  wrap.append(all);
  for (const name of names) {
    const n = counts[name] ?? 0;
    const chip = el("button", "chip" + (activeList === name ? " active" : ""),
      `${esc(name)}${n ? ` <span style="opacity:.6">${n}</span>` : ""}`);
    chip.addEventListener("click", () => { activeList = name; loadLibrary(); });
    wrap.append(chip);
  }
}

$("#importBtn").addEventListener("click", async () => {
  toast("Importing from trackers…");
  try {
    const r = await api("/trackers/import", { method: "POST" });
    toast(`Imported ${r.anilist + r.mal} titles`);
    loadLibrary();
  } catch (e) { toast("Import failed: " + e.message); }
});

// ---------------------------------------------------------------------------
// detail
// ---------------------------------------------------------------------------
let current = null;
let detailShownId = null; // title id currently rendered on the detail page (for instant Back)

// Navigate to a title's dedicated page; the hash router renders it. `replace`
// (used by season/related links already inside a detail or the player) swaps the
// current history entry instead of pushing one, so the title stack stays flat and
// Back returns to the MENU — not to the previously-viewed season.
function openDetail(id, replace) {
  const url = `#/title/${id}`;
  if (replace && location.hash !== url) {
    history.replaceState(null, "", url); // replaceState doesn't fire hashchange…
    route();                             // …so run the router ourselves
  } else location.hash = url;
}

function showDetailView() {
  document.querySelectorAll(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
  $("#view-watch").classList.add("hidden");
  document.body.classList.remove("watching");
  syncTopbarH();
  $("#detail").classList.remove("hidden");
  document.body.classList.add("detailing");
}
function hideDetail() {
  $("#detail").classList.add("hidden");
  document.body.classList.remove("detailing");
  detailShownId = null;
}
// Router entry: show the page and render it — but skip the re-render (and its
// flash) when returning to the SAME title, e.g. Back from the player.
async function enterDetail(id) {
  showDetailView();
  if (detailShownId === id) return;
  $("#detail").scrollTop = 0;
  await renderDetail(id);
}

async function renderDetail(id) {
  try {
    const d = await api(`/titles/${id}`);
    if (parseTitleHash()?.id !== id) return; // a newer navigation superseded this render
    Offline.setMeta(d);        // cache banner/info/episodes so offline looks identical
    paintDetail(d, { offline: false });
    loadProviders(d);          // async — populates the release-group picker
    loadTracking(d.id);        // async — AniList/MAL list status
  } catch (e) {
    toast("Detail failed: " + e.message);
    location.hash = "";
  }
}

// Paint the detail page from a detail object. Shared by the online page and the
// offline page (fed from cached metadata) so both look identical; server-only
// controls are hidden when `offline`.
let offlineDetailOpen = false; // showing the offline (Downloads) detail page?
function paintDetail(d, opts) {
  const offline = !!(opts && opts.offline);
  current = d;
  detailShownId = offline ? null : d.id; // offline pages aren't hash-routed
  if (!offline) offlineDetailOpen = false; // a real online page → Back resumes normal nav
  $("#detailBanner").style.backgroundImage = `url(${d.banner || d.poster || ""})`;
  $("#detailPoster").src = d.poster || "";
  $("#detailPoster").style.visibility = d.poster ? "" : "hidden";
  $("#detailTitle").textContent = d.english || d.romaji;
  const meta = [
    `<span class="type-tag">${d.type === "movie" ? "Movie" : "Series"}</span>`,
    d.year, `${d.episodesTotal || 1} ep`, ...(d.genres || []).slice(0, 3),
  ].filter(Boolean);
  $("#detailMetaline").innerHTML = meta.map((m, i) =>
    `${i ? '<span class="sep">•</span>' : ""}<span>${typeof m === "string" && m.startsWith("<") ? m : esc(m)}</span>`).join("");
  const desc = $("#detailDesc");
  desc.textContent = d.description || "";
  desc.classList.add("clamp");
  $("#detailMore").textContent = "More details";
  $("#detailMore").style.display = (d.description || "").length > 200 ? "" : "none";
  const isSeries = d.type === "series";
  // Hero Play -> first not-downloaded aired episode (or E1 / movie).
  const firstEp = (d.episodeList || []).find((e) => e.aired !== false && !e.hasFile)
    || (d.episodeList || []).find((e) => e.aired !== false) || { number: 1 };
  $("#heroPlay").textContent = isSeries ? `▶ Play E${firstEp.number}` : "▶ Play";
  $("#heroPlay").onclick = () => play(d.id, isSeries ? firstEp.number : 1, `${d.english || d.romaji}${isSeries ? ` · E${firstEp.number}` : ""}`);
  const denied = !!(me && me.downloadsDenied);
  $("#seasonBtn").classList.toggle("hidden", offline || !isSeries || denied);
  $("#autoBtn").classList.toggle("hidden", offline || !isSeries || denied);
  // Server-only affordances make no sense offline — hide them.
  const dc = document.querySelector(".detail-controls"); if (dc) dc.style.display = offline ? "none" : "";
  const tr = $("#trackRow"); if (tr) tr.style.display = offline ? "none" : "";
  ["#watchlistBtn", "#favBtn"].forEach((s) => { const b = $(s); if (b) b.style.display = offline ? "none" : ""; });
  if (!offline) {
    setAutoBtn(!!d.autoDownload);
    setListBtns(d.lists || []);
    populateFolderSelect(d.folders || [], d.folder);
  }
  renderSeasons(d);
  renderEpisodes(d, offline);
}

// Server state for a title changed (episode watched / downloaded): drop the
// instant-Back cache so the series page re-renders next open — and refresh it
// live if it's the page currently on screen.
function invalidateDetail(titleId) {
  if (detailShownId !== titleId) return;
  detailShownId = null;
  if (!$("#detail").classList.contains("hidden") && parseTitleHash()?.id === titleId) enterDetail(titleId);
}

// Detail page controls (bound once).
$("#detailBack").addEventListener("click", (e) => {
  e.preventDefault();
  if (offlineDetailOpen) { $("#detail").classList.add("hidden"); openDownloads(); return; } // back to the Downloads gate
  if (history.length > START_LEN) history.back(); else location.hash = "";
});
$("#detailMore").addEventListener("click", () => {
  const clamped = $("#detailDesc").classList.toggle("clamp");
  $("#detailMore").textContent = clamped ? "More details" : "Less";
});

// --- Cover lightbox: click the current season's poster to expand it ---------
function openLightbox(src) {
  if (!src) return;
  $("#imgLightboxImg").src = src;
  $("#imgLightbox").classList.remove("hidden");
}
function closeLightbox() {
  $("#imgLightbox").classList.add("hidden");
  $("#imgLightboxImg").removeAttribute("src");
}
function lightboxOpen() { return !$("#imgLightbox").classList.contains("hidden"); }
$("#detailPoster").addEventListener("click", () => openLightbox(current?.poster || $("#detailPoster").src));
$("#imgLightbox").addEventListener("click", (e) => { if (e.target.id !== "imgLightboxImg") closeLightbox(); });
$("#imgLightboxClose").addEventListener("click", closeLightbox);

// Set the exact watched-through episode (mark / un-watch / mark season).
async function setProgress(id, ep) {
  // Offline: record locally + queue for sync on reconnect.
  if (!navigator.onLine && ep > 0) {
    Offline.queueWatched(id, ep);
    if (current && current.id === id) { current.watchedThrough = ep; renderEpisodes(current, offlineDetailOpen); }
    toast(`Watched through E${ep} — will sync when back online`);
    return;
  }
  try {
    const r = await api(`/titles/${id}/progress`, { method: "POST", body: JSON.stringify({ ep }) });
    if (current && current.id === id) { current.watchedThrough = r.watchedThrough; renderEpisodes(current); loadTracking(id); }
    invalidateDetail(id);
    toast(r.watchedThrough > 0 ? `Watched through E${r.watchedThrough}` : "Marked unwatched");
  } catch (e) { toast(e.message); }
}

// Seasons: current entry + related prequel/sequel entries, ordered by year.
function renderSeasons(d) {
  const row = $("#seasonsRow");
  row.innerHTML = "";
  const seasons = [
    { id: d.id, title: d.english || d.romaji, year: d.year, poster: d.poster, num: d.seasonNum, part: d.seasonPart, kind: d.seasonKind, format: d.seasonFormat, current: true },
    ...(d.seasons || []).map((s) => ({ id: s.id, title: s.title, year: s.year, poster: s.poster, num: s.num, part: s.part, kind: s.kind, format: s.format })),
  ];
  if (seasons.length < 2) { row.classList.add("hidden"); return; }
  seasons.sort(seasonOrder);
  row.classList.remove("hidden");
  seasons.forEach((s, i) => {
    const card = el("div", "season-card" + (s.current ? " current" : ""));
    card.innerHTML = `<img loading="lazy" src="${esc(s.poster || "")}" alt="" onerror="this.style.opacity=.15" />
      <div class="lbl">${esc(seasonChip(s, i))}${s.year ? ` · ${s.year}` : ""}${s.current ? " (this)" : ""}</div>`;
    if (!s.current) card.addEventListener("click", () => openDetail(s.id, true)); // flat stack → Back = menu
    row.append(card);
  });
}

// Release-group provider picker (async: needs a torrent search).
async function loadProviders(d) {
  const sel = $("#providerSelect");
  sel.innerHTML = `<option value="">Auto (best)</option><option disabled>loading…</option>`;
  sel.value = "";
  try {
    const providers = await api(`/titles/${d.id}/providers`);
    if (!current || current.id !== d.id) return; // detail changed while loading
    sel.innerHTML = `<option value="">Auto (best)</option>`;
    providers.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.group;
      const res = (p.resolutions || []).sort((a, b) => b - a)[0];
      o.textContent = `${p.group}${res ? ` · ${res}p` : ""} (${p.count})`;
      sel.append(o);
    });
    // If the user's saved provider isn't in the list, add it so it stays selected.
    if (d.provider && !providers.some((p) => p.group.toLowerCase() === d.provider.toLowerCase())) {
      const o = document.createElement("option");
      o.value = d.provider; o.textContent = d.provider; sel.append(o);
    }
    sel.value = d.provider || "";
  } catch {
    sel.innerHTML = `<option value="">Auto (best)</option>`;
    sel.value = d.provider || "";
  }
}

// --- Per-title tracking (AniList/MAL status, progress, score) --------------
async function loadTracking(id) {
  const row = $("#trackRow");
  const controls = row.querySelectorAll("select, input, button");
  try {
    const t = await api(`/titles/${id}/tracking`);
    if (!current || current.id !== id) return; // detail changed while loading
    const providers = [];
    if ("anilist" in t) providers.push("AniList");
    if ("mal" in t) providers.push("MyAnimeList");
    if (!providers.length) {
      controls.forEach((e) => (e.disabled = true));
      $("#trackStatus").value = ""; $("#trackProgress").value = ""; $("#trackScore").value = ""; $("#trackTotal").textContent = "";
      $("#trackNote").textContent = "Connect AniList or MAL in Settings to track";
      return;
    }
    controls.forEach((e) => (e.disabled = false));
    const e = t.anilist || t.mal || {};          // prefer AniList's values for display
    $("#trackStatus").value = e.status || "";
    $("#trackProgress").value = e.progress || 0;
    $("#trackScore").value = e.score || "";
    $("#trackTotal").textContent = e.total ? `/ ${e.total}` : "";
    $("#trackNote").textContent = "Syncs to " + providers.join(" + ");
  } catch { $("#trackNote").textContent = ""; }
}
$("#trackSave").addEventListener("click", async () => {
  if (!current) return;
  const body = { progress: Number($("#trackProgress").value) || 0 };
  if ($("#trackStatus").value) body.status = $("#trackStatus").value;
  if ($("#trackScore").value !== "") body.score = Number($("#trackScore").value);
  $("#trackSave").disabled = true;
  try {
    await api(`/titles/${current.id}/tracking`, { method: "POST", body: JSON.stringify(body) });
    toast("Tracking synced");
    loadTracking(current.id);
  } catch (e) { toast(e.message); $("#trackSave").disabled = false; }
});

$("#providerSelect").addEventListener("change", async () => {
  if (!current) return;
  const group = $("#providerSelect").value;
  try {
    const r = await api(`/titles/${current.id}/provider`, { method: "POST", body: JSON.stringify({ group }) });
    current.provider = r.provider;
    toast(r.provider ? `Provider set: ${r.provider}` : "Provider: Auto (best)");
  } catch (e) { toast(e.message); }
});

function populateFolderSelect(folders, current) {
  const sel = $("#folderSelect");
  sel.innerHTML = "";
  const names = [...new Set([...(folders || []), current].filter(Boolean))];
  // Never leave "+ New folder…" as the only (and therefore selected) option — a
  // native <select> won't fire `change` when you pick the already-selected option,
  // so the New-folder prompt would never open. Guarantee a real folder is present.
  if (!names.length) names.push("Library");
  const cur = current && names.includes(current) ? current : names[0];
  names.forEach((n) => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n; if (n === cur) o.selected = true;
    sel.append(o);
  });
  const nw = document.createElement("option");
  nw.value = "__new__"; nw.textContent = "+ New folder…";
  sel.append(nw);
  sel.value = cur; // keep a real folder as the resting selection
}

$("#folderSelect").addEventListener("change", async () => {
  if (!current) return;
  let folder = $("#folderSelect").value;
  if (folder === "__new__") {
    folder = (prompt("New folder name") || "").trim();
    if (!folder) { populateFolderSelect(current.folders || [], current.folder); return; }
  }
  try {
    const r = await api(`/titles/${current.id}/folder`, { method: "POST", body: JSON.stringify({ folder }) });
    current.folder = r.folder;
    if (!(current.folders || []).includes(r.folder)) current.folders = [...(current.folders || []), r.folder];
    populateFolderSelect(current.folders, current.folder);
    toast(`Moved to “${r.folder}”`);
    if ($("#view-library").classList.contains("active")) loadLibrary();
  } catch (e) {
    toast(e.message);
    populateFolderSelect(current.folders || [], current.folder);
  }
});

function setAutoBtn(on) {
  const b = $("#autoBtn");
  b.textContent = on ? "Auto: on" : "Auto: off";
  b.classList.toggle("on", on);
}

function setListBtns(lists) {
  const inW = lists.includes("watchlist");
  const inF = lists.includes("favorites");
  $("#watchlistBtn").textContent = inW ? "★" : "☆";
  $("#watchlistBtn").title = inW ? "In watchlist" : "Add to watchlist";
  $("#watchlistBtn").classList.toggle("on", inW);
  $("#favBtn").textContent = inF ? "♥" : "♡";
  $("#favBtn").title = inF ? "Favorited" : "Add to favorites";
  $("#favBtn").classList.toggle("on", inF);
}

function renderEpisodes(d, offline) {
  const area = $("#episodeArea");
  area.innerHTML = "";
  if (d.type === "movie") {
    const b = el("button", "primary movie-play", "▶ Stream");
    b.addEventListener("click", () => play(d.id, 1, d.english || d.romaji));
    area.append(b);
    return;
  }
  const aired = d.episodeList.filter((e) => e.aired !== false).length;
  const sn = seasonNumber(d); // real season number (was hardcoded to 1)
  const seasonWatched = aired > 0 && (d.watchedThrough || 0) >= aired;
  const header = el("div", "season-header");
  header.innerHTML = `<span>Season ${sn} <span class="cnt">${aired} of ${d.episodeList.length} available</span></span>`;
  const markAll = el("button", "ghost mark-all" + (seasonWatched ? " on" : ""), seasonWatched ? "✓ Season watched" : "Mark season watched");
  markAll.addEventListener("click", () => setProgress(d.id, seasonWatched ? 0 : aired));
  header.append(markAll);
  // Batch: save every downloaded episode of this season for offline at once.
  if (Offline.supported() && !offline) {
    const offAll = el("button", "ghost", "⤓ Save season offline");
    offAll.addEventListener("click", () => saveSeasonOffline(d));
    header.append(offAll);
  }
  area.append(header);

  // Responsive card grid (columns auto-fit the window width, wrap to new rows).
  const grid = el("div", "ep-grid");
  const fallback = d.banner || d.poster || "";
  const series = d.english || d.romaji;
  const denied = !!(me && me.downloadsDenied);
  d.episodeList.forEach((ep) => {
    const unaired = ep.aired === false;
    const busy = ["downloading", "queued", "searching"].includes(ep.status);
    const pct = Math.round((ep.progress || 0) * 100);
    const watched = !unaired && ep.number <= (d.watchedThrough || 0);
    // Bottom-right badge: watched → Watched, else download state, else runtime.
    let badge = "";
    if (unaired) badge = "Soon";
    else if (watched) badge = "Watched";
    else if (ep.hasFile) badge = "✓ Saved";
    else if (busy) badge = `${ep.status}${pct ? " " + pct + "%" : ""}`;
    else if (d.duration) badge = `${d.duration}m`;
    const ov = watched ? "↻" : "▶"; // replay for watched, play otherwise
    const card = el("div", `ep-card${unaired ? " unaired" : ""}${watched ? " watched" : ""}`);
    card.innerHTML = `
      <div class="ep-thumb-wrap">
        <img class="ep-thumb" loading="lazy" src="${esc(ep.thumbnail || fallback)}" alt="" onerror="this.src='${esc(fallback)}'" />
        ${!unaired ? `<div class="ep-ov">${ov}</div>` : ""}
        ${badge ? `<span class="ep-badge${watched ? " done" : ep.hasFile ? " saved" : ""}">${esc(badge)}</span>` : ""}
        ${Offline.has(d.id, ep.number) ? '<span class="ep-off">⤓ Offline</span>' : ""}
        ${pct > 0 && pct < 100 ? `<div class="ep-prog" style="width:${pct}%"></div>` : ""}
      </div>
      <div class="ep-series">${esc(series)}</div>
      <div class="ep-title">E${ep.number}${ep.epTitle ? ` – ${esc(ep.epTitle)}` : " – " + `Episode ${ep.number}`}</div>
      <div class="ep-foot"><span class="ep-sub">Subtitled</span></div>`;
    // Play on click (thumbnail / title); unaired just informs.
    const openEp = () => unaired
      ? toast(`Episode ${ep.number} hasn't aired yet`)
      : play(d.id, ep.number, `${series} · E${ep.number}`);
    card.querySelector(".ep-thumb-wrap").addEventListener("click", openEp);
    card.querySelector(".ep-title").addEventListener("click", openEp);

    // Kebab menu (mark watched/unwatched + download).
    if (!unaired) {
      const kebab = el("button", "ep-kebab", "⋮");
      kebab.title = "Episode options";
      kebab.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = card.querySelector(".ep-menu");
        closeEpMenus();
        if (open) return; // toggle off
        const menu = el("div", "ep-menu");
        const w = el("button", "", watched ? "Mark unwatched" : "Mark watched");
        w.addEventListener("click", (ev) => { ev.stopPropagation(); closeEpMenus(); setProgress(d.id, watched ? ep.number - 1 : ep.number); });
        menu.append(w);
        if (!ep.hasFile && !denied) {
          const dl = el("button", "", "Download");
          dl.addEventListener("click", (ev) => { ev.stopPropagation(); closeEpMenus(); downloadEp(d.id, ep.number); });
          menu.append(dl);
          const dlNow = el("button", "", "Download now");
          dlNow.addEventListener("click", (ev) => { ev.stopPropagation(); closeEpMenus(); downloadEp(d.id, ep.number, true); });
          menu.append(dlNow);
        }
        // Offline: available once the episode is in the library. Auto-purged on reconnect.
        if (ep.hasFile && Offline.supported()) {
          const saved = Offline.has(d.id, ep.number);
          const off = el("button", "", saved ? "Remove offline copy" : "Save offline");
          off.addEventListener("click", (ev) => { ev.stopPropagation(); closeEpMenus(); toggleOffline(d.id, ep.number, `${series} · E${ep.number}`, saved); });
          menu.append(off);
        }
        card.querySelector(".ep-foot").append(menu);
      });
      card.querySelector(".ep-foot").append(kebab);
    }
    grid.append(card);
  });
  area.append(grid);
}

function closeEpMenus() { document.querySelectorAll(".ep-menu").forEach((m) => m.remove()); }
document.addEventListener("click", (e) => { if (!e.target.closest(".ep-foot")) closeEpMenus(); });

async function downloadEp(id, ep, now) {
  try {
    const job = await api(`/titles/${id}/download/${ep}`, { method: "POST" });
    if (now && job?.id) { try { await api(`/jobs/${job.id}/prioritize`, { method: "POST" }); } catch { /* still queued */ } }
    toast(now ? `Downloading E${ep} now…` : `Downloading E${ep}…`);
  } catch (e) { toast(e.message); }
}

// Save/remove an episode for offline viewing (auto-purged when back online).
async function toggleOffline(id, ep, label, saved) {
  try {
    if (saved) { await Offline.remove(id, ep); toast("Removed offline copy"); }
    else {
      // Native shells download to a user-chosen folder — pick one on first save.
      if (Offline.native() && Offline.bridge.getFolder && Offline.bridge.chooseFolder) {
        const folder = await Offline.bridge.getFolder();
        if (!folder) {
          const picked = await Offline.bridge.chooseFolder();
          if (!picked) return void toast("Pick a download folder to save offline");
        }
      }
      toast("Saving for offline…");
      const r = await Offline.fetchSource(id, ep);
      await Offline.save(id, ep, r, label);
      toast("Saved — available offline until you reconnect");
    }
    invalidateDetail(id); // refresh the ⤓ badge / menu label
    // The offline detail page isn't hash-routed (detailShownId is null), so
    // invalidateDetail no-ops there — repaint it directly to refresh badges.
    if (offlineDetailOpen && current && current.id === id) paintDetail(offlineDetail(id), { offline: true });
  } catch (e) { toast(e.message || String(e)); }
}

// Batch: save every downloaded, not-yet-saved episode of a season for offline.
async function saveSeasonOffline(d) {
  const eps = (d.episodeList || []).filter((e) => e.aired !== false);
  const todo = eps.filter((e) => e.hasFile && !Offline.has(d.id, e.number));
  const notLib = eps.filter((e) => !e.hasFile).length;
  if (!todo.length) return void toast(notLib ? "Download these episodes to your library first" : "Season already saved offline");
  if (Offline.native() && Offline.bridge.getFolder && Offline.bridge.chooseFolder) {
    const folder = await Offline.bridge.getFolder();
    if (!folder && !(await Offline.bridge.chooseFolder())) return void toast("Pick a download folder to save offline");
  }
  toast(`Saving ${todo.length} episode${todo.length === 1 ? "" : "s"} offline…`);
  let ok = 0;
  for (const e of todo) {
    try {
      const r = await Offline.fetchSource(d.id, e.number);
      await Offline.save(d.id, e.number, r, `${d.english || d.romaji} · E${e.number}`);
      ok++;
    } catch { /* skip a failed episode, keep going */ }
  }
  toast(`Saved ${ok} offline${notLib ? ` · ${notLib} not in library yet` : ""}`);
  invalidateDetail(d.id);
}

async function toggleList(listName) {
  if (!current) return;
  const on = !(current.lists || []).includes(listName);
  try {
    const r = await api(`/titles/${current.id}/lists`, {
      method: "POST",
      body: JSON.stringify({ list: listName, on }),
    });
    current.lists = r.lists;
    setListBtns(r.lists);
    toast(on ? `Added to ${listName}` : `Removed from ${listName}`);
    if ($("#view-library").classList.contains("active")) loadLibrary();
  } catch (e) { toast(e.message); }
}
$("#watchlistBtn").addEventListener("click", () => toggleList("watchlist"));
$("#favBtn").addEventListener("click", () => toggleList("favorites"));

$("#seasonBtn").addEventListener("click", async () => {
  if (!current) return;
  $("#seasonBtn").disabled = true;
  toast("Queueing season…");
  try {
    const r = await api(`/titles/${current.id}/download-season`, { method: "POST" });
    toast(r.queued ? `Queued ${r.queued} episode${r.queued === 1 ? "" : "s"}` : "Nothing missing — season already downloaded");
    loadJobs();
  } catch (e) { toast(e.message); }
  finally { $("#seasonBtn").disabled = false; }
});

$("#autoBtn").addEventListener("click", async () => {
  if (!current) return;
  try {
    const r = await api(`/titles/${current.id}/auto`, {
      method: "POST",
      body: JSON.stringify({ enabled: !current.autoDownload }),
    });
    current.autoDownload = r.autoDownload;
    setAutoBtn(r.autoDownload);
    toast(r.autoDownload ? "Auto-download on — new episodes grab automatically" : "Auto-download off");
  } catch (e) { toast(e.message); }
});

// ---------------------------------------------------------------------------
// Watch page  (Crunchyroll-style: own URL, series-based, no per-episode reloads)
// ---------------------------------------------------------------------------
let watch = null; // { watchId, titleId, detail, ep, prefetch }
function clearTracks(video) { video.querySelectorAll("track").forEach((t) => t.remove()); }

// Play buttons everywhere call this: mint/reuse a per-series watch id, then
// navigate to its URL. The hash router renders the player.
async function play(id, ep) {
  // Offline: there's no server to mint a watch link — play the saved copy directly
  // (goToEp's offline branch reads it). Fixes playback from the offline detail page.
  if (!navigator.onLine) return playOffline(id, ep);
  try {
    const r = await api(`/titles/${id}/watch`, { method: "POST" });
    location.hash = `#/watch/${r.watchId}/${ep || 1}`;
  } catch (e) { toast(e.message); }
}

// --- hash router -----------------------------------------------------------
function parseWatchHash() {
  const m = location.hash.match(/^#\/watch\/([^/]+)(?:\/(\d+))?$/);
  return m ? { watchId: m[1], ep: m[2] ? Number(m[2]) : null } : null;
}
function parseTitleHash() {
  const m = location.hash.match(/^#\/title\/(\d+)$/);
  return m ? { id: Number(m[1]) } : null;
}
function parseSettingsHash() {
  const m = location.hash.match(/^#\/settings(?:\/([a-z]+))?$/);
  return m ? (m[1] || "account") : null;
}
function route() {
  if (!me) return;
  const s = parseSettingsHash();
  if (s) { if (watch) exitWatch(); hideDetail(); showSettingsPage(s); return; } // dedicated config page
  if (!$("#settings").classList.contains("hidden")) $("#settings").classList.add("hidden"); // left the config route
  const w = parseWatchHash();
  const t = parseTitleHash();
  if (w) enterWatch(w.watchId, w.ep);              // showWatchView() hides the detail page
  else if (t) { if (watch) exitWatch(); enterDetail(t.id); }
  else { if (watch) exitWatch(); hideDetail(); }
}
window.addEventListener("hashchange", route);

async function enterWatch(watchId, epFromUrl) {
  if (watch && watch.watchId === watchId) {         // same series -> just switch ep
    if (epFromUrl && epFromUrl !== watch.ep) goToEp(epFromUrl);
    return;
  }
  try {
    const res = await api(`/watch/${encodeURIComponent(watchId)}`);
    const d = await api(`/titles/${res.titleId}`);
    watch = { watchId, titleId: res.titleId, detail: d, ep: null, prefetch: null };
    renderWatchShell(d);
    showWatchView();
    goToEp(epFromUrl || res.resumeEp || 1);
  } catch (e) {
    toast("Couldn't open player: " + (e.message || e));
    location.hash = "";
  }
}

function airedCount(d) {
  if (d.type === "movie") return 1;
  return (d.episodeList || []).filter((e) => e.aired !== false).length || 1;
}
function orderedSeasons(d) {
  return [{ id: d.id, title: d.english || d.romaji, year: d.year, num: d.seasonNum, part: d.seasonPart, kind: d.seasonKind, format: d.seasonFormat, current: true },
    ...(d.seasons || []).map((s) => ({ id: s.id, title: s.title, year: s.year, num: s.num, part: s.part, kind: s.kind, format: s.format }))]
    .sort(seasonOrder);
}
function seasonNumber(d) {
  if (d.seasonNum) return d.seasonNum; // authoritative number from the backend chain
  const i = orderedSeasons(d).findIndex((s) => s.id === d.id);
  return i < 0 ? 1 : i + 1;
}
// Compact chip label: "S2" or, for split-cours, "S2 Pt2". `word=true` spells it out.
const EXTRA_LABELS = { MOVIE: "Movie", OVA: "OVA", SPECIAL: "Special" };
function seasonChip(s, i, word) {
  // Movies/OVAs/specials are part of the series but carry no season number.
  if (s.kind === "extra") return EXTRA_LABELS[s.format] || "Special";
  const n = s.num || i + 1;
  const base = word ? `Season ${n}` : `S${n}`;
  return s.part ? `${base}${word ? " Part " : " Pt"}${s.part}` : base;
}
// Seasons first, then the specials/movies that follow them; ties broken by
// part/year and finally by id. The id tiebreak is what keeps the row IDENTICAL
// no matter which entry you're viewing: the current title is prepended to the
// list, so without it a stable sort floats it above same-year siblings and two
// entries appear to swap places between pages.
function seasonOrder(a, b) {
  return (a.num || 0) - (b.num || 0)
    || (a.kind === "extra" ? 1 : 0) - (b.kind === "extra" ? 1 : 0)
    || (a.part || 0) - (b.part || 0)
    || (a.year || 0) - (b.year || 0)
    || (a.id || 0) - (b.id || 0);
}

function renderWatchShell(d) {
  $("#watchSeriesLink").textContent = d.english || d.romaji; // orange link → series page
  const sel = $("#watchSeason");
  const seasons = orderedSeasons(d);
  if (seasons.length > 1) {
    sel.classList.remove("hidden");
    sel.innerHTML = "";
    seasons.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = `${seasonChip(s, i, true)}${s.year ? ` · ${s.year}` : ""}`;
      if (s.id === d.id) o.selected = true;
      sel.append(o);
    });
  } else sel.classList.add("hidden");

  const list = $("#watchEpList");
  list.innerHTML = "";
  const fallback = d.banner || d.poster || "";
  // "Up next" across the series chain — S1 -> the movie that continues it -> S2,
  // in either direction. Pinned above the episodes so it's the first thing you see.
  const nx = d.nextUp;
  if (nx) {
    const row = el("div", "wep upnext");
    row.innerHTML = `
      <img class="wep-thumb" loading="lazy" src="${esc(nx.poster || fallback)}" onerror="this.src='${esc(fallback)}'" alt="" />
      <div class="wep-main">
        <div class="wep-no">Up next · ${esc(seasonChip(nx, 0, true))}${nx.year ? ` · ${nx.year}` : ""}</div>
        <div class="wep-next-title">${esc(nx.title)}</div>
      </div>
      <span class="ep-st">▶</span>`;
    row.addEventListener("click", () => play(nx.id, 1));
    list.append(row);
  }
  (d.episodeList || []).forEach((ep) => {
    const unaired = ep.aired === false;
    const row = el("div", `wep${unaired ? " unaired" : ""}`);
    row.dataset.ep = ep.number;
    row.innerHTML = `
      <img class="wep-thumb" loading="lazy" src="${esc(ep.thumbnail || fallback)}" onerror="this.src='${esc(fallback)}'" alt="" />
      <div class="wep-main"><div class="wep-no">E${ep.number}${ep.epTitle ? ` · ${esc(ep.epTitle)}` : ""}</div></div>
      ${ep.hasFile ? '<span class="ep-st local">✓</span>' : unaired ? '<span class="ep-st">Soon</span>' : ""}`;
    if (unaired) row.addEventListener("click", () => toast(`Episode ${ep.number} hasn't aired yet`));
    else row.addEventListener("click", () => goToEp(ep.number));
    list.append(row);
  });
}

// Switch episode WITHOUT reloading the page: swap the source + meta in place.
async function goToEp(ep) {
  const d = watch.detail;
  const isMovie = d.type === "movie";
  const max = airedCount(d);
  ep = Math.min(Math.max(1, ep), Math.max(1, max));
  const meta = (d.episodeList || []).find((e) => e.number === ep) || { number: ep };
  if (meta.aired === false) { toast("That episode hasn't aired yet"); return; }
  watch.ep = ep;
  const gen = (watch.gen = (watch.gen || 0) + 1); // guard against out-of-order stream resolves
  cancelAutoNext();
  history.replaceState(null, "", `#/watch/${watch.watchId}/${ep}`); // no reload (no hashchange)

  $("#watchTitle").textContent = isMovie ? (d.english || d.romaji) : `E${ep}${meta.epTitle ? ` · ${meta.epTitle}` : ""}`;
  $("#watchEpNo").textContent = isMovie ? "Movie" : seasonChip({ num: seasonNumber(d), part: d.seasonPart, kind: d.seasonKind, format: d.seasonFormat }, 0, true);
  $("#watchDesc").textContent = d.description || "";
  highlightEp(ep);
  const isMv = isMovie;
  $("#watchPrev").classList.toggle("hidden", isMv); $("#watchNext").classList.toggle("hidden", isMv);
  $("#watchPrev").disabled = ep <= 1;
  $("#watchNext").disabled = ep >= max;

  const video = $("#watchVideo"), badge = $("#watchSource");
  badge.textContent = "resolving…"; badge.className = "source-badge";
  $("#watchNote").textContent = "";
  video.pause(); clearTracks(video); video.removeAttribute("src");

  try {
    // No network: play the saved offline copy if we have one, else say so.
    const off = Offline.get(watch.titleId, ep);
    let r;
    if (!navigator.onLine) {
      if (!off) {
        badge.textContent = "offline"; badge.className = "source-badge";
        $("#watchNote").textContent = "Not saved for offline — download it while you have a connection.";
        return;
      }
      const pb = await Offline.playbackFor(off);
      r = { source: "local", url: pb.url, subtitles: pb.subtitles, offline: true };
    } else {
      r = (watch.prefetch && watch.prefetch.ep === ep && await watch.prefetch.p)
        || await api(`/titles/${watch.titleId}/play/${ep}`);
    }
    if (!watch || watch.gen !== gen) return; // a newer goToEp() superseded us — don't clobber it
    badge.textContent = r.offline ? "● Offline copy" : r.source === "local" ? "● Local file" : "● Real-Debrid";
    badge.className = "source-badge " + (r.source === "local" ? "local" : "rd");
    video.src = r.url;
    (r.subtitles || []).forEach((s) => {
      const track = el("track");
      track.kind = "subtitles"; track.label = s.label || s.lang; track.srclang = s.lang || "en";
      track.src = s.src || `/api/captions/${s.id}.vtt`; // s.src set for offline (disk/cache)
      video.append(track);
    });
    video.load();
    video.play().catch(() => {});
    setupCaptions(video);   // custom caption rendering + language menu + preferred language
    showControls();
    $("#watchDownload").style.display = (me && me.downloadsDenied) ? "none" : "";
    $("#watchDownload").textContent = r.source === "local" ? "✓ In library" : "⬇ Download to library";
    $("#watchDownload").disabled = r.source === "local";
    if (r.downloading) watchJob(r.downloading.id);
    prefetchNext(ep, max);
  } catch (e) {
    badge.textContent = "failed";
    $("#watchNote").textContent = e.message || String(e);
  }
}

// Warm the next episode's stream so advancing is instant.
function prefetchNext(ep, max) {
  watch.prefetch = null;
  const next = ep + 1;
  if (watch.detail.type === "movie" || next > max) return;
  watch.prefetch = { ep: next, p: api(`/titles/${watch.titleId}/play/${next}`).catch(() => null) };
}

function highlightEp(ep) {
  document.querySelectorAll("#watchEpList .wep").forEach((r) =>
    r.classList.toggle("playing", Number(r.dataset.ep) === ep));
  const cur = document.querySelector(`#watchEpList .wep[data-ep="${ep}"]`);
  if (cur) cur.scrollIntoView({ block: "nearest" });
}

function showWatchView() {
  document.querySelectorAll(".modal:not(.hidden)").forEach((m) => m.classList.add("hidden"));
  $("#detail").classList.add("hidden");          // player replaces the series page…
  document.body.classList.remove("detailing");   // …but detailShownId is kept, so Back is instant
  syncTopbarH();
  $("#view-watch").classList.remove("hidden");
  document.body.classList.add("watching");
}
function exitWatch() {
  const video = $("#watchVideo");
  if (ccActive >= 0 && ccTracks[ccActive]) ccTracks[ccActive].track.removeEventListener("cuechange", ccCueHandler);
  ccActive = -1; $("#ccBox").innerHTML = ""; $("#ccMenu").classList.add("hidden");
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  clearTimeout(hideTimer);
  video.pause(); video.removeAttribute("src"); clearTracks(video); video.load();
  cancelAutoNext();
  watchPollers.forEach((iv) => clearInterval(iv)); watchPollers.clear();
  watch = null;
  $("#view-watch").classList.add("hidden");
  document.body.classList.remove("watching");
  if ($("#view-library").classList.contains("active")) loadLibrary(); // refresh progress
}

// --- auto-next -------------------------------------------------------------
let autoNextTimer = null;
const watchPollers = new Set(); // active /jobs poll intervals, cleared on exit
function cancelAutoNext() {
  if (autoNextTimer) { clearInterval(autoNextTimer); autoNextTimer = null; }
  $("#autoNext").classList.add("hidden");
}
function startAutoNext(nextEp) {
  cancelAutoNext(); // never stack countdowns
  const d = watch.detail;
  const meta = (d.episodeList || []).find((e) => e.number === nextEp) || { number: nextEp };
  $("#anThumb").src = meta.thumbnail || d.banner || d.poster || "";
  $("#anTitle").textContent = `E${nextEp}${meta.epTitle ? ` · ${meta.epTitle}` : ""}`;
  let n = 8;
  $("#anCountdown").textContent = `Next episode in ${n}s`;
  $("#autoNext").classList.remove("hidden");
  autoNextTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { cancelAutoNext(); goToEp(nextEp); return; }
    $("#anCountdown").textContent = `Next episode in ${n}s`;
  }, 1000);
}

// --- watch controls (bound once) -------------------------------------------
$("#watchBack").addEventListener("click", () => {
  if (offlineMode) return offlineBack();
  const tid = watch && watch.titleId;
  if (history.length > START_LEN) history.back();
  else location.hash = tid ? `#/title/${tid}` : ""; // deep-linked → fall back to the series page
});
// The series title (orange) doubles as a back-to-series link, Crunchyroll-style.
// Pop back to the series (no duplicate entry) when it's the entry behind us,
// else navigate (deep-link case with no series page in history).
$("#watchSeriesLink").addEventListener("click", (e) => {
  e.preventDefault();
  if (!watch) return;
  if (offlineMode) return offlineBack();
  const tid = watch.titleId;
  if (detailShownId === tid && history.length > START_LEN) history.back();
  else location.hash = `#/title/${tid}`;
});
$("#watchPrev").addEventListener("click", () => { if (watch) goToEp(watch.ep - 1); });
$("#watchNext").addEventListener("click", () => { if (watch) goToEp(watch.ep + 1); });
// --- Custom player: controls + captions rendered by us (reliable) ----------
let ccTracks = [], ccActive = -1, ccCueHandler = null, hideTimer = null;
const CC_NAMES = { en: "English", ja: "Japanese", es: "Spanish", "es-la": "Spanish (LA)", pt: "Portuguese",
  "pt-br": "Portuguese (BR)", fr: "French", de: "German", it: "Italian", ru: "Russian", ar: "Arabic",
  zh: "Chinese", ko: "Korean", id: "Indonesian", ms: "Malay", vi: "Vietnamese", th: "Thai", tr: "Turkish", hi: "Hindi", pl: "Polish" };
// Map 3-letter / regional codes to the 2-letter form so tracks tagged "eng"/"jpn"
// display cleanly and match the preferred-language setting.
const CC_ALIAS = { eng: "en", en: "en", jpn: "ja", jp: "ja", ja: "ja", spa: "es", es: "es",
  fre: "fr", fra: "fr", fr: "fr", ger: "de", deu: "de", de: "de", por: "pt", pt: "pt",
  rus: "ru", ru: "ru", ara: "ar", ar: "ar", ita: "it", it: "it", kor: "ko", ko: "ko", chi: "zh", zho: "zh", zh: "zh" };
function normCc(lang) { const l = (lang || "").toLowerCase(); return CC_ALIAS[l] || l; }
function ccName(lang) { const l = (lang || "").toLowerCase(); return CC_NAMES[l] || CC_NAMES[normCc(l)] || (l ? l.toUpperCase() : "Unknown"); }
function fmtTime(s) { s = Math.max(0, s | 0); const h = (s / 3600) | 0, m = ((s % 3600) / 60) | 0, ss = String(s % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`; }

function showControls() {
  const s = $("#watchStage"); if (!s) return;
  s.classList.remove("hide-controls");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { const v = $("#watchVideo"); if (v && !v.paused) s.classList.add("hide-controls"); }, 3000);
}
function renderCues(track) {
  const box = $("#ccBox"); box.innerHTML = "";
  const cues = track && track.activeCues;
  if (!cues) return;
  for (let i = 0; i < cues.length; i++) {
    const line = el("div", "cc-line");
    try { line.appendChild(cues[i].getCueAsHTML()); } catch { line.textContent = cues[i].text || ""; }
    box.appendChild(line);
  }
}
function applyCaption(idx) {
  if (ccActive >= 0 && ccTracks[ccActive]) ccTracks[ccActive].track.removeEventListener("cuechange", ccCueHandler);
  ccActive = idx;
  $("#ccBox").innerHTML = "";
  $("#pcCc").classList.toggle("on", idx >= 0);
  if (idx < 0 || !ccTracks[idx]) return;
  const track = ccTracks[idx].track;
  track.mode = "hidden";                 // parse cues but let us render them
  ccCueHandler = () => renderCues(track);
  track.addEventListener("cuechange", ccCueHandler);
  renderCues(track);
}
function buildCcMenu() {
  const menu = $("#ccMenu");
  let html = '<div class="cc-head">Subtitles</div>';
  html += `<button class="cc-item${ccActive < 0 ? " on" : ""}" data-idx="-1">Off</button>`;
  ccTracks.forEach((t, i) => { html += `<button class="cc-item${ccActive === i ? " on" : ""}" data-idx="${i}">${esc(ccName(t.lang))}</button>`; });
  menu.innerHTML = html;
  menu.querySelectorAll(".cc-item").forEach((b) => b.addEventListener("click", () => {
    const idx = Number(b.dataset.idx);
    applyCaption(idx); buildCcMenu(); menu.classList.add("hidden");
    saveCcLang(idx < 0 ? "off" : ccTracks[idx].lang);
  }));
}
function setupCaptions(video) {
  if (ccActive >= 0 && ccTracks[ccActive]) ccTracks[ccActive].track.removeEventListener("cuechange", ccCueHandler);
  ccTracks = []; ccActive = -1;
  const tt = video.textTracks;
  for (let i = 0; i < tt.length; i++) {
    tt[i].mode = "hidden";
    const lang = (tt[i].language || "en").toLowerCase();
    // One entry per language — drop duplicates (e.g. a signs track that slipped
    // through, or the same language from two sources) so the menu stays clean.
    if (ccTracks.some((c) => normCc(c.lang) === normCc(lang))) continue;
    ccTracks.push({ lang, track: tt[i] });
  }
  const prefRaw = (me && me.ccLang) || "en";
  const pref = normCc(prefRaw);
  let idx = -1;
  if (prefRaw !== "off" && ccTracks.length) {
    idx = ccTracks.findIndex((t) => normCc(t.lang) === pref);       // exact preferred language
    if (idx < 0) idx = ccTracks.findIndex((t) => normCc(t.lang) === "en"); // else English
    if (idx < 0) idx = 0;                                            // else first available
  }
  applyCaption(idx);
  buildCcMenu();
}
async function saveCcLang(lang) {
  if (me) me.ccLang = lang;
  try { await api("/account/add-defaults", { method: "POST", body: JSON.stringify({ ccLang: lang }) }); } catch { /* ignore */ }
}

// Fullscreen the STAGE (keeps our controls + captions); the Android client locks landscape.
function enterVideoFullscreen() {
  const stage = $("#watchStage"), v = $("#watchVideo");
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    return;
  }
  try {
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS: video-only
  } catch { /* ignore */ }
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {}); } catch { /* unsupported */ }
}

let playerInit = false;
function initPlayer() {
  if (playerInit) return; playerInit = true;
  const v = $("#watchVideo"), stage = $("#watchStage");
  let scrubbing = false;
  const toggle = () => { if (v.paused) v.play().catch(() => {}); else v.pause(); };
  $("#pcPlay").addEventListener("click", toggle);
  $("#pcBig").addEventListener("click", toggle);
  v.addEventListener("click", toggle);
  v.addEventListener("play", () => { $("#pcPlay").textContent = "❚❚"; $("#pcBig").textContent = "❚❚"; stage.classList.remove("paused"); showControls(); });
  v.addEventListener("pause", () => { $("#pcPlay").textContent = "▶"; $("#pcBig").textContent = "▶"; stage.classList.add("paused"); showControls(); });
  v.addEventListener("timeupdate", () => {
    if (!scrubbing && v.duration) $("#pcSeek").value = String(((v.currentTime / v.duration) * 1000) | 0);
    $("#pcCur").textContent = fmtTime(v.currentTime);
  });
  v.addEventListener("loadedmetadata", () => { $("#pcDur").textContent = fmtTime(v.duration); });
  v.addEventListener("volumechange", () => {
    $("#pcMute").textContent = (v.muted || !v.volume) ? "🔇" : (v.volume < 0.5 ? "🔉" : "🔊");
    $("#pcVol").value = String(Math.round((v.muted ? 0 : v.volume) * 100));
  });
  $("#pcVol").addEventListener("input", () => { const val = Number($("#pcVol").value) / 100; v.muted = val === 0; v.volume = val; });
  $("#pcSeek").addEventListener("input", () => { scrubbing = true; if (v.duration) $("#pcCur").textContent = fmtTime(v.duration * $("#pcSeek").value / 1000); });
  $("#pcSeek").addEventListener("change", () => { if (v.duration) v.currentTime = v.duration * $("#pcSeek").value / 1000; scrubbing = false; });
  $("#pcMute").addEventListener("click", () => { v.muted = !v.muted; });
  const rates = [1, 1.25, 1.5, 2, 0.5]; let ri = 0;
  $("#pcRate").addEventListener("click", () => { ri = (ri + 1) % rates.length; v.playbackRate = rates[ri]; $("#pcRate").textContent = rates[ri] + "×"; });
  $("#pcCc").addEventListener("click", (e) => { e.stopPropagation(); $("#ccMenu").classList.toggle("hidden"); });
  $("#pcFs").addEventListener("click", enterVideoFullscreen);
  stage.addEventListener("mousemove", showControls);
  stage.addEventListener("touchstart", showControls, { passive: true });
  stage.addEventListener("click", (e) => { if (!e.target.closest("#ccMenu") && !e.target.closest("#pcCc")) $("#ccMenu").classList.add("hidden"); });
  document.addEventListener("keydown", (e) => {
    if (!watch || document.querySelector(".modal:not(.hidden)")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
    else if (e.key === "f") enterVideoFullscreen();
    else if (e.key === "ArrowRight") v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5);
    else if (e.key === "ArrowLeft") v.currentTime = Math.max(0, v.currentTime - 5);
  });
}
initPlayer();
$("#watchSeason").addEventListener("change", (e) => play(Number(e.target.value), 1));
$("#anPlay").addEventListener("click", () => { if (watch) { const n = watch.ep + 1; cancelAutoNext(); goToEp(n); } });
$("#anCancel").addEventListener("click", cancelAutoNext);

$("#watchDownload").addEventListener("click", async () => {
  if (!watch) return;
  try {
    const job = await api(`/titles/${watch.titleId}/download/${watch.ep}`, { method: "POST" });
    $("#watchDownload").disabled = true;
    $("#watchNote").textContent = "Downloading in background — will switch to local when done.";
    watchJob(job.id); loadJobs();
  } catch (e) { toast(e.message); }
});

$("#watchVideo").addEventListener("ended", async () => {
  if (!watch) return;
  const titleId = watch.titleId, endedEp = watch.ep, detail = watch.detail; // capture: watch may change during the await
  if (!navigator.onLine) {
    Offline.queueWatched(titleId, endedEp); // sync on reconnect
  } else {
    try {
      await api(`/titles/${titleId}/watched/${endedEp}`, { method: "POST" });
      refreshUpdatesBadge();
      invalidateDetail(titleId); // series page reflects the new Watched state on Back / live
    } catch { /* trackers optional */ }
  }
  if (!watch || watch.titleId !== titleId || watch.ep !== endedEp) return; // exited or moved on
  const max = airedCount(detail);
  if (detail.type !== "movie" && endedEp < max) startAutoNext(endedEp + 1);
});

function stopPoller(iv) { clearInterval(iv); watchPollers.delete(iv); }
function watchJob(jobId) {
  const jobTitleId = watch && watch.titleId; // which title this download belongs to
  const iv = setInterval(async () => {
    try {
      const jobs = await api("/jobs");
      const j = jobs.find((x) => x.id === jobId);
      if (!j) return stopPoller(iv);
      if (j.status === "downloaded") {
        stopPoller(iv);
        if (watch) $("#watchNote").textContent = "Saved to library ✓";
        toast("Download complete");
        loadJobs();
        invalidateDetail(jobTitleId); // series page shows the new ✓ Saved on Back / live
      } else if (j.status === "failed") {
        stopPoller(iv);
        $("#watchNote").textContent = "Download failed: " + (j.message || "");
      }
    } catch { stopPoller(iv); }
  }, 3000);
  watchPollers.add(iv);
}

// ---------------------------------------------------------------------------
// downloads panel
// ---------------------------------------------------------------------------
async function loadAutodl() {
  try {
    const s = await api("/autodl/status");
    const you = s.scope === "you";
    const bits = s.enabled
      ? [`<span class="on-dot">●</span> Auto-downloader on — every ${s.intervalMin}m, ${s.trackedTitles} ${you ? "tracked for you" : "tracked"}`,
         s.lastRun ? `last run ${new Date(s.lastRun).toLocaleTimeString()} (queued ${s.lastQueued}${you ? " for you" : ""})` : "first run pending",
         s.lastError ? `⚠ ${esc(s.lastError)}` : ""]
      : ["○ Auto-downloader off — set AUTO_DOWNLOAD=true in .env"];
    $("#autodlText").innerHTML = bits.filter(Boolean).join(" · ");
    $("#autodlRun").disabled = s.running;
    // "Run now" is owner-only server-side — don't offer a button that 403s.
    if (s.canRun !== undefined) $("#autodlRun").classList.toggle("hidden", !s.canRun);
    // Self-check warnings: the whole point is that a silent skip says so here.
    const checks = s.checks || [];
    const box = $("#autodlChecks");
    box.classList.toggle("hidden", !checks.length);
    box.innerHTML = checks.map((c) => `<div class="autodl-check">⚠ ${esc(c.message)}</div>`).join("");
    box.querySelectorAll(".autodl-check").forEach((el, i) => {
      if (checks[i].action === "settings:credentials") { el.classList.add("clickable"); el.onclick = () => openSettings(); }
    });
  } catch { /* ignore */ }
}

$("#autodlRun").addEventListener("click", async () => {
  $("#autodlRun").disabled = true;
  toast("Auto-download pass started…");
  try {
    const r = await api("/autodl/run", { method: "POST" });
    toast(`Auto-download queued ${r.queued}`);
    loadJobs();
  } catch (e) { toast(e.message); }
  finally { loadAutodl(); }
});

// Retry every failed download at once.
$("#retryAll").addEventListener("click", async () => {
  const btn = $("#retryAll");
  btn.disabled = true;
  try {
    const jobs = await api("/jobs");
    const failed = jobs.filter((j) => j.status === "failed" && j.mine !== false && !(me && me.downloadsDenied));
    if (!failed.length) { toast("Nothing to retry"); return; }
    let ok = 0;
    for (const j of failed) {
      try { await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" }); ok++; }
      catch { /* keep going; one bad job shouldn't stop the rest */ }
    }
    toast(`Retrying ${ok} download${ok === 1 ? "" : "s"}`);
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; loadJobs(); }
});

async function loadJobs() {
  loadAutodl();
  try {
    const jobs = await api("/jobs");
    const active = jobs.filter((j) => ["queued", "searching", "downloading"].includes(j.status));
    const badge = $("#dlBadge");
    badge.textContent = active.length;
    badge.classList.toggle("hidden", active.length === 0);

    // "Retry all" is shown only when there are failed jobs I'm allowed to retry.
    const canRetry = (j) => j.status === "failed" && j.mine !== false && !(me && me.downloadsDenied);
    $("#retryAll").classList.toggle("hidden", !jobs.some(canRetry));

    const list = $("#jobsList");
    list.innerHTML = "";
    if (!jobs.length) { list.append(el("div", "empty", "No downloads.")); return; }

    // Group by series so a season batch shows as one collapsible group.
    const groups = new Map();
    jobs.forEach((j) => { (groups.get(j.titleId) ?? groups.set(j.titleId, []).get(j.titleId)).push(j); });

    for (const [, gjobs] of groups) {
      const grp = el("div", "job-group");
      const dl = gjobs.filter((j) => ["downloading", "searching"].includes(j.status)).length;
      const q = gjobs.filter((j) => j.status === "queued").length;
      const failed = gjobs.filter((j) => j.status === "failed").length;
      const done = gjobs.filter((j) => j.status === "downloaded").length;
      const parts = [dl && `${dl} active`, q && `${q} queued`, failed && `${failed} failed`, done && `${done} done`].filter(Boolean);
      const head = el("div", "job-group-head");
      head.innerHTML = `<span class="jg-title">${esc(gjobs[0].title)}</span>
        <span class="jg-sum">${gjobs.length} ep${gjobs.length === 1 ? "" : "s"}${parts.length ? " · " + parts.join(" · ") : ""}</span>`;
      if (gjobs.some(canRetry)) {
        const rall = el("button", "retry-btn", "↻ Retry failed");
        rall.addEventListener("click", async () => {
          rall.disabled = true;
          for (const j of gjobs.filter(canRetry)) { try { await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" }); } catch { /* keep going */ } }
          loadJobs();
        });
        head.append(rall);
      }
      grp.append(head);

      gjobs.sort((a, b) => a.episode - b.episode).forEach((j) => {
        const pct = Math.round((j.progress || 0) * 100);
        const node = el("div", `job ${j.status}`);
        node.innerHTML = `
          <div class="row"><span class="name">E${j.episode}</span>
            <span class="st">${esc(j.status)}${j.status === "downloading" ? " " + pct + "%" : ""}</span></div>
          ${j.message ? `<div class="row"><span class="st">${esc(j.message)}</span></div>` : ""}
          <div class="track"><div class="fill" style="width:${j.status === "downloaded" ? 100 : pct}%"></div></div>`;
        const actions = el("div", "job-actions");
        if (j.status === "queued" && j.mine !== false) {
          const now = el("button", "retry-btn", "↑ Download now");
          now.addEventListener("click", async () => {
            now.disabled = true;
            try { await api(`/jobs/${j.id}/prioritize`, { method: "POST" }); toast("Moved to the front"); loadJobs(); }
            catch (e) { toast(e.message); now.disabled = false; }
          });
          actions.append(now);
        }
        if (canRetry(j)) {
          const retry = el("button", "retry-btn", "↻ Retry");
          retry.addEventListener("click", async () => {
            retry.disabled = true;
            try { await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" }); toast("Retrying…"); loadJobs(); }
            catch (e) { toast(e.message); retry.disabled = false; }
          });
          actions.append(retry);
        }
        if (actions.children.length) node.append(actions);
        grp.append(node);
      });
      list.append(grp);
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// modal plumbing
// ---------------------------------------------------------------------------
function openModal(sel) { $(sel).classList.remove("hidden"); }
function closeModal(node) {
  if (node && node.id === "settings") { location.hash = ""; return; } // routed config page — clear the URL
  node.classList.add("hidden");
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => closeModal(e.target.closest(".modal"))));
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); }));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (lightboxOpen()) { closeLightbox(); return; } // close the cover viewer first
  const open = document.querySelectorAll(".modal:not(.hidden)");
  if (open.length) { open.forEach(closeModal); return; }
  if (!$("#detail").classList.contains("hidden")) $("#detailBack").click(); // Esc backs out of the series page
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
let me = null;
let jobsTimer = null;

async function boot() {
  // Invite acceptance link: /invite/<token>
  const inviteMatch = location.pathname.match(/^\/invite\/([\w-]+)$/);
  if (inviteMatch) return showInvite(inviteMatch[1]);
  // Password-reset link: /?reset=<token>
  const resetTok = new URLSearchParams(location.search).get("reset");
  if (resetTok) return showReset(resetTok);

  let info, netFail = false;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    info = res.ok ? await res.json() : { setupRequired: false };
    if (res.status === 401) info = { unauthorized: true };
  } catch { netFail = true; info = { unauthorized: true }; }

  // Server unreachable (offline / down): drop into offline mode so saved
  // downloads are still watchable. A 401 is a real auth failure → login gate.
  if (netFail) return startOfflineMode();

  if (info.setupRequired) return showSetup();
  if (info.unauthorized || !info.user) return showAuthGate("login");
  startApp(info.user);
}

// ---- offline mode (no network at launch) ----------------------------------
let offlineMode = false;
function startOfflineMode() {
  offlineMode = true;
  if (isTv()) {                      // nothing is ever saved locally on a TV
    document.getElementById("authGate").classList.add("hidden");
    $("#offlineBar") && $("#offlineBar").classList.remove("hidden");
    return;
  }
  markOffline(); // we launched with no server → we've been offline
  $("#offlineClose").classList.add("hidden");    // cold launch: nothing to close back to
  $("#offlineRetry").classList.remove("hidden");
  $("#offlineGate").classList.remove("hidden");
  updateOfflineUi();
  renderOfflineLibrary();
}
function renderOfflineLibrary() {
  const grid = $("#offlineGrid");
  const man = Offline.man();
  const entries = Object.values(man);
  $("#offlineEmpty").classList.toggle("hidden", entries.length > 0);
  grid.innerHTML = "";
  // Group saved episodes by title id, then collapse seasons of the same series
  // (shared seriesKey) into one card — the latest season's real poster/title,
  // exactly like the online library.
  const byTitle = {};
  entries.forEach((e) => { (byTitle[e.id] = byTitle[e.id] || []).push(e); });
  const groups = {};
  Object.keys(byTitle).forEach((tid) => {
    const meta = Offline.getMeta(Number(tid));
    const gk = (meta && meta.seriesKey) || tid;
    (groups[gk] = groups[gk] || []).push(Number(tid));
  });
  Object.values(groups).forEach((ids) => {
    const metas = ids.map((id) => Offline.getMeta(id)).filter(Boolean);
    const rep = metas.slice().sort((a, b) => (b.seasonNum || 0) - (a.seasonNum || 0) || (b.year || 0) - (a.year || 0))[0];
    const repId = rep ? rep.id : ids[0];
    const count = ids.reduce((n, id) => n + (byTitle[id] ? byTitle[id].length : 0), 0);
    const poster = (rep && (rep.poster || rep.banner)) || "/android-chrome-512x512.png";
    const title = rep ? (rep.english || rep.romaji)
      : (((byTitle[ids[0]][0] || {}).label) || `Title ${ids[0]}`).split(" · ")[0];
    const card = el("div", "card");
    card.innerHTML = `
      <span class="pill">${ids.length > 1 ? ids.length + " seasons" : (rep && rep.type === "movie" ? "Movie" : "Series")}</span>
      <span class="dot" title="downloaded"></span>
      <img class="poster" loading="lazy" src="${esc(poster)}" alt="" onerror="this.style.opacity=.15" />
      <div class="cap">
        <div class="t">${esc(title)}</div>
        <div class="m">${count} episode${count === 1 ? "" : "s"} saved</div>
      </div>`;
    card.addEventListener("click", () => openOfflineDetail(repId));
    grid.append(card);
  });
}
// Rich offline detail from cached metadata (banner/info/episodes) so the page
// looks identical to online; downloaded episodes are the playable ones.
function offlineDetail(id) {
  const meta = Offline.getMeta(id);
  const saved = Object.values(Offline.man()).filter((e) => e.id === id).map((e) => e.ep);
  const has = (n) => saved.includes(n);
  if (meta) {
    const list = (meta.episodeList && meta.episodeList.length ? meta.episodeList
      : saved.slice().sort((a, b) => a - b).map((n) => ({ number: n, epTitle: null, thumbnail: null, aired: true })));
    return {
      id, type: meta.type || "series", english: meta.english, romaji: meta.romaji,
      description: meta.description || "", genres: meta.genres || [], content: meta.content || [],
      banner: meta.banner || "", poster: meta.poster || "", year: meta.year ?? null,
      seasonNum: meta.seasonNum ?? 1, seasonPart: meta.seasonPart ?? null, seasonKind: meta.seasonKind ?? "season", seasonFormat: meta.seasonFormat ?? null, seasons: [],
      duration: meta.duration ?? null, episodesTotal: meta.episodesTotal ?? list.length,
      watchedThrough: meta.watchedThrough || 0,
      episodeList: list.map((e) => ({ ...e, hasFile: has(e.number) })),
    };
  }
  // Fallback for downloads saved before metadata caching existed.
  const eps = Object.values(Offline.man()).filter((e) => e.id === id).sort((a, b) => a.ep - b.ep);
  const series = (eps[0]?.label || `Title ${id}`).split(" · ")[0];
  return {
    id, type: "series", english: series, romaji: series, description: "",
    seasonNum: 1, seasonPart: null, seasons: [], banner: "", poster: "",
    episodeList: eps.map((e) => ({ number: e.ep, aired: true, hasFile: true, epTitle: null, thumbnail: null })),
    watchedThrough: 0,
  };
}
// Open the exact detail page for a downloaded series (from the Downloads gate).
function openOfflineDetail(id) {
  $("#offlineGate").classList.add("hidden");
  $("#detail").scrollTop = 0;
  showDetailView();
  paintDetail(offlineDetail(id), { offline: true });
  offlineDetailOpen = true;
}
function playOffline(id, ep) {
  const d = offlineDetail(id);
  watch = { watchId: "offline:" + id, titleId: id, detail: d, ep: null, prefetch: null };
  $("#offlineGate").classList.add("hidden");
  renderWatchShell(d);
  showWatchView();
  goToEp(ep);
}
function offlineBack() {
  const v = $("#watchVideo"); if (v) { v.pause(); v.removeAttribute("src"); v.load(); }
  document.body.classList.remove("watching");
  $("#view-watch").classList.add("hidden");
  $("#offlineGate").classList.remove("hidden");
  watch = null;
  renderOfflineLibrary();
}
// Open the Downloads library on demand (works online too) — the mode button.
function openDownloads() {
  offlineDetailOpen = false;
  $("#offlineClose").classList.remove("hidden");
  $("#offlineRetry").classList.toggle("hidden", navigator.onLine); // retry only matters offline
  $("#offlineGate").classList.remove("hidden");
  $("#detail").classList.add("hidden");
  renderOfflineLibrary();
}
function closeDownloads() { $("#offlineGate").classList.add("hidden"); }
$("#offlineClose").addEventListener("click", closeDownloads);
$("#offlineRetry").addEventListener("click", () => location.reload());

// ---- invite acceptance ----
let inviteToken = null;
async function showInvite(token) {
  inviteToken = token;
  const gate = document.getElementById("inviteGate");
  gate.classList.remove("hidden");
  try {
    const info = await fetch(`/api/auth/invite/${token}`, { credentials: "same-origin" }).then((r) => r.json());
    if (!info.valid) { $("#inviteError").textContent = info.error || "Invalid invite"; $("#inviteSubmit").disabled = true; return; }
    $("#inviteRoleNote").textContent = `You'll join as a ${info.role}.`;
    if (info.presetUsername) { $("#inviteUser").value = info.username; $("#inviteUser").disabled = true; }
    $("#inviteUser").focus();
  } catch { $("#inviteError").textContent = "Could not load invite"; }
}
$("#invitePass").addEventListener("input", () => {
  const s = pwStrength($("#invitePass").value); $("#invitePwBar").className = s <= 1 ? "weak" : s <= 2 ? "ok" : "strong";
});
async function submitInvite() {
  $("#inviteError").textContent = "";
  const username = $("#inviteUser").value.trim();
  const password = $("#invitePass").value;
  if (password.length < 8) return void ($("#inviteError").textContent = "Password must be at least 8 characters");
  if (password !== $("#invitePass2").value) return void ($("#inviteError").textContent = "Passwords don't match");
  $("#inviteSubmit").disabled = true;
  try {
    const r = await fetch("/api/auth/invite/accept", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: inviteToken, username, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "failed");
    history.replaceState(null, "", "/");
    document.getElementById("inviteGate").classList.add("hidden");
    startApp(data.user);
    if (!data.user.realDebridConnected && !data.user.allDebridConnected) openSettings("credentials");
  } catch (e) { $("#inviteError").textContent = e.message; $("#inviteSubmit").disabled = false; }
}
$("#inviteSubmit").addEventListener("click", submitInvite);
$("#invitePass2").addEventListener("keydown", (e) => { if (e.key === "Enter") submitInvite(); });

// ---- password reset ----
let resetToken = null;
async function showReset(token) {
  try {
    const info = await fetch(`/api/auth/reset/${encodeURIComponent(token)}`, { credentials: "same-origin" }).then((r) => r.json());
    if (!info.valid) { toast(info.error || "This reset link is invalid or has expired"); history.replaceState(null, "", "/"); return showAuthGate(); }
    resetToken = token;
    $("#resetUser").textContent = info.username;
    $("#resetGate").classList.remove("hidden");
    $("#resetPass").focus();
  } catch { toast("Could not open reset link"); showAuthGate(); }
}
async function submitReset() {
  $("#resetError").textContent = "";
  const p = $("#resetPass").value, p2 = $("#resetPass2").value;
  if (p.length < 8) return void ($("#resetError").textContent = "Password must be at least 8 characters");
  if (p !== p2) return void ($("#resetError").textContent = "Passwords don't match");
  $("#resetSubmit").disabled = true;
  try {
    const r = await fetch("/api/auth/reset", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: resetToken, password: p }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "failed");
    history.replaceState(null, "", "/");
    $("#resetGate").classList.add("hidden");
    startApp(data.user);
    if (!data.user.realDebridConnected && !data.user.allDebridConnected) openSettings("credentials");
  } catch (e) { $("#resetError").textContent = e.message; $("#resetSubmit").disabled = false; }
}
$("#resetSubmit").addEventListener("click", submitReset);
$("#resetPass2").addEventListener("keydown", (e) => { if (e.key === "Enter") submitReset(); });

// ---- login ----
function showAuthGate() {
  document.getElementById("authGate").classList.remove("hidden");
  $("#authError").textContent = "";
  $("#authUser").focus();
  if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
}

async function submitAuth() {
  const username = $("#authUser").value.trim();
  const password = $("#authPass").value;
  $("#authError").textContent = "";
  try {
    const r = await fetch(`/api/auth/login`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password, remember: $("#authRemember").checked }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "failed");
    document.getElementById("authGate").classList.add("hidden");
    startApp(data.user);
  } catch (e) {
    $("#authError").textContent = e.message === "failed" ? "Invalid credentials" : e.message;
  }
}
// Submitting via the form covers all three paths: the Sign in button, a hardware
// Enter, and the Android TV keyboard's Go action (which fires an editor action
// rather than a reliable DOM keydown).
$("#authForm").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });
$("#authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitAuth(); } });
// Go/Next from the username field moves on instead of dead-ending in the keyboard.
$("#authUser").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#authPass").focus(); } });

// Forgot password: requires the username, and the response is always generic
// (it never reveals whether the account or an email exists).
$("#forgotBtn").addEventListener("click", async () => {
  const username = $("#authUser").value.trim();
  if (!username) { $("#authError").textContent = "Enter your username first"; $("#authUser").focus(); return; }
  $("#forgotBtn").disabled = true;
  try {
    await fetch("/api/auth/forgot", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    });
  } catch { /* generic regardless */ }
  $("#authError").textContent = "";
  toast("If that account exists and has an email set, a reset link was sent.");
  $("#forgotBtn").disabled = false;
});

// ---- first-run setup ----
function showSetup() {
  document.getElementById("setupGate").classList.remove("hidden");
  $("#setupStep1").classList.remove("hidden");
  $("#setupStep2").classList.add("hidden");
  $("#setupUser").focus();
  if (jobsTimer) { clearInterval(jobsTimer); jobsTimer = null; }
}

function pwStrength(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++;
  return s; // 0..4
}
$("#setupPass").addEventListener("input", () => {
  const s = pwStrength($("#setupPass").value);
  const bar = $("#pwBar");
  bar.className = s <= 1 ? "weak" : s <= 2 ? "ok" : "strong";
});

async function submitSetupOwner() {
  const username = $("#setupUser").value.trim();
  const password = $("#setupPass").value;
  const confirm = $("#setupPass2").value;
  $("#setupError").textContent = "";
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    return void ($("#setupError").textContent = "Username: 2–32 chars — letters, digits, . _ -");
  }
  if (password.length < 8) return void ($("#setupError").textContent = "Password must be at least 8 characters");
  if (password !== confirm) return void ($("#setupError").textContent = "Passwords don't match");
  $("#setupSubmit").disabled = true;
  try {
    const r = await fetch("/api/auth/setup", {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "setup failed");
    me = data.user;
    // If the owner already inherited a Real-Debrid token (seeded from env),
    // there's nothing to connect — finish immediately.
    if (data.user.realDebridConnected) {
      document.getElementById("setupGate").classList.add("hidden");
      toast("Owner account created");
      return startApp(me);
    }
    // Otherwise advance to the Real-Debrid step.
    $("#setupStep1").classList.add("hidden");
    $("#setupStep2").classList.remove("hidden");
    $("#setupRd").focus();
  } catch (e) {
    $("#setupError").textContent = e.message;
  } finally {
    $("#setupSubmit").disabled = false;
  }
}
$("#setupSubmit").addEventListener("click", submitSetupOwner);
$("#setupPass2").addEventListener("keydown", (e) => { if (e.key === "Enter") submitSetupOwner(); });

async function finishSetup(rdToken) {
  $("#setupError").textContent = "";
  if (rdToken) {
    try {
      const r = await api("/account/realdebrid", { method: "POST", body: JSON.stringify({ token: rdToken }) });
      if (me) me.realDebridConnected = r.realDebridConnected;
      if (r.realDebridConnected && !r.premium) toast("Connected — note: this Real-Debrid account is not premium");
    } catch (e) {
      $("#setupError").textContent = e.message;
      return; // stay on the RD step so they can retry or skip
    }
  }
  document.getElementById("setupGate").classList.add("hidden");
  startApp(me);
}
$("#setupRdSave").addEventListener("click", () => finishSetup($("#setupRd").value.trim()));
$("#setupRdSkip").addEventListener("click", () => finishSetup(""));
$("#setupRd").addEventListener("keydown", (e) => { if (e.key === "Enter") finishSetup($("#setupRd").value.trim()); });

// The native clients have no server address compiled in — the user points them at
// their own. Offer a way back to that picker, but only in a shell that supports it,
// so the browser never shows a control it can't honour.
(function () {
  const btn = $("#serverBtn");
  const plug = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.RenzoServer;
  if (!btn || !plug) return;
  btn.classList.remove("hidden");
  btn.addEventListener("click", async () => {
    if (!confirm("Disconnect from this server? You'll be asked for a server address next time.")) return;
    try { await plug.clear(); } catch (e) { toast("Couldn't switch server: " + (e.message || e)); }
  });
})();

$("#logoutBtn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  me = null;
  location.reload();
});

function initial(name) { return (name || "·").trim().charAt(0).toUpperCase() || "·"; }

const roleLabel = (r) => r === "owner" ? "Owner" : r === "manager" ? "Manager" : "User";
function startApp(user) {
  me = user;
  applyTheme(user.theme || {}); // reconcile with the server (and refresh localStorage)
  try { localStorage.setItem("renzo:theme", JSON.stringify(currentTheme)); } catch { /* ignore */ }
  const isStaff = user.role === "owner" || user.role === "manager";
  const isOwner = user.role === "owner";
  $("#usersBlock").style.display = isStaff ? "" : "none";
  $("#usersNavBtn").style.display = isStaff ? "" : "none";
  $("#emailNavBtn").style.display = isOwner ? "" : "none";
  $("#emailBlock").style.display = isOwner ? "" : "none";
  // Managers can't create other managers — hide that option.
  document.querySelectorAll("#inviteRole option[data-owner]").forEach((o) => { o.hidden = !isOwner; });
  // Account menu header + avatar
  $("#acctBtn").textContent = initial(user.username);
  $("#acctMenuName").textContent = user.username;
  $("#acctMenuRole").textContent = roleLabel(user.role);
  loadStatus();
  renderContentChips();
  suppressAutofill(); // stop the browser password manager hijacking every input
  maybeSetupNativeBackground();
  loadBrowse();
  loadJobs();
  refreshUpdatesBadge();
  if (!jobsTimer) jobsTimer = setInterval(loadJobs, 4000);
  route(); // honor a bookmarked #/watch or #/title URL first (shows the overlay)
  // Only nudge to connect Real-Debrid when NOT deep-linking into an overlay —
  // otherwise showDetailView/showWatchView would instantly hide the prompt.
  if (!parseWatchHash() && !parseTitleHash() && !user.realDebridConnected && !user.allDebridConnected) {
    toast("Connect Real-Debrid or AllDebrid in Settings to start streaming");
    openSettings("credentials");
  }
}

// ---------------------------------------------------------------------------
// account menu (topbar)
// ---------------------------------------------------------------------------
$("#acctBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#acctMenu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".acct")) $("#acctMenu").classList.add("hidden");
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
$("#settingsBtn").addEventListener("click", () => openSettings("account"));

// pane navigation
document.querySelectorAll(".settings-nav button[data-pane]").forEach((btn) => {
  btn.addEventListener("click", () => { location.hash = "#/settings/" + btn.dataset.pane; });
});
function setPane(name) {
  document.querySelectorAll(".settings-nav button[data-pane]").forEach((b) =>
    b.classList.toggle("active", b.dataset.pane === name));
  document.querySelectorAll(".pane[data-pane]").forEach((p) =>
    p.classList.toggle("active", p.dataset.pane === name));
}

function setPill(el, state, label) {
  el.textContent = label;
  el.className = "pill-state " + state;
}

// Live service status (RD + tracker connections + auth-site link URL).
let lastHealth = null;
async function fetchHealth() {
  try { lastHealth = await api("/health"); } catch { lastHealth = null; }
  return lastHealth;
}

const RD_MAP = {
  premium: ["ok", "Premium"],
  "not-premium": ["warn", "Connected · not premium"],
  connected: ["ok", "Connected"],
  "not-connected": ["err", "Not connected"],
  invalid: ["err", "Invalid token"],
};

// Populate every connection pill + the tracker link buttons from a health payload.
function applyHealth(h) {
  if (!h) return;
  const [rs, rl] = RD_MAP[h.realdebrid] || ["err", "Not connected"];
  setPill($("#accRd"), rs, rl);
  setPill($("#rdState"), rs, rl);
  const [as, al] = RD_MAP[h.alldebrid] || ["err", "Not connected"];
  if ($("#adState")) setPill($("#adState"), as, al);
  // Preferred-provider selector only matters when both are connected.
  const bothDebrid = h.realdebrid !== "not-connected" && h.alldebrid !== "not-connected";
  if ($("#debridPrefRow")) {
    $("#debridPrefRow").style.display = bothDebrid ? "" : "none";
    if (h.debrid) $("#debridPref").value = h.debrid;
  }
  const ani = !!h.trackers?.anilist, mal = !!h.trackers?.mal;
  setPill($("#accAni"), ani ? "ok" : "warn", ani ? "Connected" : "Not connected");
  setPill($("#accMal"), mal ? "ok" : "warn", mal ? "Connected" : "Not connected");
  setPill($("#trkAni"), ani ? "ok" : "err", ani ? "Connected" : "Not linked");
  setPill($("#trkMal"), mal ? "ok" : "err", mal ? "Connected" : "Not linked");
  $("#trkAniDesc").textContent = ani ? "Connected — importing & scrobbling" : "Not linked yet";
  $("#trkMalDesc").textContent = mal ? "Connected — importing & scrobbling" : "Not linked yet";
  const site = h.authsite || {};
  [["#aniConnect", ani], ["#malConnect", mal]].forEach(([sel, on]) => {
    const b = $(sel);
    if (site.enabled && site.url) {
      b.style.display = "";
      b.textContent = on ? "Reconnect ↗" : "Connect ↗";
    } else {
      b.style.display = "none";
    }
  });
  if (me) { me.realDebridConnected = h.realdebrid !== "not-connected"; me.allDebridConnected = h.alldebrid !== "not-connected"; }
}

// Navigate to the dedicated config page (routed at #/settings[/pane]).
function openSettings(pane) {
  location.hash = "#/settings" + (pane && pane !== "account" ? "/" + pane : "");
}
async function showSettingsPage(pane) {
  const wasOpen = !$("#settings").classList.contains("hidden");
  $("#acctMenu").classList.add("hidden");
  openModal("#settings");
  setPane(pane || "account");
  if (wasOpen) return; // just switched panes — skip the (re)fetch/populate below
  try {
    const [meRes, h] = await Promise.all([
      fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetchHealth(),
    ]);
    const u = meRes.user || me || {};
    if (u.username) me = { ...me, ...u };
    $("#acctEmail").value = u.email || "";
    $("#acctAvatar").textContent = initial(u.username);
    $("#acctName").textContent = u.username || "—";
    const roleEl = $("#acctRole");
    roleEl.textContent = roleLabel(u.role);
    roleEl.className = "role-badge" + (u.role === "owner" ? " owner" : u.role === "manager" ? " manager" : "");
    applyHealth(h);
    setPill($("#jimakuState"), u.jimakuConnected ? "ok" : "warn", u.jimakuConnected ? "Connected" : "Not connected");
    if (u.role === "owner" || u.role === "manager") loadUsers();
    if (u.role === "owner") loadSmtp();
    suppressAutofill(); // re-guard any inputs rendered into the settings panes
  } catch { /* ignore */ }
}

$("#trkRefresh").addEventListener("click", async () => {
  applyHealth(await fetchHealth());
  toast("Status refreshed");
});

// --- OAuth connect flow ----------------------------------------------------
// Open the auth site's /connect/<provider> in a POPUP. The user signs in at the
// provider and presses Accept; the provider redirects to the auth site, which
// stores the token and postMessages { type:'oauth-success' } back to us (its
// callback keeps window.opener alive via COOP same-origin-allow-popups). We also
// poll /health as a belt-and-suspenders fallback.
const AUTHSITE_PROVIDER = { anilist: "anilist", mal: "myanimelist" };

function connectTracker(provider) {
  const site = lastHealth?.authsite;
  if (!site?.enabled || !site.url) { toast("Auth site not configured"); return; }
  const url = `${site.url.replace(/\/$/, "")}/connect/${AUTHSITE_PROVIDER[provider]}`;
  const w = window.open(url, "fsa-oauth", "width=640,height=820,menubar=no,toolbar=no");
  if (!w) { toast("Popup blocked — allow popups, then try again"); return; }
  watchTrackerConnect(provider); // fallback polling in case the message is missed
}

// Poll /health until the tracker flips connected (fallback for the postMessage).
const pollers = {};
function watchTrackerConnect(provider) {
  clearInterval(pollers[provider]);
  let tries = 0;
  pollers[provider] = setInterval(async () => {
    tries++;
    const h = await fetchHealth();
    applyHealth(h);
    const on = provider === "anilist" ? h?.trackers?.anilist : h?.trackers?.mal;
    if (on) { onTrackerConnected(provider); }
    else if (tries >= 40) clearInterval(pollers[provider]); // give up after ~2 min
  }, 3000);
}

function onTrackerConnected(provider) {
  clearInterval(pollers[provider]);
  toast(`${provider === "anilist" ? "AniList" : "MyAnimeList"} connected ✓`);
  fetchHealth().then(applyHealth);
  if (document.querySelector(".view#view-library.active")) loadLibrary();
}

$("#aniConnect").addEventListener("click", () => connectTracker("anilist"));
$("#malConnect").addEventListener("click", () => connectTracker("mal"));

// The callback: auth site postMessages oauth-success/oauth-error to this window.
window.addEventListener("message", (e) => {
  const site = lastHealth?.authsite;
  if (!site?.url) return;
  let origin;
  try { origin = new URL(site.url).origin; } catch { return; }
  if (e.origin !== origin || !e.data || typeof e.data !== "object") return; // trust only the auth site
  const provider = e.data.provider === "myanimelist" ? "mal" : e.data.provider === "anilist" ? "anilist" : null;
  if (!provider) return;
  if (e.data.type === "oauth-success") onTrackerConnected(provider);
  else if (e.data.type === "oauth-error") { clearInterval(pollers[provider]); toast("Connection was cancelled or failed"); }
});

// Returning to this tab (e.g. after linking on the auth site) refreshes status.
window.addEventListener("focus", () => {
  if (me && !$("#settings").classList.contains("hidden")) fetchHealth().then(applyHealth);
});

$("#rdSave").addEventListener("click", async () => {
  const token = $("#rdToken").value.trim();
  try {
    const r = await api("/account/realdebrid", { method: "POST", body: JSON.stringify({ token }) });
    $("#rdToken").value = "";
    const state = r.premium ? "ok" : r.realDebridConnected ? "warn" : "err";
    const label = r.realDebridConnected ? (r.premium ? "Premium" : "Connected · not premium") : "Not connected";
    setPill($("#rdState"), state, label);
    setPill($("#accRd"), r.realDebridConnected ? "ok" : "err", r.realDebridConnected ? "Connected" : "Not connected");
    if (me) me.realDebridConnected = r.realDebridConnected;
    toast(r.realDebridConnected ? (r.premium ? "Real-Debrid connected" : "Connected — but account is NOT premium; downloads need premium") : "Real-Debrid disconnected");
    loadStatus();
    fetchHealth().then(applyHealth);
  } catch (e) { toast(e.message); }
});

$("#adSave")?.addEventListener("click", async () => {
  const key = $("#adKey").value.trim();
  try {
    const r = await api("/account/alldebrid", { method: "POST", body: JSON.stringify({ key }) });
    $("#adKey").value = "";
    if (me) me.allDebridConnected = r.allDebridConnected;
    setPill($("#adState"), r.allDebridConnected ? (r.premium ? "ok" : "warn") : "err",
      r.allDebridConnected ? (r.premium ? "Premium" : "Connected · not premium") : "Not connected");
    toast(r.allDebridConnected ? "AllDebrid connected" : "AllDebrid disconnected");
    fetchHealth().then(applyHealth);
  } catch (e) { toast(e.message); }
});

$("#debridPref")?.addEventListener("change", async () => {
  try { await api("/account/debrid", { method: "POST", body: JSON.stringify({ provider: $("#debridPref").value }) });
    toast(`Using ${$("#debridPref").value === "alldebrid" ? "AllDebrid" : "Real-Debrid"}`); }
  catch (e) { toast(e.message); }
});

$("#jimakuSave").addEventListener("click", async () => {
  const key = $("#jimakuKey").value.trim();
  try {
    const u = await api("/account/jimaku", { method: "POST", body: JSON.stringify({ key }) });
    $("#jimakuKey").value = "";
    if (me) me.jimakuConnected = u.jimakuConnected;
    setPill($("#jimakuState"), u.jimakuConnected ? "ok" : "warn", u.jimakuConnected ? "Connected" : "Not connected");
    toast(u.jimakuConnected ? "Jimaku connected — subtitles enabled" : "Jimaku key removed");
  } catch (e) { toast(e.message); }
});

document.querySelectorAll(".tracker-save").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const field = btn.dataset.tracker;
    const val = document.getElementById(field).value.trim();
    try {
      await api("/account/trackers", { method: "POST", body: JSON.stringify({ [field]: val }) });
      document.getElementById(field).value = "";
      toast("Saved");
      loadStatus();
    } catch (e) { toast(e.message); }
  });
});

$("#passSave").addEventListener("click", async () => {
  try {
    await api("/account/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword: $("#curPass").value, newPassword: $("#newPass").value }),
    });
    $("#curPass").value = ""; $("#newPass").value = "";
    toast("Password updated");
  } catch (e) { toast(e.message); }
});

$("#emailSave").addEventListener("click", async () => {
  try {
    const u = await api("/account/email", { method: "POST", body: JSON.stringify({ email: $("#acctEmail").value.trim() }) });
    if (me) me.email = u.email;
    toast(u.email ? "Email saved" : "Email cleared");
  } catch (e) { toast(e.message); }
});

// --- Jellyfin / personal API key -------------------------------------------
let apiKeyValue = "";
function copyText(text, okMsg) {
  if (!text) return toast("Nothing to copy");
  navigator.clipboard?.writeText(text)
    .then(() => toast(okMsg))
    .catch(() => { try { document.execCommand("copy"); toast(okMsg); } catch { toast("Copy failed"); } });
}
async function loadApiKey() {
  try {
    const r = await api("/account/apikey");
    apiKeyValue = r.apiKey || "";
    const inp = $("#apiKey");
    inp.type = "password"; inp.value = apiKeyValue; // masked by the field until "Show"
    $("#apiKeyReveal").textContent = "Show";
    $("#jfManifest").value = r.manifestUrl || "";
  } catch { /* pane still usable; key loads on next open */ }
}
// Load lazily the first time the Jellyfin pane is opened.
document.querySelector('.settings-nav button[data-pane="jellyfin"]')?.addEventListener("click", () => {
  if (!apiKeyValue) loadApiKey();
});
$("#apiKeyReveal")?.addEventListener("click", () => {
  const inp = $("#apiKey");
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("#apiKeyReveal").textContent = show ? "Hide" : "Show";
});
$("#apiKeyCopy")?.addEventListener("click", () => copyText(apiKeyValue, "API key copied"));
$("#jfManifestCopy")?.addEventListener("click", () => copyText($("#jfManifest").value, "Repository URL copied"));
$("#apiKeyRotate")?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Regenerate your API key? Anything using the old key (e.g. Jellyfin) will stop working until you paste the new one.")) return;
  try {
    const r = await api("/account/apikey/rotate", { method: "POST" });
    apiKeyValue = r.apiKey || "";
    const inp = $("#apiKey");
    inp.value = apiKeyValue;
    if (inp.type === "text") $("#apiKeyReveal").textContent = "Hide";
    toast("New API key generated — update it in Jellyfin");
  } catch (err) { toast(err.message); }
});

// --- Library defaults (per-user "on add" states) ---------------------------
async function loadDefaults() {
  const d = (me && me.addDefaults) || {};
  $("#defTrack").value = d.track || "";
  $("#defAutoStatus").value = (me && me.autoStatus === false) ? "off" : "on";
  $("#defCc").value = (me && me.ccLang) || "en";
  $("#defAuto").checked = !!d.autoDownload;
  $("#defAutoRow").style.display = (me && me.downloadsDenied) ? "none" : ""; // can't auto-download if denied
  try {
    const folders = await api("/folders");
    const cur = d.folder || "";
    $("#defFolder").innerHTML = '<option value="">— Default folder —</option>' +
      folders.map((f) => `<option value="${esc(f.name)}"${f.name === cur ? " selected" : ""}>${esc(f.name)}</option>`).join("");
  } catch { /* keep the default option */ }
}
document.querySelector('.settings-nav button[data-pane="defaults"]')?.addEventListener("click", () => { loadDefaults(); initDownloadFolderUI(); });

// Offline download folder (native shells only) — shown in the Library pane.
async function initDownloadFolderUI() {
  const row = $("#dlFolderRow");
  if (!row) return;
  if (!(Offline.native() && Offline.bridge.getFolder && Offline.bridge.chooseFolder)) { row.style.display = "none"; return; }
  row.style.display = "";
  try { $("#dlFolderPath").value = (await Offline.bridge.getFolder()) || ""; } catch { /* ignore */ }
}
$("#dlFolderPick")?.addEventListener("click", async () => {
  try {
    const f = await Offline.bridge.chooseFolder();
    if (f) { $("#dlFolderPath").value = f; toast("Download folder set"); }
  } catch (e) { toast(e.message || "Couldn't set folder"); }
});
$("#defSave")?.addEventListener("click", async () => {
  try {
    const u = await api("/account/add-defaults", {
      method: "POST",
      body: JSON.stringify({
        track: $("#defTrack").value,
        autoDownload: $("#defAuto").checked,
        folder: $("#defFolder").value,
        autoStatus: $("#defAutoStatus").value === "on",
        ccLang: $("#defCc").value,
      }),
    });
    if (me) { me.addDefaults = u.addDefaults; me.autoStatus = u.autoStatus; me.ccLang = u.ccLang; }
    toast("Library defaults saved");
  } catch (e) { toast(e.message); }
});

const rank = { owner: 0, manager: 1, user: 2 };
async function loadUsers() {
  try {
    const users = await api("/users");
    $("#usersCount").textContent = `${users.length} ${users.length === 1 ? "account" : "accounts"}`;
    const list = $("#usersList");
    list.innerHTML = "";
    const iAmOwner = me.role === "owner";
    users.sort((a, b) => (rank[a.role] - rank[b.role]) || a.username.localeCompare(b.username));
    users.forEach((u) => {
      const isMe = u.id === me.id;
      const card = el("div", "user-card");
      const chip = (on, label) => `<span class="mini-chip${on ? " on" : ""}">${label}</span>`;
      const badgeCls = u.role === "owner" ? " owner" : u.role === "manager" ? " manager" : "";
      card.innerHTML = `
        <div class="avatar">${esc(initial(u.username))}</div>
        <div class="u-main">
          <div class="u-name">${esc(u.username)}
            <span class="role-badge${badgeCls}">${roleLabel(u.role)}</span>
            ${isMe ? '<span class="you-tag">You</span>' : ""}
          </div>
          <div class="u-chips">
            ${u.email ? `<span class="mini-chip">${esc(u.email)}</span>` : ""}
            ${chip(u.realDebridConnected, "RD")}
            ${chip(u.anilistConnected, "AniList")}
            ${chip(u.malConnected, "MAL")}
            ${u.downloadsDenied ? '<span class="mini-chip off">Downloads off</span>' : ""}
          </div>
        </div>`;
      // Staff can deny/allow downloads (owner: anyone but self/owner; manager: only users).
      const canManage = !isMe && u.role !== "owner" && (iAmOwner || u.role === "user");
      if (canManage) {
        const dl = el("button", "ghost sm-btn", u.downloadsDenied ? "Allow DL" : "Deny DL");
        dl.title = u.downloadsDenied ? "Allow this user to download" : "Block this user from downloading (streaming stays on)";
        dl.addEventListener("click", async () => {
          try {
            await api(`/users/${u.id}/downloads`, { method: "POST", body: JSON.stringify({ denied: !u.downloadsDenied }) });
            toast(u.downloadsDenied ? `${u.username} can download` : `${u.username} blocked from downloads`);
            loadUsers();
          } catch (e) { toast(e.message); }
        });
        card.append(dl);
      }
      // Owner can change roles (except the owner's own).
      if (iAmOwner && !isMe && u.role !== "owner") {
        const sel = el("select", "user-role-sel");
        sel.innerHTML = `<option value="user"${u.role === "user" ? " selected" : ""}>User</option><option value="manager"${u.role === "manager" ? " selected" : ""}>Manager</option>`;
        sel.addEventListener("change", async () => {
          try { await api(`/users/${u.id}/role`, { method: "POST", body: JSON.stringify({ role: sel.value }) }); toast(`${u.username} → ${sel.value}`); loadUsers(); }
          catch (e) { toast(e.message); loadUsers(); }
        });
        card.append(sel);
      }
      // Remove (owner: anyone but self/owner; manager: only users).
      const canRemove = !isMe && u.role !== "owner" && (iAmOwner || u.role === "user");
      if (canRemove) {
        const del = el("button", "icon-danger", "✕");
        del.title = `Remove ${u.username}`;
        del.addEventListener("click", async () => {
          if (!confirm(`Remove user "${u.username}"? Their library and lists are deleted.`)) return;
          try { await api(`/users/${u.id}`, { method: "DELETE" }); loadUsers(); toast("User removed"); }
          catch (e) { toast(e.message); }
        });
        card.append(del);
      }
      list.append(card);
    });
  } catch { /* non-staff never see this */ }
}

// --- Invites ---
$("#inviteBtn").addEventListener("click", async () => {
  const email = $("#inviteEmail").value.trim();
  const role = $("#inviteRole").value;
  try {
    const r = await api("/invites", { method: "POST", body: JSON.stringify({ email, role }) });
    $("#inviteLink").value = r.url;
    $("#inviteResult").classList.remove("hidden");
    $("#inviteEmail").value = "";
    toast(r.emailed ? `Invite emailed to ${email}` : "Invite link created — copy it below");
  } catch (e) { toast(e.message); }
});
$("#inviteCopy").addEventListener("click", () => {
  const inp = $("#inviteLink"); inp.select();
  navigator.clipboard?.writeText(inp.value).then(() => toast("Link copied")).catch(() => { document.execCommand("copy"); toast("Link copied"); });
});

// --- SMTP settings (owner) ---
async function loadSmtp() {
  try {
    const s = await api("/smtp");
    if (!s) { ["smtpHost","smtpUser","smtpFrom"].forEach((id)=>$("#"+id).value=""); $("#smtpPort").value="587"; $("#smtpSecure").checked=false; return; }
    $("#smtpHost").value = s.host || ""; $("#smtpPort").value = s.port || 587;
    $("#smtpUser").value = s.user || ""; $("#smtpFrom").value = s.from || "";
    $("#smtpSecure").checked = !!s.secure;
    $("#smtpPass").placeholder = s.hasPassword ? "•••••• (saved — blank keeps it)" : "password";
  } catch { /* not owner */ }
}
$("#smtpSave").addEventListener("click", async () => {
  const body = { host: $("#smtpHost").value.trim(), port: $("#smtpPort").value, user: $("#smtpUser").value.trim(),
    pass: $("#smtpPass").value, from: $("#smtpFrom").value.trim(), secure: $("#smtpSecure").checked };
  try { const r = await api("/smtp", { method: "POST", body: JSON.stringify(body) }); $("#smtpPass").value = "";
    toast(r.cleared ? "Email disabled" : "SMTP saved"); loadSmtp(); } catch (e) { toast(e.message); }
});
$("#smtpTestBtn").addEventListener("click", async () => {
  const to = $("#smtpTest").value.trim();
  if (!to) return toast("Enter a recipient");
  try { await api("/smtp/test", { method: "POST", body: JSON.stringify({ to }) }); toast(`Test email sent to ${to}`); }
  catch (e) { toast("Test failed: " + e.message); }
});

$("#addUserBtn").addEventListener("click", async () => {
  const username = $("#newUserName").value.trim();
  const password = $("#newUserPass").value;
  try {
    await api("/users", { method: "POST", body: JSON.stringify({ username, password }) });
    $("#newUserName").value = ""; $("#newUserPass").value = "";
    toast("User added");
    loadUsers();
  } catch (e) { toast(e.message); }
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
boot();
