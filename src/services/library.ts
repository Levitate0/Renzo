import { promises as fs, createWriteStream } from "node:fs";
import { dirname, join, extname, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Title } from "../types.js";

const log = logger("library");

export function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
}

function folderName(t: Title): string {
  return sanitize(t.year ? `${t.english ?? t.romaji} (${t.year})` : (t.english ?? t.romaji));
}

/** Each user's downloads live under their own isolated root: LIBRARY/u/<userId>. */
export function userRoot(userId: string): string {
  return join(config.libraryDir, "u", userId);
}
export function userAbs(userId: string, rel: string): string {
  return join(userRoot(userId), rel);
}

/** Jellyfin-standard target path (relative to the user's root) for a download.
 *  Layout: <folder>/<movies|series>/<Title (year)>/… so users can organize their
 *  library into multiple named folders. */
export function targetFor(
  userId: string,
  folder: string,
  t: Title,
  episode: number,
  sourceName: string,
): { abs: string; rel: string } {
  const ext = extname(sourceName).toLowerCase() || ".mkv";
  const base = folderName(t);
  const fdir = sanitize(folder) || "Library";
  const typeDir = t.type === "movie" ? "movies" : "series";
  let rel: string;
  if (t.type === "movie") {
    rel = join(fdir, typeDir, base, `${base}${ext}`);
  } else {
    const ep = String(episode).padStart(2, "0");
    rel = join(fdir, typeDir, base, "Season 01", `${sanitize(t.english ?? t.romaji)} - S01E${ep}${ext}`);
  }
  return { abs: userAbs(userId, rel), rel };
}

export function titleDir(userId: string, folder: string, t: Title): string {
  const fdir = sanitize(folder) || "Library";
  return join(userRoot(userId), fdir, t.type === "movie" ? "movies" : "series", folderName(t));
}

/** Move a title's folder on disk (<old>/<type>/<base> -> <new>/<type>/<base>). */
export async function moveTitleDir(
  userId: string,
  from: string,
  to: string,
  t: Title,
): Promise<boolean> {
  const src = titleDir(userId, from, t);
  const dst = titleDir(userId, to, t);
  if (src === dst) return true;
  try {
    if (!(await exists(src))) return false;
    await fs.mkdir(dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    log.info("moved", relative(config.libraryDir, src), "->", relative(config.libraryDir, dst));
    return true;
  } catch (e) {
    log.warn("move failed", String(e));
    return false;
  }
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** Stream a remote (Real-Debrid direct) URL to disk, reporting 0..1 progress. */
export async function downloadTo(
  url: string,
  abs: string,
  onProgress?: (fraction: number, receivedBytes: number) => void,
): Promise<{ bytes: number }> {
  await fs.mkdir(dirname(abs), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;
  const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  src.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total) onProgress?.(received / total, received);
  });
  const tmp = `${abs}.part`;
  await pipeline(src, createWriteStream(tmp));
  await fs.rename(tmp, abs);
  log.info("saved", relative(config.libraryDir, abs), `${(received / 1e9).toFixed(2)} GB`);
  return { bytes: received };
}

/** Save the AniList cover as Jellyfin artwork (poster.jpg / banner.jpg). */
export async function saveArtwork(userId: string, folder: string, t: Title): Promise<void> {
  const dir = titleDir(userId, folder, t);
  await fs.mkdir(dir, { recursive: true });
  const jobs: Promise<void>[] = [];
  if (t.poster) jobs.push(saveImage(t.poster, join(dir, "poster.jpg")));
  if (t.banner) jobs.push(saveImage(t.banner, join(dir, "banner.jpg")));
  await Promise.allSettled(jobs);
}

async function saveImage(url: string, abs: string): Promise<void> {
  if (await exists(abs)) return;
  const res = await fetch(url);
  if (!res.ok || !res.body) return;
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.part`;
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
  await fs.rename(tmp, abs);
}
