// ---------------------------------------------------------------------------
// Renzo TV / console navigation — D-pad + game-controller spatial focus.
//
// Activates ONLY on a TV/console (Android TV, Fire TV, Xbox, smart-TV browsers)
// or when a gamepad connects, so desktop mouse/keyboard behaviour is untouched.
// Once active it: makes the div-based cards focusable, moves focus with the
// arrow keys / D-pad by on-screen geometry, activates with Enter / A, and goes
// back with B. Self-contained — talks to the app only through the DOM.
// ---------------------------------------------------------------------------
(function () {
  "use strict";

  // Div-clickables that aren't natively focusable — give them a tabindex.
  const DIV_NAV = ".card,.ep-card,.season-card,.more-tile,.wep";
  // Everything the nav can land on within the visible surface.
  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"]),' +
    DIV_NAV;

  let tvMode = false;

  function enableTvMode() {
    if (tvMode) return;
    tvMode = true;
    document.body.classList.add("tv-nav");
    // Also on <html>: the document scrollbar belongs to the root element, so a
    // `body.tv-nav ...` rule can never hide it.
    document.documentElement.classList.add("tv-nav");
    sweep();
    if (!current()) { const f = focusables(); if (f.length) f[0].focus(); }
  }

  // Make the div-clickables focusable. Idempotent; re-run after re-renders.
  function sweep(root) {
    (root || document).querySelectorAll(DIV_NAV).forEach((el) => {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    });
  }
  // Grids/lists rebuild via innerHTML, so re-sweep on DOM changes.
  const mo = new MutationObserver(() => { if (tvMode) sweep(); });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

  // Where navigation may land. A BLOCKING overlay (lightbox / auth gate / modal /
  // offline gate / the player) owns the screen, so scope to it alone. Otherwise the
  // roots are the app chrome PLUS the current page: scoping to the page alone left
  // the topbar and tab bar unreachable — you could move around inside a tab but
  // never get back out to switch tabs or search — and any empty or still-loading
  // tab was a total dead end with nowhere for focus to go. Content behind #detail
  // is `display:none` (body.detailing main), so visible() filters it out for us.
  function roots() {
    const vis = (id) => { const n = document.getElementById(id); return n && !n.classList.contains("hidden") ? n : null; };
    const blocking = vis("imgLightbox")
      || document.querySelector(".auth-gate:not(.hidden)")   // login / first-run setup / password reset
      || document.querySelector(".modal:not(.hidden)")
      || vis("offlineGate")
      || (document.body.classList.contains("watching") ? vis("view-watch") : null);
    if (blocking) return [blocking];
    const page = vis("detail") || document.querySelector(".view.active");
    const chrome = [document.querySelector(".topbar"), document.querySelector(".tabs")].filter(Boolean);
    const list = page ? chrome.concat([page]) : chrome;
    return list.length ? list : [document.body];
  }

  function visible(el) {
    if (el.closest("[hidden]")) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  }
  function focusables() {
    const out = [], seen = new Set();
    for (const r of roots()) {
      for (const el of r.querySelectorAll(FOCUSABLE)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el); out.push(el);
      }
    }
    return out;
  }
  function current() {
    const a = document.activeElement;
    return a && a !== document.body && visible(a) ? a : null;
  }

  // Move focus to the best candidate in a direction, by screen geometry.
  function move(dir) {
    const items = focusables();
    if (!items.length) return false;
    const cur = current();
    if (!cur || items.indexOf(cur) < 0) { items[0].focus(); center(items[0]); return true; }
    const cr = cur.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const horiz = dir === "left" || dir === "right";
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const dx = x - cx, dy = y - cy;
      if (dir === "left" && dx > -4) continue;
      if (dir === "right" && dx < 4) continue;
      if (dir === "up" && dy > -4) continue;
      if (dir === "down" && dy < 4) continue;
      const primary = horiz ? Math.abs(dx) : Math.abs(dy);
      const cross = horiz ? Math.abs(dy) : Math.abs(dx);
      const score = primary + cross * 2.5; // prefer the same row/column
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus(); center(best); return true; }
    return false;
  }
  function center(el) { try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {} }

  function activate() {
    const cur = current();
    if (!cur) return;
    const tag = cur.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return; // focus is enough
    // ep-cards wire the click on a child; click the primary play target.
    if (cur.classList.contains("ep-card")) {
      (cur.querySelector(".ep-thumb-wrap") || cur.querySelector(".ep-title") || cur).click();
    } else {
      cur.click();
    }
  }

  // Returns true if this press was consumed (i.e. we navigated somewhere back),
  // false when we're already at the root — the native handler then exits the app,
  // which is what makes Back breadcrumb correctly on TV instead of quitting from
  // mid-playback.
  function back() {
    if (document.body.classList.contains("watching")) { document.getElementById("watchBack")?.click(); return true; }
    const gate = document.getElementById("offlineGate");
    if (gate && !gate.classList.contains("hidden")) { document.getElementById("offlineClose")?.click(); return true; }
    const openModal = document.querySelector(".modal:not(.hidden)");
    const onDetail = document.body.classList.contains("detailing");
    if (openModal || onDetail) {
      // The app's Escape cascade closes lightbox → modal → detail.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    }
    return false; // at the root: let Android leave the app
  }

  // Play/pause from the remote's centre button or a media key, but only while the
  // player is up — elsewhere centre must still activate the focused item.
  function playPause() {
    const v = document.getElementById("watchVideo");
    if (!document.body.classList.contains("watching") || !v) return false;
    if (v.paused) v.play().catch(() => {}); else v.pause();
    return true;
  }

  // --- Keyboard (arrows / Enter) — capture phase so we can preempt the player's
  //     left/right seek when we're not on the video itself ---------------------
  const DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && !t.readOnly;
    const inSelect = t && t.tagName === "SELECT";
    if (e.key in DIRS) {
      if (typing) return;                                   // caret movement
      if (inSelect && (e.key === "ArrowUp" || e.key === "ArrowDown")) return; // change option
      if (!tvMode) return;                                  // desktop: let arrows scroll
      // In the player, keep left/right as seek when the video is focused.
      if (document.body.classList.contains("watching")
          && document.activeElement === document.getElementById("watchVideo")
          && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      // Only swallow the key if we actually moved — otherwise let the WebView's
      // native focus traversal handle it, so a screen we don't model is never a
      // dead end.
      if (move(DIRS[e.key])) { e.preventDefault(); e.stopPropagation(); }
    } else if (e.key === "MediaPlayPause" || e.key === "MediaPlay" || e.key === "MediaPause") {
      if (playPause()) e.preventDefault();
    } else if (e.key === "Enter") {
      if (!tvMode || typing || inSelect) return;
      // In the player the centre button is play/pause, not "click again".
      if (document.body.classList.contains("watching")
          && document.activeElement === document.getElementById("watchVideo")) {
        e.preventDefault(); playPause(); return;
      }
      if (current() && current().tagName === "BUTTON") return; // native Enter clicks buttons
      e.preventDefault();
      activate();
    }
  }, true);

  // --- Gamepad (Xbox / generic) — poll and synthesise nav -------------------
  let padLoop = 0;
  const held = {};                       // edge-detect + repeat timing per control
  const REPEAT_MS = 160, DELAY_MS = 420;
  function edge(name, down, onDown) {
    const now = performance.now();
    const s = held[name] || (held[name] = { down: false, next: 0 });
    if (down) {
      if (!s.down) { s.down = true; s.next = now + DELAY_MS; onDown(); }
      else if (now >= s.next) { s.next = now + REPEAT_MS; onDown(); }
    } else { s.down = false; }
  }
  const DEAD = 0.6;
  // Chromium exposes a gamepad only on its FIRST INPUT — so any "resting"
  // calibration taken at first sight is really taken MID-PRESS, and the release
  // then reads as the opposite direction held forever (that was the login-screen
  // focus ping-pong on TV). No calibration: fixed threshold, and each pad's
  // AXES are ignored for a short grace period after it appears (buttons are
  // edge-detected and safe immediately).
  const padSeen = Object.create(null); // pad index -> first-seen timestamp
  const AXIS_GRACE_MS = 800;
  function pollPads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();
    for (const p of pads) {
      if (!p) continue;
      const b = p.buttons || [], ax = p.axes || [];
      if (!padSeen[p.index]) padSeen[p.index] = now;
      const axesLive = now - padSeen[p.index] > AXIS_GRACE_MS;
      const x0 = axesLive && typeof ax[0] === "number" ? ax[0] : 0;
      const y0 = axesLive && typeof ax[1] === "number" ? ax[1] : 0;
      const up = (b[12] && b[12].pressed) || y0 < -DEAD;
      const down = (b[13] && b[13].pressed) || y0 > DEAD;
      const left = (b[14] && b[14].pressed) || x0 < -DEAD;
      const right = (b[15] && b[15].pressed) || x0 > DEAD;
      edge("up", up, () => move("up"));
      edge("down", down, () => move("down"));
      edge("left", left, () => move("left"));
      edge("right", right, () => move("right"));
      edge("a", b[0] && b[0].pressed, () => activate());   // A / cross
      edge("b", b[1] && b[1].pressed, () => back());        // B / circle
    }
    padLoop = requestAnimationFrame(pollPads);
  }
  window.addEventListener("gamepadconnected", () => {
    enableTvMode();
    // Android TV: NEVER poll gamepads. The remote (and any paired controller)
    // already delivers real DPAD key events there, but it ALSO enumerates as a
    // gamepad whose buttons mirror those keys — polling it double-fires every
    // press and, worse, its first-input axis snapshot poisons direction
    // detection (the reported focus bouncing). Key events are the only input
    // path on TV; gamepad polling stays for consoles (Xbox/PS browsers).
    if (window.__RENZO_TV) return;
    if (!padLoop) padLoop = requestAnimationFrame(pollPads);
  });

  // Auto-enable on TVs / consoles. The UA test alone is NOT enough: an Android
  // WebView reports the device model, not "Android TV", so most Google TV /
  // operator boxes never matched and the remote could not focus anything. The
  // native shell therefore sets window.__RENZO_TV (and calls RenzoTV.enable())
  // off PackageManager.FEATURE_LEANBACK, which is authoritative.
  // "AndroidTV" (no space) is OUR native shell's marker — MainActivity appends
  // "AndroidTV Renzo" to the UA. It MUST be in this pattern: the __RENZO_TV
  // global dies with any page reload, and the native poke loop only runs for
  // ~20s after activity creation — so when Android kills the WebView renderer
  // in the background and the page reloads on re-entry, this UA test is the
  // only thing left that can turn TV mode back on (reported: D-pad dead after
  // exiting and re-entering the app).
  if (window.__RENZO_TV
      || /Android TV|AndroidTV|AFT[A-Z]|BRAVIA|GoogleTV|Google TV|Web0S|WebOS|Tizen|SMART-TV|SmartTV|HbbTV|CrKey|Xbox|PlayStation|Nintendo/i
      .test(navigator.userAgent)) {
    // Defer so the app has rendered its first view. Gamepad polling deliberately
    // does NOT start here — only on a real gamepadconnected event (see above).
    // Guard against the load event having already fired (late script injection
    // or a bfcache-style restore) — the listener alone would never run.
    const arm = () => setTimeout(enableTvMode, 400);
    if (document.readyState === "complete") arm();
    else window.addEventListener("load", arm);
  }

  // Expose a manual toggle for testing / a future settings switch.
  window.RenzoTV = { enable: enableTvMode, isOn: () => tvMode, back, playPause };
})();
