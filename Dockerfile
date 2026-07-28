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
EXPOSE 8787
VOLUME ["/data", "/library"]
CMD ["node", "dist/server.js"]
