# Renzo web UI — contracts the code relies on

The Next.js app here is a presentation layer over the Express API in `../src/`.
These are the conventions several components depend on; comments across
`src/` point back to the sections below. The legacy SPA in `../public/`
(`index.html`, `app.js`, `styles.css`) is still in the image as an emergency
fallback (`LEGACY_UI=1`) and is the original reference for behaviour this app
ported.

## Stack
Next 16 App Router, static export (`npm run build` → `out/`), React 19, Tailwind 4,
shadcn primitives in `src/components/ui/`, react-query, sonner toasts, lucide icons,
Geist Sans (+Fraunces/JetBrains Mono variables), `cn()` from `@/lib/utils`.
Dark-only. Theme = Shiori's scheme, in `src/styles/globals.css` +
`src/lib/utils/theme-preset.ts` (localStorage keys `renzo-preset`, `renzo-accent`,
`renzo-accent-custom`; default preset id `renzo`).

## Routing (static export ⇒ NO dynamic segments — query strings, like Shiori)
| Old (hash) | Route |
|---|---|
| tabs: discover default | `/` |
| library | `/library/` |
| updates | `/updates/` |
| history | `/history/` |
| downloads | `/downloads/` |
| `#/title/<id>` | `/title/?id=<anilistId>` |
| `#/watch/<watchId>/<ep>` | `/watch/?id=<watchId>&ep=<n>` |
| `#/settings` (+panes) | SPLIT (Shiori IA, 2026-08-01): `/account/?section=<account\|credentials\|defaults\|apikey>` (every user), `/appearance/` (every user), `/users/` (staff), `/settings/` (owner: SMTP/Email). Old `?pane=` URLs redirect via the shim in `src/app/settings/page.tsx`. Settings-family route roots carry `view active modal` (the `modal` marker is what makes TV Back close the page instead of leaving it). |
| TV pairing approval | `/tv/` |
| login/setup/reset/invite gates | full-screen overlays rendered by the auth guard (NOT routes) |

`useSearchParams` requires a `<Suspense>` boundary in static export — wrap pages that
use it. All internal links via `next/link` with trailing slashes.

## Auth
Cookie `fsa_session` (HttpOnly, same-origin). `GET /api/auth/me` → `{ user }`,
`{ setupRequired: true }` (first-run owner setup gate), or 401.
Central api client `src/lib/api.ts`: fetch wrapper, same-origin credentials, JSON;
on **401** → show the login gate (do NOT redirect-loop); on **402
realdebrid_required** → open `/account/?section=credentials` + toast. Password reset
arrives as `/?reset=<token>`; invite accept as `/?invite=<token>` or the older
`/invite/<token>` path (`src/contexts/auth-context.tsx`).

## TV mode
- `window.RenzoTV = { enable, isOn, back, playPause }` and the flag `window.__RENZO_TV`
  are provided by `public/tvnav.js` (loaded verbatim from `layout.tsx`).
  `RenzoTV.back()` returns true if it consumed Back.
- `isTv()` = `window.__RENZO_TV || <html>.tv-nav || <body>.tv-nav` (`src/lib/native.ts`,
  re-exported from `src/lib/tv.ts`). On TV: NO offline features anywhere (no
  save-offline buttons, mode pill is display-only), no offline gate.

## DOM contract for tvnav.js (D-pad nav — do not regress)
tvnav.js discovers focusables by class and reads app state from ids/body classes.
Components MUST carry these exact literal class names / ids alongside Tailwind:
- Focusable tiles: `card` (poster cards), `ep-card` (episode tiles), `season-card`,
  `more-tile`, `wep` (player episode rows).
- Body state classes: `watching` (player open), `detailing` (title page open).
- Ids: `watchVideo`, `watchBack` (player back button), `offlineGate`, `offlineClose`.
- Blocking overlays: class `modal` + `hidden` toggling, auth gates class `auth-gate`
  + `hidden`; chrome containers `topbar` and `tabs`.
tvnav's `roots()` also expects a current page container: give every page's root
element the class `view active` (chrome + page scoping). Change tvnav.js itself
deliberately, not as a side effect of page work.

## Design conventions (shared with Shiori)
- Mobile overflow: main scroll container `overflow-x-hidden`; single-column card
  stacks use `grid grid-cols-1` (never bare `grid`); wide content gets its own
  `overflow-x-auto` wrapper; two-cluster rows `flex flex-col gap-3 sm:flex-row
  sm:items-center sm:justify-between`; button/input rows `flex-wrap`, inputs
  `w-full sm:w-40`-style; long text `min-w-0 truncate` next to `shrink-0` controls;
  dialogs `w-[95vw] sm:w-full max-w-lg`.
- Heights: `dvh` never `vh`.
- TV: page padding for overscan when `.tv-nav`, a visible `:focus` ring, no
  scrollbars (globals.css).
- Renzo branding: in-page wordmark is `/renzo-banner.png` (byte-preserved) — topbar
  brand, auth gates. Do not restyle or replace it.
- suppressAutofill (`src/lib/autofill.ts`): password managers hijacked plain inputs,
  so credential-token fields are masked as text + `masked` class and stay
  readonly until focus. NOT the login form — that must stay a real `<form>` with
  `enterkeyhint` so a TV IME's Go action submits (commit bbe2b84).
