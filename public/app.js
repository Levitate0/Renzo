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
  c.innerHTML = `
    <span class="pill">${item.type === "movie" ? "Movie" : "Series"}</span>
    ${item.downloaded ? '<span class="dot" title="downloaded episodes"></span>' : ""}
    <img class="poster" loading="lazy" src="${esc(item.poster || "")}" alt="" onerror="this.style.opacity=.15" />
    <div class="cap">
      <div class="t">${esc(item.title)}</div>
      <div class="m">${[item.year, (item.genres || [])[0]].filter(Boolean).map(esc).join(" · ")}</div>
    </div>`;
  c.addEventListener("click", () => openDetail(item.id));
  return c;
}
function renderGrid(target, items) {
  target.innerHTML = "";
  if (!items.length) { target.append(el("div", "empty", "Nothing here yet.")); return; }
  items.forEach((it) => target.append(makeCard(it)));
}

async function loadTrending() {
  $("#discoverHeading").textContent = "Trending";
  try { renderGrid($("#discoverGrid"), await api("/discover/trending")); }
  catch (e) { toast("Discover failed: " + e.message); }
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
  if (!q) return loadTrending();
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
    $("#detailTags").innerHTML = [d.type === "movie" ? "Movie" : "Series", d.year, ...(d.genres || []).slice(0, 4)]
      .filter(Boolean).map((g) => `<span>${esc(g)}</span>`).join("");
    $("#detailDesc").textContent = d.description || "";
    const isSeries = d.type === "series";
    $("#seasonBtn").classList.toggle("hidden", !isSeries);
    $("#autoBtn").classList.toggle("hidden", !isSeries);
    setAutoBtn(!!d.autoDownload);
    setListBtns(d.lists || []);
    populateFolderSelect(d.folders || [], d.folder);
    renderEpisodes(d);
    openModal("#detail");
  } catch (e) { toast("Detail failed: " + e.message); }
}

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
  $("#watchlistBtn").textContent = inW ? "★ Watchlisted" : "☆ Watchlist";
  $("#watchlistBtn").classList.toggle("on", inW);
  $("#favBtn").textContent = inF ? "♥ Favorited" : "♡ Favorite";
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
  const grid = el("div", "ep-grid");
  d.episodeList.forEach((ep) => {
    const cell = el("div", `ep ${ep.status}${ep.aired === false ? " unaired" : ""}`);
    const label = ep.hasFile ? "local" : ep.aired === false ? "soon" : ep.status;
    cell.innerHTML = `<span class="n">${ep.number}</span><span class="s">${label}</span>` +
      (ep.progress > 0 && ep.progress < 1 ? `<span class="bar" style="width:${Math.round(ep.progress * 100)}%"></span>` : "");
    cell.title = ep.aired === false ? `Episode ${ep.number} — not aired yet` : `Episode ${ep.number} — click to stream`;
    if (ep.aired === false) {
      cell.addEventListener("click", () => toast(`Episode ${ep.number} hasn't aired yet`));
    } else {
      cell.addEventListener("click", () => play(d.id, ep.number, `${d.english || d.romaji} · E${ep.number}`));
    }
    grid.append(cell);
  });
  area.append(grid);
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
// player  (Crunchyroll-style: instant RD stream, optional bg download)
// ---------------------------------------------------------------------------
let playing = null; // { id, ep }
async function play(id, ep, label) {
  playing = { id, ep };
  const video = $("#video");
  $("#playerTitle").textContent = label;
  $("#playerSource").textContent = "resolving…";
  $("#playerSource").className = "source-badge";
  $("#playerNote").textContent = "";
  video.pause(); video.removeAttribute("src"); clearTracks(video);
  openModal("#player");

  try {
    const r = await api(`/titles/${id}/play/${ep}`);
    $("#playerSource").textContent = r.source === "local" ? "● Local file" : "● Real-Debrid";
    $("#playerSource").className = "source-badge " + (r.source === "local" ? "local" : "rd");
    video.src = r.url;
    (r.subtitles || []).forEach((s, i) => {
      const track = el("track");
      track.kind = "subtitles";
      track.label = s.label || s.lang;
      track.srclang = s.lang || "en";
      track.src = `/api/captions/${s.id}.vtt`;
      if (i === 0) track.default = true;
      video.append(track);
    });
    video.load();
    video.play().catch(() => {});
    if (video.textTracks[0]) video.textTracks[0].mode = "showing";
    $("#playerDownload").textContent = r.source === "local" ? "✓ In library" : "⬇ Download to library";
    $("#playerDownload").disabled = r.source === "local";
    if (r.downloading) watchJob(r.downloading.id);
  } catch (e) {
    $("#playerSource").textContent = "failed";
    $("#playerNote").textContent = e.message;
  }
}
function clearTracks(video) { video.querySelectorAll("track").forEach((t) => t.remove()); }

$("#playerDownload").addEventListener("click", async () => {
  if (!playing) return;
  try {
    const job = await api(`/titles/${playing.id}/download/${playing.ep}`, { method: "POST" });
    $("#playerDownload").disabled = true;
    $("#playerNote").textContent = "Downloading in background — will switch to local when done.";
    watchJob(job.id);
    loadJobs();
  } catch (e) { toast(e.message); }
});

// auto-scrobble on finish
$("#video").addEventListener("ended", async () => {
  if (!playing) return;
  try { await api(`/titles/${playing.id}/watched/${playing.ep}`, { method: "POST" });
    toast("Marked watched"); } catch { /* trackers optional */ }
});

function watchJob(jobId) {
  const iv = setInterval(async () => {
    try {
      const jobs = await api("/jobs");
      const j = jobs.find((x) => x.id === jobId);
      if (!j) return clearInterval(iv);
      if (j.status === "downloaded") {
        clearInterval(iv);
        if (playing) $("#playerNote").textContent = "Saved to library ✓ (reopen to play the local copy)";
        toast("Download complete");
        loadJobs();
      } else if (j.status === "failed") {
        clearInterval(iv);
        $("#playerNote").textContent = "Download failed: " + (j.message || "");
      }
    } catch { clearInterval(iv); }
  }, 3000);
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
  if (node.id === "player") { const v = $("#video"); v.pause(); v.removeAttribute("src"); v.load(); playing = null; }
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

function startApp(user) {
  me = user;
  const isAdmin = user.role === "admin";
  $("#usersBlock").style.display = isAdmin ? "" : "none";
  $("#usersNavBtn").style.display = isAdmin ? "" : "none";
  // Account menu header + avatar
  $("#acctBtn").textContent = initial(user.username);
  $("#acctMenuName").textContent = user.username;
  $("#acctMenuRole").textContent = isAdmin ? "Owner" : "User";
  loadStatus();
  loadTrending();
  loadJobs();
  if (!jobsTimer) jobsTimer = setInterval(loadJobs, 4000);
  if (!user.realDebridConnected) {
    toast("Connect Real-Debrid in Settings to start streaming");
    openSettings("realdebrid");
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
    $("#acctAvatar").textContent = initial(u.username);
    $("#acctName").textContent = u.username || "—";
    const roleEl = $("#acctRole");
    roleEl.textContent = u.role === "admin" ? "Owner" : "User";
    roleEl.className = "role-badge" + (u.role === "admin" ? " owner" : "");
    applyHealth(h);
    if (u.role === "admin") loadUsers();
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

async function loadUsers() {
  try {
    const users = await api("/users");
    $("#usersCount").textContent = `${users.length} ${users.length === 1 ? "account" : "accounts"}`;
    const list = $("#usersList");
    list.innerHTML = "";
    // owner first, then alphabetical
    users.sort((a, b) => (a.role === b.role ? a.username.localeCompare(b.username) : a.role === "admin" ? -1 : 1));
    users.forEach((u) => {
      const isMe = u.id === me.id;
      const card = el("div", "user-card");
      const chip = (on, label) => `<span class="mini-chip${on ? " on" : ""}">${label}</span>`;
      card.innerHTML = `
        <div class="avatar">${esc(initial(u.username))}</div>
        <div class="u-main">
          <div class="u-name">${esc(u.username)}
            <span class="role-badge${u.role === "admin" ? " owner" : ""}">${u.role === "admin" ? "Owner" : "User"}</span>
            ${isMe ? '<span class="you-tag">You</span>' : ""}
          </div>
          <div class="u-chips">
            ${chip(u.realDebridConnected, "RD")}
            ${chip(u.anilistConnected, "AniList")}
            ${chip(u.malConnected, "MAL")}
          </div>
        </div>`;
      if (!isMe && u.role !== "admin") {
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
  } catch { /* non-admins never see this */ }
}

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
