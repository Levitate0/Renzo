# =============================================================================
#  Renzo — container image.
#
#  Published to ghcr.io/levitate0/renzo by .github/workflows/docker-publish.yml
#  (tags and manual dispatch only — pushes to main are built but never pushed).
#  Build locally with: docker compose build renzo
# =============================================================================
ARG NODE_VERSION=22-alpine

# ---- frontend build stage (Next.js static export) ----
FROM node:${NODE_VERSION} AS webbuild
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
# `ci` not `install`: builds must be reproducible from the lockfile, and a
# published image that quietly floats its dependencies is not reproducible.
RUN npm ci --no-audit --no-fund
COPY frontend ./
RUN npm run build

# ---- server build stage ----
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:${NODE_VERSION}
WORKDIR /app
ENV NODE_ENV=production

# Provenance, so GHCR links the package to the repo and `docker inspect` can
# answer "which commit is this?" without guesswork.
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Renzo" \
      org.opencontainers.image.description="Private, per-user anime streaming and downloads via Real-Debrid / AllDebrid." \
      org.opencontainers.image.source="https://github.com/Levitate0/Renzo" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# ffmpeg/ffprobe: extract embedded (English) subtitle tracks from downloaded releases
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Next static export — served instead of public/ when USE_NEXT_UI=1
COPY --from=webbuild /web/out ./frontend/out

EXPOSE 8787
VOLUME ["/data", "/library"]

# /version is unauthenticated and touches no provider, so it answers while the
# server is up regardless of whether a debrid token is configured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# NOTE: runs as root deliberately, for now. /data and /library are bind mounts
# on existing installs and are root-owned there; switching to `USER node` would
# make an in-place upgrade fail on first write. See DOCKER-PUBLISHING.md
# "Running as non-root" for the migration this needs.
CMD ["node", "dist/server.js"]
