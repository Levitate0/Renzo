<p align="center">
  <img src="./renzo-banner.png" alt="Renzo" width="420" />
</p>

<h1 align="center">Renzo</h1>

<p align="center"><b>Private, per-user anime streaming &amp; downloads via Real-Debrid.</b></p>

A **single-service, anime-native movie & series manager**. It behaves like Crunchyroll +
Stremio, but it actually **downloads and pulls covers**:

1. **Discover** anime (movies + series) with real cover art & metadata from **AniList**.
2. **Click → stream instantly** via **Real-Debrid** (auto torrent search over AnimeTosho/Nyaa,
   ranked by resolution + seeders, resolved through RD — no zurg, no rclone, no mounts).
3. **Optionally download in the background.** When the local copy finishes, the player
   **switches to the local file** automatically.
4. **Auto subtitles** — fetches captions (Jimaku) and serves them to the built-in player,
   and saves `.vtt` sidecars next to the video for Jellyfin.
5. **Two front-ends:** a built-in web player **and** a Jellyfin-friendly library
   (Jellyfin rescans on new downloads).
6. **AniList / MAL connections** — import your watchlist and scrobble progress as you watch.
7. **Season grab** — one button queues every missing aired episode; a season pack is
   prepared on Real-Debrid once and shared across the episode jobs.
8. **Auto-downloader** — on a schedule, checks titles you've flagged "Auto" (your AniList
   *Watching* list auto-flags on import) and queues newly-aired episodes.
9. **Watchlist, favorites & custom lists** — flag titles from the detail view, filter the
   library by list; AniList *Planning* entries import onto the watchlist automatically.
10. **Folders / organization** — create named folders and sort your library into them; each
    folder is a real per-user directory (`u/<userId>/<folder>/{movies|series}/…`), and moving a
    title relocates its files on disk. Filter the library by folder.

No Sonarr/Radarr (they aren't anime-native), no Seanime, no zurg. Just one Node service.

---

## Why one service

Everything the pipeline needs lives in `src/services`:

| Concern            | File                          | What it does |
|--------------------|-------------------------------|--------------|
| Metadata + covers  | `services/anilist.ts`         | AniList GraphQL: trending, search, per-title detail, cover/banner art |
| Torrent search     | `services/torrents.ts`        | AnimeTosho JSON (aggregates Nyaa); anime-aware episode/batch/resolution parsing + ranking |
| Debrid             | `services/realdebrid.ts`      | add magnet → select video files → poll → unrestrict → direct stream/download URL |
| Subtitles          | `services/captions.ts`        | Jimaku lookup by AniList id; SRT/ASS → WebVTT |
| Library            | `services/library.ts`         | Jellyfin-standard folders, streamed downloads, artwork |
| Jellyfin           | `services/jellyfin.ts`        | triggers a library rescan |
| Trackers           | `services/tracker.ts`         | AniList + MAL import & scrobble |
| Orchestrator       | `services/downloader.ts`      | resolve-stream-now, background download queue, local handoff, auto-captions |

The web UI (`public/`) is plain HTML/CSS/JS — no build step.

---

## Run it

```bash
git clone https://github.com/Levitate0/renzo.git
cd renzo
cp .env.example .env        # then edit (see Config below)
docker compose up -d --build
```

Then open **http://<host>:8787** and create the owner account on first run.
`docker-compose.yml` maps `./data` (json db + state) and `./library` (downloads).

### Example `docker-compose.yml`

```yaml
services:
  renzo:
    build: .                       # or:  image: ghcr.io/levitate0/renzo:latest
    container_name: renzo
    restart: unless-stopped
    ports: ["8787:8787"]
    environment:
      PUBLIC_URL: "https://renzo.example.com"   # your external URL
    volumes:
      - ./data:/data               # JSON db + state (back this up)
      - ./library:/library         # downloaded video + subtitles
```

That's all that's required. **Real-Debrid is per-user** — each account pastes its own token in
Settings; nothing goes in the compose file. Optional env (`AUTO_DOWNLOAD`, `JELLYFIN_URL`/`_API_KEY`,
`JIMAKU_API_KEY`, `AUTHSITE_*`, `SESSION_TTL_DAYS`, …) is documented in `.env.example`. Put Renzo
behind a TLS reverse proxy or Cloudflare Tunnel for public access.

### From source (no Docker)

```bash
cp .env.example .env      # add your config
npm install
npm run build && npm start   # or: npm run dev
```

---

## ⚠️ Real-Debrid must be **Premium**

The torrent → debrid → download pipeline uses Real-Debrid's `/torrents` API, which
**requires an active premium subscription**. Reads (like account info) work on free
accounts, so the token can look valid while downloads fail with:

```
RD POST /torrents/addMagnet -> 403: permission_denied (error_code 9)
```

At last check this token's account was `type: free, premium: 0`. Renew premium (you had
1600 fidelity points — enough to activate) and streaming/downloading will work
immediately; no code change needed.

---

## Required credentials (per-user, in Settings)

Each account sets its **own** credentials under **Settings → Required credentials**:

| Credential | Needed for | Where to get it |
|------------|-----------|-----------------|
| **Real-Debrid API token** | streaming + downloading (mandatory) | https://real-debrid.com/apitoken |
| **Jimaku API key** | anime **subtitles** (captions in the player + saved with each download) | sign in at https://jimaku.cc → **Account → API key** |
| **AniList _or_ MyAnimeList** | list import + progress scrobbling (optional) | "Connect ↗" (opens the auth site) |

**Subtitles need the Jimaku key.** Renzo looks up subtitles by AniList id via
[Jimaku](https://jimaku.cc) using **the watching user's own key** — without it the player's
caption list is empty. The key is validated on save and stored per-user; `.env`'s
`JIMAKU_API_KEY` (below) is only a shared fallback. When an episode is downloaded, its subtitle
tracks are saved next to the video (`.vtt`) too, for Jellyfin + offline.

## Optional integrations (`.env`)

| Feature            | Vars |
|--------------------|------|
| Jellyfin rescan    | `JELLYFIN_URL`, `JELLYFIN_API_KEY` |
| Anime subtitles    | `JIMAKU_API_KEY` (get at https://jimaku.cc), `SUBTITLE_LANGS` |
| AniList / MAL       | per-user token in Settings, or `ANILIST_TOKEN` / `MAL_TOKEN` env override, or the auth site below |
| Central tracker auth | `AUTHSITE_SERVICE_KEY` — self-hosted auth site (URL hardcoded to `https://auth.levitatemedia.top`) that stores + auto-refreshes AniList/MAL tokens |

**Tracker token resolution** (per user, highest priority first): the user's own token
(Settings) → `ANILIST_TOKEN`/`MAL_TOKEN` env override → the **auth site**
(`GET {AUTHSITE_URL}/api/token/{anilist|myanimelist}` with `X-Service-Key`). Tokens are
fetched at call time and cached until ~1 min before they expire (the auth site refreshes
them itself). If the auth site is unreachable or an account isn't connected there, that
tracker simply shows as disconnected and scrobbles are skipped — nothing crashes.

Quality/search tuning: `PREFERRED_RESOLUTION`, `MIN_SEEDERS`, `DOWNLOAD_CONCURRENCY`.
Auto-downloader: `AUTO_DOWNLOAD`, `AUTO_DOWNLOAD_INTERVAL_MIN`, `AUTO_DOWNLOAD_MAX_PER_TICK`.

## Accounts & security (public / cloudflared)

Designed to be exposed through your cloudflared tunnel. Every request is gated.

- **Per-user accounts.** First visit shows a guided one-time **setup** screen: step 1 creates
  the **owner** (admin) — username, password (with strength meter + confirm) — and step 2
  connects Real-Debrid (auto-skipped if a token was seeded from env). Only the owner can add
  more users; every account it creates is a regular user. Passwords are hashed with **scrypt**
  (+ per-user salt, constant-time compare).
- **Sessions:** random 32-byte token in an **HttpOnly, SameSite=Lax** cookie (adds `Secure`
  automatically when `PUBLIC_URL` is https). Expiry via `SESSION_TTL_DAYS`; logout revokes.
- **Per-user everything (fully isolated):** each user has their **own library, watchlist/
  favorites/lists, download state, Real-Debrid token, and AniList/MAL connections**. Downloads
  land in a per-user subdirectory (`LIBRARY/u/<userId>/…`) and `/files` is scoped to the
  requesting user's own root, so **no user can see or reach another user's downloads** (verified
  against direct access and path traversal). Only AniList metadata/artwork is shared.
- **Real-Debrid is required per-user** — the app never sends torrent traffic from your own
  IP; everything is resolved through the user's RD account (ISP/DMCA-ban-risk prevention).
  No RD token → streaming/downloads return `402 realdebrid_required` and the UI prompts.
- **Downloads are per-user (no sharing).** Every user streams/downloads on **their own** RD
  token, and the scheduled auto-downloader runs **per account** — each user's own RD funds
  auto-downloads of the titles on their own AniList *Watching* list plus any they flag (`Auto`).
  No account's RD ever funds another's. Staff can **deny a specific user** all downloads from the
  Users list (they can still stream); denied users are skipped by the auto-downloader.
- **Library defaults (per-user):** optionally set a tracking status, a default folder, and
  auto-download to apply automatically the first time a series enters your library.
- **Hardening:** login rate-limiting (5 fails → 15-min lockout, keyed on `CF-Connecting-IP`),
  CSRF protection (`Sec-Fetch-Site` guard + SameSite cookies), strict **CSP** + security
  headers, `/files` media is auth-gated (never publicly listable), SSRF allowlist on the
  subtitle proxy (re-checked across redirects), first-run `/setup` race-locked to one admin,
  password change **rotates all sessions**, prototype-pollution-safe list names, 64 KB body
  cap, `X-Powered-By` disabled, username-timing-safe login.

Two adversarial review passes were run (a correctness pass and a dedicated security pass);
all confirmed findings from both are fixed and re-verified.

**Trusted-LAN escape hatch:** `AUTH_DISABLED=true` skips login entirely. Never set this
behind the public tunnel.

## Ports & network footprint

- **One inbound listener: TCP 8787** (web UI + API + file serving). The container runs
  with `network_mode: host`, so it's `http://<host>:8787` directly. Change via `PORT`.
- Outbound HTTPS only: AniList, AnimeTosho, Real-Debrid (+ its download hosts),
  Jimaku (if key set), MyAnimeList (if token set); plus local Jellyfin (`:8096`) for
  rescan triggers. No FUSE, no privileged capabilities, no other ports.

---

## HTTP API (for reference / automation)

```
GET  /api/health
GET  /api/discover/trending
GET  /api/discover/search?q=&type=series|movie
GET  /api/library                 ?list=watchlist|favorites|<custom> to filter
POST /api/library                 { anilistId }
GET  /api/lists                   list names with counts
POST /api/titles/:id/lists        { list, on } -> toggle watchlist/favorites/custom
GET  /api/folders                 my folders + title counts
POST /api/folders                 { name } -> create a folder
DELETE /api/folders/:name         delete a folder (contents move to default)
POST /api/titles/:id/folder       { folder } -> move a title (relocates files on disk)
GET  /api/titles/:id              full detail + episode list
GET  /api/titles/:id/play/:ep     -> { source: local|realdebrid, url, subtitles[] }
POST /api/titles/:id/download/:ep -> background download job
POST /api/titles/:id/download-season -> queue all missing aired episodes
POST /api/titles/:id/auto         { enabled } -> per-title auto-download toggle
GET  /api/autodl/status           auto-downloader state
POST /api/autodl/run              trigger an auto-download pass now
POST /api/titles/:id/watched/:ep  -> scrobble to trackers
GET  /api/jobs                    active/recent download jobs
POST /api/trackers/import         import AniList/MAL lists
GET  /api/captions/:id.vtt        remote sub converted to WebVTT
GET  /files/...                   downloaded media (HTTP range) + .vtt sidecars
```

## Verified

`npm run typecheck` + `npm run build` clean. Live-tested: server boot, AniList
discovery/search (real covers), RD token auth, AnimeTosho search + ranking (e.g. Frieren
S2 E1 → 2909-seeder 1080p top result), and the full resolve path up to the RD premium gate.

## Roadmap hooks

- ASS subtitle rendering in-browser (JASSUB) for full styling; currently ASS is
  down-converted to plain WebVTT.
- OpenSubtitles fallback provider (scaffolded via `OPENSUBTITLES_API_KEY`).
