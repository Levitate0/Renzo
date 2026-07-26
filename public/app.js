"use strict";

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
      openSettings("realdebrid");
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
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "library") loadLibrary();
  if (name === "downloads") loadJobs();
  if (name === "updates") loadUpdates();
  if (name === "appearance") renderAppearance();
}

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
      updKind: u.kind, ep: u.ep, upcoming: u.upcoming,
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
    const rdMap = { premium: "RD ✓", "not-premium": "RD ⚠ (free)", "not-connected": "RD ✗", invalid: "RD ✗" };
    const rd = rdMap[s.realdebrid] || "RD ✗";
    const jf = s.jellyfin === true ? "Jellyfin ✓" : s.jellyfin === "not-configured" ? "" : "Jellyfin ✗";
    const tr = [s.trackers.anilist && "AniList", s.trackers.mal && "MAL"].filter(Boolean).join("+");
    $("#status").textContent = [rd, jf, tr && `⇄ ${tr}`].filter(Boolean).join("  ·  ");
  } catch {
    $("#status").textContent = "offline";
  }
}

// ---------------------------------------------------------------------------
// cards + grids
// ---------------------------------------------------------------------------
function makeCard(item) {
  const c = el("div", "card");
  const ribbon = item.updKind === "episode" ? `<span class="upd-ribbon">New · E${item.ep}</span>`
    : item.updKind === "season" ? `<span class="upd-ribbon season">${item.upcoming ? "Soon" : "New season"}</span>`
    : item.updKind === "movie" ? `<span class="upd-ribbon">Available</span>` : "";
  const upnext = item.upNext ? `<div class="upnext">▶ Up next · E${item.upNext}</div>` : "";
  c.innerHTML = `
    ${ribbon || `<span class="pill">${item.type === "movie" ? "Movie" : "Series"}</span>`}
    ${item.downloaded ? '<span class="dot" title="downloaded episodes"></span>' : ""}
    <img class="poster" loading="lazy" src="${esc(item.poster || "")}" alt="" onerror="this.style.opacity=.15" />
    <div class="cap">
      <div class="t">${esc(item.title)}</div>
      <div class="m">${[item.year, (item.genres || [])[0]].filter(Boolean).map(esc).join(" · ")}</div>
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
function renderGrid(target, items) {
  target.innerHTML = "";
  if (!items.length) { target.append(el("div", "empty", "Nothing here yet.")); return; }
  items.forEach((it) => target.append(makeCard(it)));
}

async function loadBrowse() {
  $("#searchWrap").classList.add("hidden");
  $("#browseWrap").classList.remove("hidden");
  const rows = [
    ["#trendingGrid", "/discover/trending"],
    ["#recommendedGrid", "/discover/recommended"],
    ["#newSeasonGrid", "/discover/new-season"],
  ];
  await Promise.all(rows.map(async ([sel, url]) => {
    try { renderGrid($(sel), await api(url)); } catch { renderGrid($(sel), []); }
  }));
}

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
async function openDetail(id) {
  try {
    const d = await api(`/titles/${id}`);
    current = d;
    $("#detailBanner").style.backgroundImage = `url(${d.banner || d.poster || ""})`;
    $("#detailPoster").src = d.poster || "";
    $("#detailTitle").textContent = d.english || d.romaji;
    const meta = [
      `<span class="type-tag">${d.type === "movie" ? "Movie" : "Series"}</span>`,
      d.year, `${d.episodesTotal || 1} ep`, ...(d.genres || []).slice(0, 3),
    ].filter(Boolean);
    $("#detailMetaline").innerHTML = meta.map((m, i) =>
      `${i ? '<span class="sep">•</span>' : ""}<span>${typeof m === "string" && m.startsWith("<") ? m : esc(m)}</span>`).join("");
    $("#detailDesc").textContent = d.description || "";
    const isSeries = d.type === "series";
    // Hero Play -> first not-downloaded aired episode (or E1 / movie).
    const firstEp = (d.episodeList || []).find((e) => e.aired !== false && !e.hasFile)
      || (d.episodeList || []).find((e) => e.aired !== false) || { number: 1 };
    $("#heroPlay").textContent = isSeries ? `▶ Play E${firstEp.number}` : "▶ Play";
    $("#heroPlay").onclick = () => play(d.id, isSeries ? firstEp.number : 1, `${d.english || d.romaji}${isSeries ? ` · E${firstEp.number}` : ""}`);
    $("#seasonBtn").classList.toggle("hidden", !isSeries);
    $("#autoBtn").classList.toggle("hidden", !isSeries);
    setAutoBtn(!!d.autoDownload);
    setListBtns(d.lists || []);
    populateFolderSelect(d.folders || [], d.folder);
    renderSeasons(d);
    renderEpisodes(d);
    loadProviders(d);          // async — populates the release-group picker
    openModal("#detail");
  } catch (e) { toast("Detail failed: " + e.message); }
}

// Seasons: current entry + related prequel/sequel entries, ordered by year.
function renderSeasons(d) {
  const row = $("#seasonsRow");
  row.innerHTML = "";
  const seasons = [
    { id: d.id, title: d.english || d.romaji, year: d.year, poster: d.poster, current: true },
    ...(d.seasons || []).map((s) => ({ id: s.id, title: s.title, year: s.year, poster: s.poster })),
  ];
  if (seasons.length < 2) { row.classList.add("hidden"); return; }
  seasons.sort((a, b) => (a.year || 0) - (b.year || 0));
  row.classList.remove("hidden");
  seasons.forEach((s, i) => {
    const card = el("div", "season-card" + (s.current ? " current" : ""));
    card.innerHTML = `<img loading="lazy" src="${esc(s.poster || "")}" alt="" onerror="this.style.opacity=.15" />
      <div class="lbl">S${i + 1}${s.year ? ` · ${s.year}` : ""}${s.current ? " (this)" : ""}</div>`;
    if (!s.current) card.addEventListener("click", () => openDetail(s.id));
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
  names.forEach((n) => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n; if (n === current) o.selected = true;
    sel.append(o);
  });
  const nw = document.createElement("option");
  nw.value = "__new__"; nw.textContent = "+ New folder…";
  sel.append(nw);
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

function renderEpisodes(d) {
  const area = $("#episodeArea");
  area.innerHTML = "";
  if (d.type === "movie") {
    const b = el("button", "primary movie-play", "▶ Stream");
    b.addEventListener("click", () => play(d.id, 1, d.english || d.romaji));
    area.append(b);
    return;
  }
  const aired = d.episodeList.filter((e) => e.aired !== false).length;
  const header = el("div", "season-header");
  header.innerHTML = `Season 1 <span class="cnt">${aired} of ${d.episodeList.length} available</span>`;
  area.append(header);

  const list = el("div", "ep-list");
  const fallback = d.banner || d.poster || "";
  d.episodeList.forEach((ep) => {
    const unaired = ep.aired === false;
    const row = el("div", `ep-row${unaired ? " unaired" : ""}`);
    const busy = ["downloading", "queued", "searching"].includes(ep.status);
    const pct = Math.round((ep.progress || 0) * 100);
    let status = "";
    if (ep.hasFile) status = `<span class="ep-st local">✓ Saved</span>`;
    else if (busy) status = `<span class="ep-st busy">${ep.status}${pct ? " " + pct + "%" : ""}</span>`;
    else if (unaired) status = `<span class="ep-st">Soon</span>`;
    row.innerHTML = `
      <div class="ep-thumb-wrap">
        <img class="ep-thumb" loading="lazy" src="${esc(ep.thumbnail || fallback)}" alt="" onerror="this.src='${esc(fallback)}'" />
        <span class="num-badge">${ep.number}</span>
        ${!unaired ? '<div class="play-ov">▶</div>' : ""}
        ${pct > 0 && pct < 100 ? `<div class="ep-prog" style="width:${pct}%"></div>` : ""}
      </div>
      <div class="ep-main">
        <div class="ep-no">S1 E${ep.number}${ep.epTitle ? ` · ${esc(ep.epTitle)}` : ""}</div>
        <div class="ep-t">${esc(ep.epTitle ? "" : `Episode ${ep.number}`)}</div>
      </div>
      ${status}`;
    row.title = unaired ? `Episode ${ep.number} — not aired yet` : `Play episode ${ep.number}`;
    if (unaired) row.addEventListener("click", () => toast(`Episode ${ep.number} hasn't aired yet`));
    else row.addEventListener("click", () => play(d.id, ep.number, `${d.english || d.romaji} · E${ep.number}`));
    list.append(row);
  });
  area.append(list);
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
function route() {
  if (!me) return;
  const w = parseWatchHash();
  if (w) enterWatch(w.watchId, w.ep);
  else if (watch) exitWatch();
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
  return [{ id: d.id, title: d.english || d.romaji, year: d.year, current: true },
    ...(d.seasons || []).map((s) => ({ id: s.id, title: s.title, year: s.year }))]
    .sort((a, b) => (a.year || 0) - (b.year || 0));
}
function seasonNumber(d) {
  const i = orderedSeasons(d).findIndex((s) => s.id === d.id);
  return i < 0 ? 1 : i + 1;
}

function renderWatchShell(d) {
  $("#watchTitle").textContent = d.english || d.romaji;
  const sel = $("#watchSeason");
  const seasons = orderedSeasons(d);
  if (seasons.length > 1) {
    sel.classList.remove("hidden");
    sel.innerHTML = "";
    seasons.forEach((s, i) => {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = `Season ${i + 1}${s.year ? ` · ${s.year}` : ""}`;
      if (s.id === d.id) o.selected = true;
      sel.append(o);
    });
  } else sel.classList.add("hidden");

  const list = $("#watchEpList");
  list.innerHTML = "";
  const fallback = d.banner || d.poster || "";
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

  $("#watchEpNo").textContent = isMovie ? "Movie" : `S${seasonNumber(d)} E${ep}${meta.epTitle ? ` · ${meta.epTitle}` : ""}`;
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
    const r = (watch.prefetch && watch.prefetch.ep === ep && await watch.prefetch.p)
      || await api(`/titles/${watch.titleId}/play/${ep}`);
    if (!watch || watch.gen !== gen) return; // a newer goToEp() superseded us — don't clobber it
    badge.textContent = r.source === "local" ? "● Local file" : "● Real-Debrid";
    badge.className = "source-badge " + (r.source === "local" ? "local" : "rd");
    video.src = r.url;
    (r.subtitles || []).forEach((s, i) => {
      const track = el("track");
      track.kind = "subtitles"; track.label = s.label || s.lang; track.srclang = s.lang || "en";
      track.src = `/api/captions/${s.id}.vtt`; if (i === 0) track.default = true;
      video.append(track);
    });
    video.load();
    video.play().catch(() => {});
    if (video.textTracks[0]) video.textTracks[0].mode = "showing";
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
  $("#view-watch").classList.remove("hidden");
  document.body.classList.add("watching");
}
function exitWatch() {
  const video = $("#watchVideo");
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
$("#watchBack").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = ""; });
$("#watchPrev").addEventListener("click", () => { if (watch) goToEp(watch.ep - 1); });
$("#watchNext").addEventListener("click", () => { if (watch) goToEp(watch.ep + 1); });
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
  try {
    await api(`/titles/${titleId}/watched/${endedEp}`, { method: "POST" });
    refreshUpdatesBadge();
  } catch { /* trackers optional */ }
  if (!watch || watch.titleId !== titleId || watch.ep !== endedEp) return; // exited or moved on
  const max = airedCount(detail);
  if (detail.type !== "movie" && endedEp < max) startAutoNext(endedEp + 1);
});

function stopPoller(iv) { clearInterval(iv); watchPollers.delete(iv); }
function watchJob(jobId) {
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
    const bits = s.enabled
      ? [`<span class="on-dot">●</span> Auto-downloader on — every ${s.intervalMin}m, ${s.trackedTitles} tracked`,
         s.lastRun ? `last run ${new Date(s.lastRun).toLocaleTimeString()} (queued ${s.lastQueued})` : "first run pending",
         s.lastError ? `⚠ ${esc(s.lastError)}` : ""]
      : ["○ Auto-downloader off — set AUTO_DOWNLOAD=true in .env"];
    $("#autodlText").innerHTML = bits.filter(Boolean).join(" · ");
    $("#autodlRun").disabled = s.running;
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

async function loadJobs() {
  loadAutodl();
  try {
    const jobs = await api("/jobs");
    const active = jobs.filter((j) => ["queued", "searching", "downloading"].includes(j.status));
    const badge = $("#dlBadge");
    badge.textContent = active.length;
    badge.classList.toggle("hidden", active.length === 0);

    const list = $("#jobsList");
    list.innerHTML = "";
    if (!jobs.length) { list.append(el("div", "empty", "No downloads.")); return; }
    jobs.forEach((j) => {
      const pct = Math.round((j.progress || 0) * 100);
      const node = el("div", `job ${j.status}`);
      node.innerHTML = `
        <div class="row"><span class="name">${esc(j.title)} · E${j.episode}</span>
          <span class="st">${esc(j.status)}${j.status === "downloading" ? " " + pct + "%" : ""}</span></div>
        <div class="row"><span class="st">${esc(j.message || "")}</span></div>
        <div class="track"><div class="fill" style="width:${j.status === "downloaded" ? 100 : pct}%"></div></div>`;
      if (j.status === "failed" && j.mine !== false) {
        const retry = el("button", "retry-btn", "↻ Retry");
        retry.style.marginTop = "8px";
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          try { await api(`/titles/${j.titleId}/retry/${j.episode}`, { method: "POST" }); toast("Retrying…"); loadJobs(); }
          catch (e) { toast(e.message); retry.disabled = false; }
        });
        node.append(retry);
      }
      list.append(node);
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// modal plumbing
// ---------------------------------------------------------------------------
function openModal(sel) { $(sel).classList.remove("hidden"); }
function closeModal(node) {
  node.classList.add("hidden");
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => closeModal(e.target.closest(".modal"))));
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); }));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".modal:not(.hidden)").forEach(closeModal);
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

  let info;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    info = res.ok ? await res.json() : { setupRequired: false };
    if (res.status === 401) info = { unauthorized: true };
  } catch { info = { unauthorized: true }; }

  if (info.setupRequired) return showSetup();
  if (info.unauthorized || !info.user) return showAuthGate("login");
  startApp(info.user);
}

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
    if (!data.user.realDebridConnected) openSettings("realdebrid");
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
    if (!data.user.realDebridConnected) openSettings("realdebrid");
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
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "failed");
    document.getElementById("authGate").classList.add("hidden");
    startApp(data.user);
  } catch (e) {
    $("#authError").textContent = e.message === "failed" ? "Invalid credentials" : e.message;
  }
}
$("#authSubmit").addEventListener("click", submitAuth);
$("#authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });

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
  loadBrowse();
  loadJobs();
  refreshUpdatesBadge();
  if (!jobsTimer) jobsTimer = setInterval(loadJobs, 4000);
  if (!parseWatchHash() && !user.realDebridConnected) {
    toast("Connect Real-Debrid in Settings to start streaming");
    openSettings("realdebrid");
  }
  route(); // honor a bookmarked #/watch/... URL
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
  btn.addEventListener("click", () => setPane(btn.dataset.pane));
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
  "not-connected": ["err", "Not connected"],
  invalid: ["err", "Invalid token"],
};

// Populate every connection pill + the tracker link buttons from a health payload.
function applyHealth(h) {
  if (!h) return;
  const [rs, rl] = RD_MAP[h.realdebrid] || ["err", "Not connected"];
  setPill($("#accRd"), rs, rl);
  setPill($("#rdState"), rs, rl);
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
  if (me) { me.realDebridConnected = h.realdebrid !== "not-connected"; }
}

async function openSettings(pane) {
  $("#acctMenu").classList.add("hidden");
  openModal("#settings");
  setPane(pane || "account");
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
    if (u.role === "owner" || u.role === "manager") loadUsers();
    if (u.role === "owner") loadSmtp();
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
          </div>
        </div>`;
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
