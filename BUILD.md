# Building Renzo

How to build, sign, deploy, and release every Renzo artifact: the **server / web app**
(this repo), the **Android APK**, and the **Windows desktop app**.

> **Where the code lives.** This repo (`Levitate0/Renzo`) is the **server + web app**
> (`src/` + `frontend/`). The client *source* is intentionally **not** committed — it
> lives on the build host under `/opt/zurg-stack/renzo-clients/` (`tv-native/` for
> Android, `desktop/` for Electron) alongside the signing material in `signing/`.
> No server address is compiled in — the app asks on first run.
>
> **The Android app is now NATIVE** (Kotlin + Compose, `tv-native/`), not a web shell.
> Web changes therefore reach the browser and the Electron app on a redeploy, but
> **do not reach the Android app at all** — anything the native client should show
> has to be built into it and shipped as a new APK. The older `capacitor/` and
> `android/` (raw WebView) client directories are **superseded**; see
> `renzo-clients/README.md`.
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

## 2. Android app (native Kotlin/Compose) — `renzo-clients/tv-native`

**Fully native** — Kotlin + Jetpack Compose (`androidx.tv` tv-material) + Media3/ExoPlayer,
talking to the server's HTTP API. No WebView, no web shell. ONE APK covers phones,
tablets, Android TV and Fire TV (both `LAUNCHER` and `LEANBACK_LAUNCHER`, with `leanback`
and `touchscreen` declared `required="false"`).

> The `capacitor/` and `android/` (raw WebView) directories under `renzo-clients/` are
> **superseded** and must not be built. Don't delete `android/` though — `android/sdk/`
> is the shared Android SDK both this app and the Hub build against.

Because the client is native, **it does not pick up web changes**: anything it should
display has to be implemented in Kotlin and shipped as a new APK.

**Toolchain (already installed on the build host):**

| Tool | Location / version |
|------|--------------------|
| JDK  | **21** at `/opt/jdk21` (pinned via `org.gradle.java.home` in `gradle.properties`) |
| Android SDK | `/opt/zurg-stack/renzo-clients/android/sdk` — platform **android-36**, build-tools **36.0.0** (`local.properties` → `sdk.dir=…`) |
| Gradle / AGP | wrapper **8.14.3** / AGP **8.13** |
| SDK levels | `minSdk 24`, `compileSdk`/`targetSdk 36` (`app/build.gradle.kts`) |

**Build the release APK:**

```bash
cd /opt/zurg-stack/renzo-clients/tv-native
./gradlew :app:assembleRelease --console=plain
# -> app/build/outputs/apk/release/app-release-unsigned.apk
```

There is also a `demo` build type used only to shoot Play listing screenshots — it
swaps every image from the server for Renzo-icon placeholders so no third-party cover
art lands in the store. See `renzo-clients/tv-native/DEMO-BUILD.md`. **Never publish it.**

**Sign** (no `signingConfig` in Gradle — sign the unsigned APK afterwards):

```bash
cd /opt/zurg-stack/renzo-clients
BT=android/sdk/build-tools/36.0.0
# Keystore password (store == key) is read from CREDENTIALS.txt — never echo it.
KSPASS="$(grep 'store/key pass' signing/CREDENTIALS.txt | awk -F': ' '{print $2}')"
"$BT/zipalign" -f -p 4 \
  tv-native/app/build/outputs/apk/release/app-release-unsigned.apk artifacts/_a.apk
"$BT/apksigner" sign --ks signing/renzo-release.jks --ks-pass "pass:$KSPASS" \
  --ks-key-alias renzo --key-pass "pass:$KSPASS" --min-sdk-version 24 \
  --out artifacts/Renzo.apk artifacts/_a.apk
rm -f artifacts/_a.apk
"$BT/apksigner" verify --min-sdk-version 24 artifacts/Renzo.apk
"$BT/aapt2" dump badging artifacts/Renzo.apk | grep -o "versionCode='[0-9]*' versionName='[^']*'"
```

**Versioning:** bump `versionCode` in `tv-native/app/build.gradle.kts` on **every** build
(Android requires a higher `versionCode` to update in place). `versionName` can stay the
same within a release (e.g. `1.3.1`, versionCode 42 → 43 → 44…) — a higher versionCode
installs over the existing app and **keeps user data**. Same keystore = in-place update.

**applicationId `top.levitatemedia.renzo` and `signing/renzo-release.jks` are permanent**
— the Play listing is bound to both. Renaming the package means a new listing with no
install base; losing the key means every user must uninstall and reinstall.

**TV support:** the manifest declares a `LEANBACK_LAUNCHER` category + `uses-feature`
`leanback`/`touchscreen` `required=false` + a 320×180 `@drawable/renzo_tv_banner`, so the SAME
APK installs on phones **and** Android TV / Fire TV. Fire TV = free sideload / Amazon Appstore.

### Google Play — App Bundle for no-sideload TV installs

Play needs an **`.aab`** (App Bundle), not an APK, and uses **Play App Signing** (you upload
signed with your keystore as the *upload key*; Google re-signs for distribution).

```bash
cd tv-native
./gradlew :app:bundleRelease
# -> app/build/outputs/bundle/release/app-release.aab   (unsigned)
# Sign with the keystore as the upload key (jarsigner, not apksigner — AABs are JAR-signed):
KSPASS="$(grep 'store/key pass' ../signing/CREDENTIALS.txt | awk -F': ' '{print $2}')"
jarsigner -keystore ../signing/renzo-release.jks -storepass "$KSPASS" -keypass "$KSPASS" \
  -sigalg SHA256withRSA -digestalg SHA-256 -signedjar ../artifacts/Renzo.aab \
  app/build/outputs/bundle/release/app-release.aab renzo
jarsigner -verify ../artifacts/Renzo.aab
```

**Distribution (no sideloading):** this app can't go on a **public** Play listing (anime
torrent/debrid ⇒ IP-policy rejection, risks the account). Use a **Closed testing** track
instead: create the app (declare the **Android TV** form factor), upload `Renzo.aab`, complete
App content (privacy policy — see `HANDOFF_renzo-apps_privacy-policy.md`, Data safety, Content
rating **18+**), then add testers by email / a Google Group. They install from the **Play Store**
on the TV via the opt-in link — no unknown-sources, no ADB, auto-updates. Store fees are
**per developer account** ($25 one-time Google Play), so one account covers Renzo + Shiori.

---

## 3. Windows desktop app (Electron)  — `renzo-clients/desktop`

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

## 4. Cutting a release

There is **no `gh` CLI** on this host — publish via the GitHub REST API using the PAT in
`/root/.git-credentials` (never print it). A release bundles the **APK + EXE +
`SHA256SUMS.txt`**, staged in `/opt/zurg-stack/renzo-clients/artifacts/`.

```bash
cd /opt/zurg-stack/renzo-clients/artifacts
sha256sum Renzo.apk Renzo-Setup-*.exe > SHA256SUMS.txt
TOKEN="$(sed -n 's#https://[^:]*:\([^@]*\)@github.com#\1#p' /root/.git-credentials | head -1)"
API=https://api.github.com/repos/Levitate0/Renzo
```

- **New version:** `POST $API/releases` with `{tag_name, target_commitish:"main", name, body}`,
  then upload each asset to the returned `upload_url` (`…/assets?name=<file>`).
- **Update an existing release in place** (e.g. re-spinning the APK within a "major"
  version like `v1.2.0` until it's right): `DELETE` the old asset id(s) from
  `$API/releases/<id>/assets`, then re-upload the new `Renzo.apk` + refreshed
  `SHA256SUMS.txt`. Keep `versionName` the same and only bump `versionCode`.

Only commit/push the repo (`git push origin main`) when the change is server/web side;
client binaries live in releases, and client *source* is not tracked here.

---

## Quick reference

| I changed… | Rebuild | Users get it by |
|------------|---------|-----------------|
| `src/` or `frontend/` (server/web) | `docker compose up -d --build renzo` (from `/opt/zurg-stack`) | reloading the web app or the Electron client — **not** the Android app, which is native |
| `tv-native/` Kotlin or resources | Gradle `assembleRelease` + sign + release | reinstalling the APK (versionCode bump) |
| `desktop/` main/preload | `npm run dist` + release | installing the new `.exe` |

**Commit trailer** for repo commits:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```
