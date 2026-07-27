import { logger } from "../logger.js";
import { parseEpisode } from "./torrents.js";
import type { RdTorrentInfo, RdLink, RdAccount } from "./realdebrid.js";

// AllDebrid provider — conforms to the same shapes as the Real-Debrid service so
// the downloader can use either interchangeably (see debrid.ts). AllDebrid's flow:
//   upload magnet -> poll magnet/status (v4.1) until Ready -> magnet/files for the
//   file tree -> unlock the chosen file's link.
// Auth is a Bearer token (the old ?apikey=/agent= query scheme was discontinued).
// Note: /magnet/status is on v4.1; other endpoints stay on v4. magnet/status no
// longer carries file links — magnet/files is a dedicated endpoint now.
const log = logger("alldebrid");
const BASE = "https://api.alldebrid.com";
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i;
const READY_CODE = 4; // AllDebrid statusCode 4 = "Ready"

interface AdResp<T> { status: string; data?: T; error?: { code: string; message: string } }

type AdParams = Record<string, string | string[]>;

async function ad<T>(key: string, path: string, params: AdParams = {}, method: "GET" | "POST" = "GET"): Promise<T> {
  if (!key) throw new Error("AllDebrid is not connected for this account");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) usp.append(k, item);
    else usp.append(k, v);
  }
  let url = `${BASE}${path}`;
  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = usp.toString();
  } else {
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json: AdResp<T>;
  try { json = JSON.parse(text) as AdResp<T>; } catch { throw new Error(`AD ${path} -> ${res.status}: ${text.slice(0, 160)}`); }
  if (json.status !== "success" || json.error) {
    throw new Error(`AD ${path} -> ${json.error?.code ?? res.status}: ${json.error?.message ?? text.slice(0, 160)}`);
  }
  return json.data as T;
}

interface AdStatus { id: number | string; filename?: string; size?: number; status?: string; statusCode?: number }
// magnet/files returns a tree: leaves carry `l` (link); folders carry `e` (entries).
interface AdFileNode { n: string; s?: number; l?: string; e?: AdFileNode[] }
interface AdFile { name: string; size: number; link: string }

function flattenFiles(nodes: AdFileNode[] | undefined, out: AdFile[] = []): AdFile[] {
  for (const node of nodes ?? []) {
    if (node.e) flattenFiles(node.e, out);
    else if (node.l) out.push({ name: node.n, size: node.s ?? 0, link: node.l });
  }
  return out;
}

// Fetch the file tree for a ready magnet and flatten it into index-aligned
// files[]/links[] arrays matching RdTorrentInfo.
async function fetchFiles(key: string, id: string): Promise<AdFile[]> {
  const data = await ad<{ magnets: { id: number | string; files?: AdFileNode[] }[] }>(
    key, "/v4/magnet/files", { "id[]": id }, "POST",
  );
  const m = Array.isArray(data.magnets) ? data.magnets[0] : undefined;
  return flattenFiles(m?.files);
}

function toInfo(m: AdStatus, files: AdFile[]): RdTorrentInfo {
  const ready = (m.status ?? "").toLowerCase() === "ready" || m.statusCode === READY_CODE;
  return {
    id: String(m.id),
    filename: m.filename ?? "",
    hash: "",
    bytes: m.size ?? 0,
    status: ready ? "downloaded" : (m.status ?? "downloading"),
    progress: ready ? 100 : 0,
    files: files.map((f, i) => ({ id: i, path: f.name, bytes: f.size, selected: 1 })),
    links: files.map((f) => f.link),
  };
}

export async function getInfo(key: string, id: string): Promise<RdTorrentInfo> {
  const data = await ad<{ magnets: AdStatus | AdStatus[] }>(key, "/v4.1/magnet/status", { id }, "POST");
  const m = Array.isArray(data.magnets) ? data.magnets[0] : data.magnets;
  const ready = (m.status ?? "").toLowerCase() === "ready" || m.statusCode === READY_CODE;
  let files: AdFile[] = [];
  if (ready) {
    try { files = await fetchFiles(key, String(m.id)); }
    catch (e) { log.warn("magnet/files failed", String(e)); }
  }
  return toInfo(m, files);
}

export async function deleteTorrent(key: string, id: string): Promise<void> {
  await ad(key, "/v4/magnet/delete", { id }, "POST").catch(() => {});
}

export async function addAndPrepare(
  key: string,
  magnet: string,
  opts: { episode?: number; episodes?: number[]; timeoutMs?: number } = {},
): Promise<RdTorrentInfo> {
  const up = await ad<{ magnets: { id: number | string; ready?: boolean; error?: unknown }[] }>(
    key, "/v4/magnet/upload", { "magnets[]": magnet }, "POST",
  );
  const first = up.magnets?.[0];
  if (!first || (first as { error?: unknown }).error) throw new Error("AllDebrid rejected the magnet");
  const id = String(first.id);

  // Poll until the magnet is Ready (cached / finished) or we time out.
  const start = Date.now();
  const limit = opts.timeoutMs ?? 90_000;
  let info = await getInfo(key, id);
  while (info.status !== "downloaded" && Date.now() - start < limit) {
    await new Promise((r) => setTimeout(r, 2000));
    info = await getInfo(key, id);
  }
  if (info.status !== "downloaded") log.warn(`magnet ${id} not ready (status=${info.status})`);
  return info;
}

// Pick the file for the requested episode (largest file if no target), then unlock.
export async function resolveEpisodeLink(key: string, info: RdTorrentInfo, episode?: number): Promise<RdLink> {
  if (!info.links.length) throw new Error("AllDebrid has no links yet for this magnet");
  const videos = info.files.map((f, i) => ({ f, i })).filter(({ f }) => VIDEO_EXT.test(f.path));
  const pool = videos.length ? videos : info.files.map((f, i) => ({ f, i }));

  let idx = pool[0].i;
  if (episode !== undefined && pool.length > 1) {
    const found = pool.find(({ f }) => parseEpisode(f.path) === episode);
    if (!found) throw new Error(`episode ${episode} not present in magnet files`);
    idx = found.i;
  } else if (pool.length > 1) {
    idx = pool.reduce((best, cur) => (cur.f.bytes > best.f.bytes ? cur : best)).i;
  }
  const data = await ad<{ link: string; filename: string; filesize: number }>(
    key, "/v4/link/unlock", { link: info.links[idx] }, "POST",
  );
  return { download: data.link, filename: data.filename, filesize: data.filesize ?? 0 };
}

export async function accountInfo(key: string): Promise<RdAccount | null> {
  try {
    const data = await ad<{ user: { username: string; isPremium: boolean; premiumUntil?: number } }>(key, "/v4/user");
    const u = data.user;
    return { username: u.username, premium: u.isPremium ? 1 : 0, type: u.isPremium ? "premium" : "free" };
  } catch (e) { log.warn("account check failed", String(e)); return null; }
}

export function isPremium(info: RdAccount | null): boolean {
  return !!info && (info.type === "premium" || info.premium > 0);
}
