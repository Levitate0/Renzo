# ---- frontend build stage (Next.js static export) ----
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend ./
RUN npm run build

# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# ffmpeg/ffprobe: extract embedded (English) subtitle tracks from downloaded releases
RUN apk add --no-cache ffmpeg
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY public ./public
# Next static export — served instead of public/ when USE_NEXT_UI=1
COPY --from=webbuild /web/out ./frontend/out
EXPOSE 8787
VOLUME ["/data", "/library"]
CMD ["node", "dist/server.js"]
