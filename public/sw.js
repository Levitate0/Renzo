// Renzo service worker.
//  • Caches the app shell so the SPA loads with no network.
//  • Serves offline-saved media (/files/*) and subtitles (/api/captions/*) from a
//    dedicated cache, with HTTP range support so <video> can seek.
// The page writes into the offline cache (Offline.save); the SW only reads it.
const SHELL = "renzo-shell-v1";
const OFFLINE = "renzo-offline-v1";
const CORE = [
  "/", "/app.js", "/styles.css", "/site.webmanifest",
  "/android-chrome-192x192.png", "/android-chrome-512x512.png", "/favicon.ico",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && k !== OFFLINE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Build a 206 partial from a full cached response so the video element can seek.
// Blob.slice() is lazy (disk-backed), so this doesn't load the whole file into RAM.
async function rangeResponse(cached, req) {
  const range = req.headers.get("range");
  if (!range) return cached;
  const blob = await cached.blob();
  const size = blob.size;
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? parseInt(m[1], 10) : 0;
  const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (Real-Debrid) passes through
  const p = url.pathname;

  // Offline-saved media + subtitles: cache-first (with range), else network.
  if (p.startsWith("/files/") || p.startsWith("/api/captions/")) {
    e.respondWith((async () => {
      const c = await caches.open(OFFLINE);
      const hit = await c.match(p, { ignoreSearch: true });
      if (hit) return p.startsWith("/files/") ? rangeResponse(hit, req) : hit;
      return fetch(req);
    })());
    return;
  }

  // Dynamic, per-user endpoints: always network (never cache).
  if (p.startsWith("/api/") || p.startsWith("/jellyfin/") || p === "/version") return;

  // Navigations: network-first (fresh UI); fall back to the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/", { ignoreSearch: true })));
    return;
  }

  // Shell assets (app.js/styles.css/icons, with or without ?v=): stale-while-revalidate.
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const hit = await c.match(p, { ignoreSearch: true });
    const net = fetch(req).then((r) => { if (r.ok) c.put(p, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  })());
});
