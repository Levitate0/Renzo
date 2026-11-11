# Renzo — working rules

Anime server + web UI (Node, `src/` and `frontend/src`). One of three surfaces
of the Renzo ecosystem; the others are Renzo Shiori (manga, Levitate0/Renzo-Shiori)
and Renzo Hub (the only client app, Levitate0/Renzo-Hub). On the owner's server
the three repos sit side by side, with a shared CLAUDE.md in the parent
directory that has the full picture.

## Owner rules

- **Web changes go to Hub too (2026-11-08).** Every change to this web UI is
  also made in Renzo Hub (its anime half, `feature-renzo`) in the same piece of
  work, without asking: transliterate 1:1 into Kotlin/Compose, compile-check
  Hub, and cut a Hub release so it actually reaches the owner. Server-only
  changes need no Hub port.
- **Every shipped change is released (2026-11-10).** Deploying locally is not
  the end. When changes ship, also release this repo, the same way Hub is
  released:
  1. Push `main` to Levitate0/Renzo. There is no version file; the image takes
     its version from the tag.
  2. `git tag -a vX.Y.Z` and push the tag. CI (`.github/workflows/docker-publish.yml`)
     builds and publishes `ghcr.io/levitate0/renzo` for linux/amd64 + linux/arm64.
  3. Create the GitHub release page for the tag with a plain-language changelog
     of everything since the previous tag.
  4. Check the Actions run succeeded and the tag is on GHCR.

  Batch a piece of work into one release; don't release every commit.

## Deploy (owner's server)

`docker compose build renzo` from the compose directory, then recreate the
container. Track status values are the server's lowercase set
(`watching/completed/planning/paused/dropped/rewatching`).
