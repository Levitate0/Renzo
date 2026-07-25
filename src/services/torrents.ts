import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Title, TorrentResult } from "../types.js";

const log = logger("torrents");

// AnimeTosho aggregates Nyaa/AniDex and exposes a clean JSON feed — no scraping.
const ANIMETOSHO_JSON = "https://feed.animetosho.org/json";

interface ToshoItem {
  title?: string;
  torrent_name?: string;
  info_hash?: string;
  magnet_uri?: string;
  seeders?: number | null;
  leechers?: number | null;
  torrent_downloaded_count?: number | null;
  total_size?: number | null;
  num_files?: number | null;
  timestamp?: number | null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
export function parseResolution(name: string): number {
  const n = name.toLowerCase();
  if (/(2160p|4k|uhd)/.test(n)) return 2160;
  if (/1080p?/.test(n)) return 1080;
  if (/720p?/.test(n)) return 720;
  if (/480p?/.test(n)) return 480;
  return 0;
}

export function isBatchName(name: string, episode?: number): boolean {
  const n = name.toLowerCase();
  const strong =
    /\bbatch\b/.test(n) ||
    /\bcomplete\b/.test(n) ||
    /\b\d{1,3}\s*[-~]\s*\d{1,3}\b/.test(n) || // 01-12 ranges
    /\bvol(?:ume)?\.?\s*\d/.test(n);
  if (strong) return true;
  // "Season"/"S2" alone doesn't make it a batch if it's clearly a single episode
  // (e.g. "[SubsPlease] Frieren S2 - 01"). Only treat as batch when no episode #.
  const seasony = /\bseason\b/.test(n) || /\b(s\d{1,2})\b(?!e)/.test(n);
  return seasony && episode === undefined;
}

/** Best-effort single-episode number from a release name. */
export function parseEpisode(name: string): number | undefined {
  // Avoid matching resolution/year. Look for " - 05 ", "E05", "Episode 5", "[05]".
  const patterns = [
    /(?:^|[\s_.\-])(?:e|ep|episode)[\s._]?(\d{1,3})(?:[\s_.\-v]|$)/i,
    /[-–][\s]?(\d{1,3})(?:[\s]?(?:v\d)?)?[\s]?(?:\[|\(|$|end)/i,
    /[\s._](\d{1,3})[\s._](?:\[|\()/,
  ];
  for (const re of patterns) {
    const m = name.match(re);
    if (m) {
      const num = Number.parseInt(m[1], 10);
      if (num > 0 && num < 2000) return num;
    }
  }
  return undefined;
}

function toResult(item: ToshoItem): TorrentResult | null {
  const title = item.torrent_name || item.title || "";
  const infoHash = (item.info_hash || "").toLowerCase();
  let magnet = item.magnet_uri || "";
  if (!magnet && infoHash) {
    magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;
  }
  if (!infoHash && !magnet) return null;
  const episode = parseEpisode(title);
  return {
    source: "animetosho",
    title,
    magnet,
    infoHash,
    sizeBytes: item.total_size ?? 0,
    seeders: item.seeders ?? 0,
    leechers: item.leechers ?? 0,
    resolution: parseResolution(title),
    isBatch: isBatchName(title, episode),
    episode,
    date: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : undefined,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchQuery(q: string, attempt = 0): Promise<TorrentResult[]> {
  const url = `${ANIMETOSHO_JSON}?${new URLSearchParams({ q, only_tor: "1" }).toString()}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 429 && attempt < 2) {
      await sleep(600 * (attempt + 1));
      return fetchQuery(q, attempt + 1);
    }
    if (!res.ok) {
      log.warn("animetosho", res.status, q);
      return [];
    }
    const items = (await res.json()) as ToshoItem[];
    return items.map(toResult).filter((x): x is TorrentResult => x !== null);
  } catch (e) {
    log.warn("query failed", q, String(e));
    return [];
  }
}

function dedupe(list: TorrentResult[]): TorrentResult[] {
  const seen = new Map<string, TorrentResult>();
  for (const r of list) {
    const key = r.infoHash || r.magnet;
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || r.seeders > prev.seeders) seen.set(key, r);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
interface RankOpts {
  episode?: number;   // desired episode (single-episode search)
  wantBatch?: boolean;
  preferredResolution?: number;
}

export function rank(results: TorrentResult[], opts: RankOpts = {}): TorrentResult[] {
  const pref = opts.preferredResolution ?? config.preferredResolution;
  const scored = results
    .filter((r) => r.seeders >= config.minSeeders || r.seeders === 0) // keep 0-seed (RD may still have it cached)
    .map((r) => {
      let score = 0;
      // Resolution: exact preferred is best, then closeness.
      if (r.resolution === pref) score += 1000;
      else if (r.resolution > 0) score += 1000 - Math.abs(r.resolution - pref) / 4;
      // Seeders (RD cache likelihood + health).
      score += Math.min(r.seeders, 200) * 3;
      // Batch preference.
      if (opts.wantBatch && r.isBatch) score += 400;
      if (!opts.wantBatch && opts.episode !== undefined) {
        if (r.episode === opts.episode) score += 600;
        else if (r.isBatch) score += 150; // a batch still contains the episode
        else if (r.episode !== undefined) score -= 400; // wrong single episode
      }
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.r);
}

// ---------------------------------------------------------------------------
// High-level searches
// ---------------------------------------------------------------------------
function titleNames(t: Title): string[] {
  const names = [t.english, t.romaji, ...t.synonyms].filter(Boolean) as string[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(n);
    }
    if (out.length >= 2) break; // english + romaji is plenty; keeps request count low
  }
  return out;
}

/** Fetch queries sequentially (AnimeTosho rate-limits bursts) and stop early. */
async function runQueries(queries: string[], enough = 60): Promise<TorrentResult[]> {
  const seen = new Set<string>();
  const out: TorrentResult[] = [];
  for (const q of queries) {
    const res = await fetchQuery(q);
    for (const r of res) {
      const key = r.infoHash || r.magnet;
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
    if (out.length >= enough) break;
    await sleep(150);
  }
  return dedupe(out);
}

export async function findForMovie(t: Title): Promise<TorrentResult[]> {
  const names = titleNames(t);
  const queries = [...names.map((n) => `${n} ${t.year ?? ""}`.trim()), ...names];
  return rank(await runQueries(queries), { wantBatch: false });
}

export async function findForEpisode(t: Title, episode: number): Promise<TorrentResult[]> {
  const pad = String(episode).padStart(2, "0");
  const names = titleNames(t);
  // Episode-specific queries first, then the bare name as a fallback.
  const queries = [...names.map((n) => `${n} ${pad}`), ...names];
  return rank(await runQueries(queries), { episode });
}

export async function findBatch(t: Title): Promise<TorrentResult[]> {
  const names = titleNames(t);
  const queries = [...names.map((n) => `${n} batch`), ...names.map((n) => `${n} complete`), ...names];
  return rank(await runQueries(queries), { wantBatch: true });
}
