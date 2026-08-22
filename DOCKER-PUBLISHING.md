# Publishing the Renzo image

Prep work, laid 2026-08-21. **Nothing has been published yet** — the pipeline
exists and is deliberately inert until a version tag is pushed.

## How it fires

`.github/workflows/docker-publish.yml`:

| Event | Result |
|---|---|
| push to `main` | image is **built** (both architectures) and **not pushed** — a broken Dockerfile fails the commit that broke it, nothing reaches the registry |
| push tag `v1.4.0` | pushes `:1.4.0`, `:1.4`, `:1`, `:latest`, `:sha-<commit>` |
| Actions → Publish image → Run workflow | pushes whatever tag you type (`edge`, `rc1`, …) |

Cutting a release is therefore:

```
git tag v1.4.0 && git push origin v1.4.0
```

No secret to create: it authenticates with the automatic `GITHUB_TOKEN`, scoped
to `packages: write` on this repository only.

## Before the first publish — four things GitHub needs, once

1. **Actions must be allowed to write packages.** Settings → Actions → General →
   Workflow permissions. The workflow requests `packages: write` per-job, but an
   org/repo default of "read repository contents" overrides that and the push
   fails with a 403 that reads like a credential problem.
2. **Decide the package's visibility.** The repo is private, so the package is
   created private and `docker pull` will 401 for anyone without a token. If
   Renzo is meant to be installable by other people, the package has to be made
   public explicitly (Packages → renzo → Package settings → Change visibility);
   a private repo can own a public package.
3. **Link the package to the repo** (same settings page). The
   `org.opencontainers.image.source` label in the Dockerfile already points at
   it, which is usually enough for GHCR to link it automatically.
4. **Check the arm64 build time once.** arm64 builds under QEMU emulation and
   the Next.js stage is the slow part. If a tag build takes an unreasonable
   amount of time, the options are a native arm runner or dropping to amd64 —
   don't discover this during a release.

## What the image is

- **Base:** `node:22-alpine`, one major across all three stages (it was split
  22/20 before, which meant the thing that was tested and the thing that shipped
  were different runtimes).
- **Reproducible:** `npm ci` from the lockfiles, not `npm install`. A published
  image that floats its dependencies cannot be rebuilt.
- **Multi-arch:** `linux/amd64` and `linux/arm64`.
- **Labelled:** OCI title/description/source/version/revision, so
  `docker inspect` answers "which commit is this?".
- **Health-checked:** hits `/version`, which is unauthenticated and touches no
  provider, so it reports honestly whether or not a debrid token is configured.
- **Signed:** build provenance is attested and pushed alongside the image
  (`actions/attest-build-provenance`), so `gh attestation verify` can prove a
  given digest came from this repo's workflow.
- **~306 MB**, ffmpeg included (subtitle extraction needs it).

## Running as non-root — the one deliberate omission

The image runs as **root**, which for a published image is a fair criticism.
It is not an oversight:

`/data` and `/library` are bind mounts, root-owned on every existing install.
Adding `USER node` makes the first write after an upgrade fail with `EACCES`,
so it would silently break everyone who pulls the new tag.

Doing it properly means one of:

- a documented one-off `chown -R 1000:1000 ./data ./library` in the upgrade
  notes, with the image switching to `USER node`; or
- a `PUID`/`PGID` entrypoint that chowns and drops privileges at start-up
  (the LinuxServer.io pattern), which keeps upgrades transparent.

The second is friendlier and is the one to do before the image is advertised to
anyone else. It is a breaking change either way, so it belongs in a release
where that can be said out loud.

## For consumers

`docker-compose.published.yml` is the copy-paste starting point: it pulls the
image rather than building, and carries the two settings people get wrong —
`PUBLIC_URL` (pairing codes and reset links are built from it) and `TRUST_PROXY`
(never `true` behind a proxy; it hands the login lockout a header anyone can
set).

## Still to decide

- **Versioning.** The tags above assume semver on `v*.*.*`. `package.json` says
  `1.0.0` and has since the first commit, while the README and the site describe
  the app as v1.3.1 — so the one number a tag should agree with is currently
  wrong. Settle that before the first tag, or `:1` will mean nothing.
- **A release-notes step.** The clients repo publishes GitHub releases with
  `SHA256SUMS`; the server image could attach its digest to a release the same
  way.
- **Retention.** GHCR keeps every `sha-` tag forever unless told otherwise. A
  cleanup workflow (`actions/delete-package-versions`) keeping, say, the last 20
  untagged versions stops the package growing without bound.
