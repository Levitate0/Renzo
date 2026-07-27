import { logger } from "../logger.js";
import { parseEpisode } from "./torrents.js";
import type { RdTorrentInfo, RdLink, RdAccount } from "./realdebrid.js";

// AllDebrid provider — conforms to the same shapes as the Real-Debrid service so
// the downloader can use either interchangeably (see debrid.ts). AllDebrid's flow:
// upload magnet -> poll magnet/status until Ready -> unlock the chosen file link.
const log = logger("alldebrid");
const BASE = "https://api.alldebrid.com/v4";
const AGENT = "renzo";
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i;

interface AdResp<T> { status: string; data?: T; error?: { code: string; message: string } }

async function ad<T>(key: string, path: string, params: Record<string, string> = {}): Promise<T> {
  if (!key) throw new Error("AllDebrid is not connected for this account");
  // AllDebrid accepts the key as an `apikey` param (documented) or a Bearer header;
  // send both for compatibility. `agent` (app name) is required.
  const qs = new URLSearchParams({ agent: AGENT, apikey: key, ...params }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  let json: AdResp<T>;
  try { json = JSON.parse(text) as AdResp<T>; } catch { throw new Error(`AD ${path} -> ${res.status}: ${text.slice(0, 160)}`); }
  if (json.status !== "success" || json.error) {
    throw new Error(`AD ${path} -> ${json.error?.code ?? res.status}: ${json.error?.message ?? text.slice(0, 160)}`);
  }
  return json.data as T;
}

interface AdMagnetLink { link: string; filename: string; size: number }
interface AdMagnet { id: number | string; status?: string; statusCode?: number; filename?: string; size?: number; links?: AdMagnetLink[] }

// Map an AllDebrid magnet to the shared RdTorrentInfo shape.
function toInfo(m: AdMagnet): RdTorrentInfo {
  const links = m.links ?? [];
  const ready = (m.status ?? "").toLowerCase() === "ready" || m.statusCode === 4 || links.length > 0;
  return {
    id: String(m.id),
    filename: m.filename ?? "",
    hash: "",
    bytes: m.size ?? 0,
    status: ready ? "downloaded" : (m.status ?? "downloading"),
    progress: ready ? 100 : 0,
    files: links.map((l, i) => ({ id: i, path: l.filename, bytes: l.size, selected: 1 })),
    links: links.map((l) => l.link),
  };
}

export async function getInfo(key: string, id: string): Promise<RdTorrentInfo> {
  const data = await ad<{ magnets: AdMagnet | AdMagnet[] }>(key, "/magnet/status", { id });
  const m = Array.isArray(data.magnets) ? data.magnets[0] : data.magnets;
  return toInfo(m);
}

export async function deleteTorrent(key: string, id: string): Promise<void> {
  await ad(key, "/magnet/delete", { id }).catch(() => {});
}

export async function addAndPrepare(
  key: string,
  magnet: string,
  opts: { episode?: number; episodes?: number[]; timeoutMs?: number } = {},
): Promise<RdTorrentInfo> {
  const up = await ad<{ magnets: { id: number | string; ready?: boolean; error?: unknown }[] }>(
    key, "/magnet/upload", { "magnets[]": magnet },
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
  const data = await ad<{ link: string; filename: string; filesize: number }>(key, "/link/unlock", { link: info.links[idx] });
  return { download: data.link, filename: data.filename, filesize: data.filesize ?? 0 };
}

export async function accountInfo(key: string): Promise<RdAccount | null> {
  try {
    const data = await ad<{ user: { username: string; isPremium: boolean; premiumUntil?: number } }>(key, "/user");
    const u = data.user;
    return { username: u.username, premium: u.isPremium ? 1 : 0, type: u.isPremium ? "premium" : "free" };
  } catch (e) { log.warn("account check failed", String(e)); return null; }
}

export function isPremium(info: RdAccount | null): boolean {
  return !!info && (info.type === "premium" || info.premium > 0);
}
