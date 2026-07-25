import { logger } from "../logger.js";
import { parseEpisode } from "./torrents.js";

const log = logger("realdebrid");
const BASE = "https://api.real-debrid.com/rest/1.0";
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i;

export interface RdFile {
  id: number;
  path: string;
  bytes: number;
  selected: number;
}
export interface RdTorrentInfo {
  id: string;
  filename: string;
  hash: string;
  bytes: number;
  status: string; // magnet_conversion | waiting_files_selection | queued | downloading | downloaded | error | ...
  progress: number; // 0..100
  files: RdFile[];
  links: string[];
}
export interface RdLink {
  download: string; // direct streamable/downloadable URL
  filename: string;
  filesize: number;
  mimeType?: string;
}

async function rd<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  if (!token) throw new Error("Real-Debrid is not connected for this account");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`RD ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

export async function addMagnet(token: string, magnet: string): Promise<string> {
  const r = await rd<{ id: string; uri: string }>(token, "/torrents/addMagnet", form({ magnet }));
  return r.id;
}

export async function getInfo(token: string, id: string): Promise<RdTorrentInfo> {
  return rd<RdTorrentInfo>(token, `/torrents/info/${id}`);
}

export async function selectFiles(token: string, id: string, fileIds: string): Promise<void> {
  await rd<void>(token, `/torrents/selectFiles/${id}`, form({ files: fileIds }));
}

export async function deleteTorrent(token: string, id: string): Promise<void> {
  await rd<void>(token, `/torrents/delete/${id}`, { method: "DELETE" }).catch(() => {});
}

export async function unrestrict(token: string, link: string): Promise<RdLink> {
  return rd<RdLink>(token, "/unrestrict/link", form({ link }));
}

/** Add magnet, select the relevant video files, and wait until RD has it ready. */
export async function addAndPrepare(
  token: string,
  magnet: string,
  opts: { episode?: number; episodes?: number[]; timeoutMs?: number } = {},
): Promise<RdTorrentInfo> {
  const id = await addMagnet(token, magnet);
  // Wait for file listing to be available, then choose video files.
  let info = await pollUntil(token, id, (i) => i.files.length > 0 || i.status === "downloaded", 20_000);

  const videoFiles = info.files.filter((f) => VIDEO_EXT.test(f.path));
  const pool = videoFiles.length ? videoFiles : info.files;

  // File selection within batches:
  //  - `episodes` (a season grab): select every still-wanted episode so ONE
  //    RD torrent serves all the episode jobs.
  //  - `episode` (interactive stream): select just that file to avoid pulling
  //    a whole 24-episode batch onto RD when we only need one.
  let chosen = pool;
  if (opts.episodes?.length && videoFiles.length > 1) {
    const want = new Set(opts.episodes);
    const match = videoFiles.filter((f) => {
      const n = parseEpisode(f.path);
      return n !== undefined && want.has(n);
    });
    if (match.length) chosen = match;
  } else if (opts.episode !== undefined && videoFiles.length > 1) {
    const match = videoFiles.filter((f) => parseEpisode(f.path) === opts.episode);
    if (match.length) chosen = match;
  }
  const ids = chosen.map((f) => f.id).join(",") || "all";
  await selectFiles(token, id, ids);

  info = await pollUntil(
    token,
    id,
    (i) => i.status === "downloaded" || i.status === "error" || i.status === "dead",
    opts.timeoutMs ?? 90_000,
  );
  if (info.status !== "downloaded") {
    log.warn(`torrent ${id} not ready (status=${info.status}, progress=${info.progress}%)`);
  }
  return info;
}

async function pollUntil(
  token: string,
  id: string,
  done: (i: RdTorrentInfo) => boolean,
  timeoutMs: number,
): Promise<RdTorrentInfo> {
  const start = Date.now();
  let info = await getInfo(token, id);
  while (!done(info) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    info = await getInfo(token, id);
  }
  return info;
}

/**
 * Map a prepared torrent to a direct link for the requested episode.
 * links[] correspond, in order, to the *selected* files.
 */
export async function resolveEpisodeLink(token: string, info: RdTorrentInfo, episode?: number): Promise<RdLink> {
  if (!info.links.length) throw new Error("Real-Debrid has no links yet for this torrent");
  const selected = info.files.filter((f) => f.selected === 1);

  let idx = 0;
  if (episode !== undefined && selected.length === info.links.length && selected.length > 1) {
    const found = selected.findIndex((f) => parseEpisode(f.path) === episode);
    // Wrong-file beats no-file? No: serving a different episode is worse than
    // failing over to the next torrent candidate.
    if (found < 0) throw new Error(`episode ${episode} not present in torrent files`);
    idx = found;
  } else if (selected.length === info.links.length && selected.length > 1) {
    // No episode target: pick the largest file.
    let best = 0;
    selected.forEach((f, i) => {
      if (f.bytes > selected[best].bytes) best = i;
    });
    idx = best;
  }
  return unrestrict(token, info.links[Math.min(idx, info.links.length - 1)]);
}

export interface RdAccount {
  username: string;
  premium: number; // seconds of premium remaining
  type: string;    // "premium" | "free"
  expiration?: string;
}

/** Validate a token and return account status (premium check for the UI). */
export async function accountInfo(token: string): Promise<RdAccount | null> {
  try {
    return await rd<RdAccount>(token, "/user");
  } catch (e) {
    log.warn("account check failed", String(e));
    return null;
  }
}

export async function accountOk(token: string): Promise<boolean> {
  const info = await accountInfo(token);
  return Boolean(info);
}

export function isPremium(info: RdAccount | null): boolean {
  return Boolean(info && (info.premium > 0 || info.type === "premium"));
}
