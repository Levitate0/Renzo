# Renzo Next.js port — contracts every agent must follow

The old frontend is `../public/{index.html,app.js,styles.css,tvnav.js}` — it is the
**behavioral ground truth**. Read it before porting a view; every flow it implements
must exist in the new app. The Express backend (`../src/`) is UNCHANGED — this is a
presentation rewrite against the same API. Do not modify anything outside `frontend/`.

## Stack (already scaffolded and building)
Next 16 App Router, static export (`npm run build` → `out/`), React 19, Tailwind 4,
shadcn primitives in `src/components/ui/`, react-query, sonner toasts, lucide icons,
Geist Sans (+Fraunces/JetBrains Mono variables), `cn()` from `@/lib/utils`.
Dark-only. Theme = Shiori's scheme, already in `src/styles/globals.css` +
`src/lib/utils/theme-preset.ts` (localStorage keys `renzo-preset`, `renzo-accent`,
`renzo-accent-custom`; default preset id `renzo`).

## Routing (static export ⇒ NO dynamic segments — query strings, like Shiori)
| Old (hash) | New route |
|---|---|
| tabs: discover default | `/` |
| library | `/library/` |
| updates | `/updates/` |
| history | `/history/` |
| downloads | `/downloads/` |
| `#/title/<id>` | `/title/?id=<anilistId>` |
| `#/watch/<watchId>/<ep>` | `/watch/?id=<watchId>&ep=<n>` |
| `#/settings` (+panes) | `/settings/?pane=<credentials\|defaults\|appearance\|users\|smtp\|apikey>` |
| login/setup/reset gates | full-screen overlays rendered by the auth guard (NOT routes), same as old |

`useSearchParams` requires a `<Suspense>` boundary in static export — wrap pages that
use it. All internal links via `next/link` with trailing slashes.

## Auth
Cookie `fsa_session` (HttpOnly, same-origin). `GET /api/auth/me` → `{ user }` or 401.
Central api client (`src/lib/api.ts`, built in phase 1): fetch wrapper, same-origin
credentials, JSON; on **401** → show the login gate (do NOT redirect-loop); on **402
realdebrid_required** → open settings credentials pane + toast (see old `api()` at
`public/app.js:20`). First-run: `/api/auth/setup-status` drives the owner-setup gate;
password reset arrives as `/?reset=<token>`; invite accept as `/?invite=<token>`
(check exact param names in `public/app.js` — search `reset` / `invite`).

## Native contracts — MUST keep working (shipped APK vc21 + Electron call these)
- `window.RenzoTV = { enable, isOn, back, playPause }` and flag `window.__RENZO_TV`
  — provided by `public/tvnav.js` (copied verbatim into `frontend/public/tvnav.js`,
  loaded from layout.tsx). Android's MainActivity evaluates these via
  evaluateJavascript. `RenzoTV.back()` must return true if it consumed Back.
- `window.Capacitor.Plugins.RenzoSaf` — `{ chooseFolder(), getFolder(), prepare({key}) }`
  (offline playback), `RenzoDownloader` — `{ enqueue({key,video,title,subs}), status(),
  requestNotifications() }` + progress events (see `Offline.bridge` usage in old
  `app.js` ~lines 160–300 and ~415–430 for the exact listener wiring),
  `RenzoServer` — `{ get(), set({url}), clear() }` ("Change server" in account menu,
  shown ONLY when the plugin exists — `public/app.js` near `#serverBtn`).
- `isTv()` = `window.__RENZO_TV || <html>.tv-nav || <body>.tv-nav`. On TV: NO offline
  features anywhere (no save-offline buttons, mode pill is display-only), no offline
  gate; see recent commits c575212 / bbe2b84 for the exact semantics.
- Offline (phone/desktop only): port the `Offline` module (manifest in localStorage
  key check old code, cache-storage saves on web, native SAF path via bridge,
  queued watched-marks flush on reconnect, purge-on-reconnect prompt).

## DOM contract for tvnav.js (D-pad nav — verified working, do not regress)
tvnav.js discovers focusables by class and reads app state from ids/body classes.
New components MUST carry these exact literal class names / ids alongside Tailwind:
- Focusable tiles: `card` (poster cards), `ep-card` (episode tiles), `season-card`,
  `more-tile`, `wep` (player episode rows).
- Body state classes: `watching` (player open), `detailing` (title page open).
- Ids: `watchVideo`, `watchBack` (player back button), `offlineGate`, `offlineClose`.
- Blocking overlays: class `modal` + `hidden` toggling, auth gates class `auth-gate`
  + `hidden`; chrome containers `topbar` and `tabs`.
tvnav's `roots()` also expects a current page container: give every page's root
element the class `view active` (chrome + page scoping). Do not edit tvnav.js in
page work — flag mismatches in your final report instead.

## Design conventions (Shiori's hard-won rules — apply from the start)
- Mobile overflow: main scroll container `overflow-x-hidden`; single-column card
  stacks use `grid grid-cols-1` (never bare `grid`); wide content gets its own
  `overflow-x-auto` wrapper; two-cluster rows `flex flex-col gap-3 sm:flex-row
  sm:items-center sm:justify-between`; button/input rows `flex-wrap`, inputs
  `w-full sm:w-40`-style; long text `min-w-0 truncate` next to `shrink-0` controls;
  dialogs `w-[95vw] sm:w-full max-w-lg`.
- Heights: `dvh` never `vh`.
- TV overscan + focus ring already exist in the old styles.css under `body.tv-nav`
  — replicate the intent in globals.css additions (page padding when `.tv-nav`,
  visible `:focus` ring, no scrollbars — see old `styles.css` tail).
- Renzo branding: in-page wordmark is `/renzo-banner.png` (byte-preserved) — topbar
  brand, auth gates. Do not restyle or replace it.
- suppressAutofill: password managers hijacked plain inputs; the old app masks
  password-type fields as text+`masked` class and uses readonly-until-focus
  (`public/app.js:119`). Port this as a small hook/util used by credentials forms
  (NOT the login form — that must stay a real `<form>` with `enterkeyhint` so the
  Android TV IME's Go action submits; see commit bbe2b84).

## File ownership (parallel agents — do not write outside your set)
- **shell**: `src/components/shell/*` (topbar, tabs+drawer, account menu, mode pill,
  search box), `src/contexts/*`, `src/lib/{api,types,native,offline,tv}.ts`,
  auth gates `src/components/gates/*`, `src/app/layout.tsx` adjustments.
- **browse**: `src/app/{page,library,updates,history}/**`, shared card/grid
  components `src/components/media/*` (poster card, grids, content-chip ladder,
  folder chips, ribbons, up-next line).
- **detail**: `src/app/title/**`, `src/components/title/*` (hero, actions, folders/
  provider/tracking rows, season row, episode grid + per-episode menus, more-details
  lightbox).
- **player-downloads**: `src/app/watch/**`, `src/components/player/*` (custom
  controls, CC menu + our-own-cue rendering per old `setupCaptions`, prefetch,
  up-next pinned row, ep list, fullscreen), `src/app/downloads/**` (jobs polling,
  autodl status bar incl. self-check warnings + Run now gating `canRun`).
- **settings**: `src/app/settings/**` (credentials RD/AD/Jimaku/trackers with
  connect-popup + polling fallback, defaults, appearance page using theme-preset.ts,
  users/invites/SMTP admin, API key display/regenerate, account deletion if present).

Shared primitives live in `src/components/ui/` (already copied) — extend only via
new files, never edit someone else's files. If you need something from another
agent's area, code against the contract here and note it in your report.

## Verification expected from every agent
`cd frontend && npx tsc --noEmit` must pass for YOUR files (pre-existing errors in
others' files: ignore, report). Do NOT run `npm run build` (integration does).
Report: files written, old-app behaviors covered (list), behaviors deferred/missing.
