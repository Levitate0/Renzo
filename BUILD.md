# Building Renzo

How to build, sign, deploy, and release every Renzo artifact: the **server / web app**
(this repo) and the **Windows desktop app**.

> **Where the code lives.** This repo (`Levitate0/Renzo`) is the **server + web app**
> (`src/` + `frontend/`). The Windows client *source* is intentionally **not**
> committed — it lives on the build host under `/opt/zurg-stack/renzo-clients/desktop/`
> alongside the signing material in `signing/`. No server address is compiled in —
> the app asks on first run.
>
> **Mobile and TV live in Renzo Hub**, a separate application that carries both Renzo
> and Renzo Shiori. It is not built, released or documented from this repo — this repo
> is only the anime server and its web UI, which Hub talks to over `/api`.
>
> Paths below are this build host's layout; adapt them if you build elsewhere. **Never
> commit secrets** — keystore / PFX passwords and API tokens are read from files on the
> host (`signing/CREDENTIALS.txt`, `/root/.git-credentials`) and must stay out of git.

---

## 1. Server / web app (this repo)

**Prerequisites:** Node 20+, Docker + Docker Compose.

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # tsc -> dist/
npm start                # node dist/server.js   (or: npm run dev  = tsx watch)
```

The web UI in `public/` is plain HTML/CSS/JS — **no build step**. `server.ts` stamps a
per-boot `BUILD` id and cache-busts `app.js` / `styles.css` (`?v=<BUILD>`); `index.html`
is `no-store`. So every server restart busts client caches automatically, and the
unauthenticated `GET /version` returns `{ build }` (the clients poll it to hot-reload).

### Deploy (Docker)

The anime app runs as the **`renzo`** container defined in the stack compose file.

```bash
cd /opt/zurg-stack                      # MUST run from here — running from the app dir
docker compose up -d --build renzo      # collides on the 'renzo' container name (the
                                        # manga app also uses it) and fails to recreate
```

- Container listens on **`PORT=8787`**; `DATA_DIR=/data`.
- Binds: `/media-services-config/fullstack-arr -> /data` (the JSON DB `db.json` + state)
  and the anime library dir `-> /library`. **The DB persists here** across `--build`
  recreates — don't look for it inside the container's own filesystem.

Verify after deploy:

```bash
curl -s http://localhost:8787/version           # {"build":"..."}  (new id each deploy)
curl -s http://localhost:8787/api/health        # 401 unless authed — that's expected
```

---

## 2. Windows desktop app (Electron)  — `renzo-clients/desktop`

An electron-builder / NSIS shell that loads the remote web app and exposes a native
`window.RenzoNative` bridge (folder picker, disk downloads via `net.request`, the
`renzo-media://` playback protocol, `/version` update polling).

**Build + sign** (signed with `osslsigncode` via `wine` in `sign.js`, since electron-builder's
bundled signer won't run here):

```bash
cd /opt/zurg-stack/renzo-clients/desktop
export RENZO_PFX=/opt/zurg-stack/renzo-clients/signing/renzo-codesign.pfx
# PFX password from CREDENTIALS.txt ("Windows PFX password") — never echo it.
export RENZO_PFX_PASS="$(grep -i 'password' /opt/zurg-stack/renzo-clients/signing/CREDENTIALS.txt | head -1 | awk -F': ' '{print $2}')"
npm run dist                              # electron-builder --win  (NSIS one-click)
# -> dist/Renzo-Setup-<version>.exe   (signed + timestamped)
```

Bump `version` in `desktop/package.json` for a new installer (`artifactName` =
`Renzo-Setup-${version}.exe`). Requires `osslsigncode` + `wine` on the host.

---

## 3. Cutting a release

There is **no `gh` CLI** on this host — publish via the GitHub REST API using the PAT in
`/root/.git-credentials` (never print it). A release ships the **Windows installer**,
staged in `/opt/zurg-stack/renzo-clients/artifacts/`.

```bash
cd /opt/zurg-stack/renzo-clients/artifacts
TOKEN="$(sed -n 's#https://[^:]*:\([^@]*\)@github.com#\1#p' /root/.git-credentials | head -1)"
API=https://api.github.com/repos/Levitate0/Renzo
```

- **New version:** `POST $API/releases` with `{tag_name, target_commitish:"main", name, body}`,
  then upload each asset to the returned `upload_url` (`…/assets?name=<file>`).
- **Update an existing release in place** (re-spinning the installer within a "major"
  version like `v1.2.0` until it's right): `DELETE` the old asset id(s) from
  `$API/releases/<id>/assets`, then re-upload the new `.exe`.

Only commit/push the repo (`git push origin main`) when the change is server/web side;
client binaries live in releases, and client *source* is not tracked here.

---

## Quick reference

| I changed… | Rebuild | Users get it by |
|------------|---------|-----------------|
| `src/` or `frontend/` (server/web) | `docker compose up -d --build renzo` (from `/opt/zurg-stack`) | reloading the web app or the Electron client — **not** Renzo Hub, which is native |
| `desktop/` main/preload | `npm run dist` + release | installing the new `.exe` |

**Commit trailer** for repo commits:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```
