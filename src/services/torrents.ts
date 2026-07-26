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

/** Extract the release group, e.g. "[SubsPlease] …" -> "SubsPlease". */
export function parseReleaseGroup(name: string): string | undefined {
  // The leading [Group] token (skip if it's actually a resolution/hash).
  const lead = name.match(/^\s*\[([^\]]{2,40})\]/);
  if (lead && !/^\d{3,4}p$/i.test(lead[1]) && !/^[0-9a-f]{8}$/i.test(lead[1])) return lead[1].trim();
  // Trailing "-GROUP" (scene style), e.g. "…H.264-VARYG".
  const tail = name.match(/-([A-Za-z0-9]{2,20})(?:\.[a-z0-9]{2,4})?\s*$/);
  if (tail && !/^\d+$/.test(tail[1])) return tail[1].trim();
  return undefined;
}

/** Best-effort single-episode number from a release name. */
export function parseEpisode(name: string): number | undefined {
  // Avoid matching resolution/year. Look for "S01E05", " - 05 ", "E05", "[05]".
  const patterns = [
    /\bs\d{1,2}e(\d{1,3})\b/i,                                              // S01E05
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
    releaseGroup: parseReleaseGroup(title),
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
    log.warn("animetosho query failed", q, String(e));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Nyaa.si (RSS) — a second source. AnimeTosho lags/misses some new shows that
// Nyaa carries, so we query both and merge.
// ---------------------------------------------------------------------------
const NYAA_RSS = "https://nyaa.si/";
const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
];

function buildMagnet(infoHash: string, name: string): string {
  const tr = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${tr}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");
}

function parseSize(s: string): number {
  const m = s.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const pow = { B: 0, KIB: 1, MIB: 2, GIB: 3, TIB: 4, KB: 1, MB: 2, GB: 3, TB: 4 }[unit] ?? 0;
  return Math.round(n * 1024 ** pow);
}

function parseNyaa(xml: string): TorrentResult[] {
  const out: TorrentResult[] = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const raw of items) {
    const chunk = raw.split(/<\/item>/i)[0];
    const title = decodeEntities(
      (chunk.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || "",
    );
    const infoHash = ((chunk.match(/<nyaa:infoHash>([a-f0-9]+)<\/nyaa:infoHash>/i) || [])[1] || "").toLowerCase();
    if (!title || !infoHash) continue;
    const episode = parseEpisode(title);
    out.push({
      source: "nyaa",
      title,
      magnet: buildMagnet(infoHash, title),
      infoHash,
      releaseGroup: parseReleaseGroup(title),
      sizeBytes: parseSize((chunk.match(/<nyaa:size>([^<]+)<\/nyaa:size>/i) || [])[1] || ""),
      seeders: Number.parseInt((chunk.match(/<nyaa:seeders>(\d+)/i) || [])[1] || "0", 10),
      leechers: Number.parseInt((chunk.match(/<nyaa:leechers>(\d+)/i) || [])[1] || "0", 10),
      resolution: parseResolution(title),
      isBatch: isBatchName(title, episode),
      episode,
      date: (chunk.match(/<pubDate>([^<]+)<\/pubDate>/i) || [])[1],
    });
  }
  return out;
}

async function fetchNyaaQuery(q: string, attempt = 0): Promise<TorrentResult[]> {
  // c=1_2 = Anime (English-translated); sorted by seeders desc.
  const url = `${NYAA_RSS}?${new URLSearchParams({ page: "rss", q, c: "1_2", f: "0", s: "seeders", o: "desc" }).toString()}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/rss+xml, application/xml, text/xml" } });
    if (res.status === 429 && attempt < 2) {
      await sleep(600 * (attempt + 1));
      return fetchNyaaQuery(q, attempt + 1);
    }
    if (!res.ok) {
      log.warn("nyaa", res.status, q);
      return [];
    }
    return parseNyaa(await res.text());
  } catch (e) {
    log.warn("nyaa query failed", q, String(e));
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
  preferredGroup?: string; // user-chosen release group — pinned to the top
}

function groupEq(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function rank(results: TorrentResult[], opts: RankOpts = {}): TorrentResult[] {
  const pref = opts.preferredResolution ?? config.preferredResolution;
  const scored = results
    .filter((r) => r.seeders >= config.minSeeders || r.seeders === 0) // keep 0-seed (RD may still have it cached)
    .map((r) => {
      let score = 0;
      // Chosen release group wins decisively (user picked it for all episodes).
      if (opts.preferredGroup && groupEq(r.releaseGroup, opts.preferredGroup)) score += 5000;
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

/** Distinct release groups present in a result set, ranked by usefulness. */
export interface ProviderInfo {
  group: string;
  count: number;
  maxSeeders: number;
  resolutions: number[];
}
export function providersFrom(results: TorrentResult[]): ProviderInfo[] {
  const map = new Map<string, ProviderInfo>();
  for (const r of results) {
    if (!r.releaseGroup) continue;
    const key = r.releaseGroup;
    const p = map.get(key.toLowerCase()) ?? { group: key, count: 0, maxSeeders: 0, resolutions: [] };
    p.count++;
    p.maxSeeders = Math.max(p.maxSeeders, r.seeders);
    if (r.resolution && !p.resolutions.includes(r.resolution)) p.resolutions.push(r.resolution);
    map.set(key.toLowerCase(), p);
  }
  return [...map.values()].sort((a, b) => b.maxSeeders - a.maxSeeders || b.count - a.count);
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

/** Query BOTH sources (AnimeTosho + Nyaa) per term, sequentially, stop early. */
async function runQueries(queries: string[], enough = 60): Promise<TorrentResult[]> {
  const seen = new Set<string>();
  const out: TorrentResult[] = [];
  let tosho = 0;
  let nyaa = 0;
  for (const q of queries) {
    const [a, b] = await Promise.all([fetchQuery(q), fetchNyaaQuery(q)]);
    tosho += a.length;
    nyaa += b.length;
    for (const r of [...a, ...b]) {
      const key = r.infoHash || r.magnet;
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
    if (out.length >= enough) break;
    await sleep(150);
  }
  log.info(`search "${queries[0]}" -> ${out.length} unique (animetosho ${tosho}, nyaa ${nyaa})`);
  return dedupe(out);
}

export async function findForMovie(t: Title, preferredGroup?: string): Promise<TorrentResult[]> {
  const names = titleNames(t);
  const queries = [...names.map((n) => `${n} ${t.year ?? ""}`.trim()), ...names];
  return rank(await runQueries(queries), { wantBatch: false, preferredGroup });
}

export async function findForEpisode(t: Title, episode: number, preferredGroup?: string): Promise<TorrentResult[]> {
  const pad = String(episode).padStart(2, "0");
  const names = titleNames(t);
  // Episode-specific queries first, then the bare name as a fallback.
  const queries = [...names.map((n) => `${n} ${pad}`), ...names];
  return rank(await runQueries(queries), { episode, preferredGroup });
}

export async function findBatch(t: Title, preferredGroup?: string): Promise<TorrentResult[]> {
  const names = titleNames(t);
  const queries = [...names.map((n) => `${n} batch`), ...names.map((n) => `${n} complete`), ...names];
  return rank(await runQueries(queries), { wantBatch: true, preferredGroup });
}

/** List the release-group "providers" available for a title (for the picker). */
export async function listProviders(t: Title): Promise<ProviderInfo[]> {
  const names = titleNames(t);
  const queries = t.type === "movie"
    ? [...names.map((n) => `${n} ${t.year ?? ""}`.trim()), ...names]
    : [...names.map((n) => `${n} 01`), ...names];
  return providersFrom(await runQueries(queries, 120));
}
