import { config } from "../config.js";
import { logger } from "../logger.js";
import { parseEpisode } from "./torrents.js";

const log = logger("captions");
const JIMAKU = "https://jimaku.cc/api";

export interface SubtitleTrack {
  id: string;        // opaque; encodes remote url + format for the proxy route
  label: string;
  lang: string;      // BCP-47-ish ("en", "ja")
  format: "srt" | "ass" | "vtt";
  remoteUrl: string;
}

// ---------------------------------------------------------------------------
// Jimaku — community anime subtitles, keyed by AniList id (best source for JP)
// ---------------------------------------------------------------------------
// Per-user key (Settings → Credentials) takes priority; env is a shared fallback.
async function jimaku<T>(path: string, key?: string): Promise<T | null> {
  const apiKey = key || config.jimakuApiKey;
  if (!apiKey) return null;
  try {
    const res = await fetch(`${JIMAKU}${path}`, {
      headers: { Authorization: apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      log.warn("jimaku", res.status, path);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    log.warn("jimaku failed", path, String(e));
    return null;
  }
}

/** Validate a Jimaku API key (used by the settings save). Only a definitive
 *  401 (Jimaku's "bad API key") rejects it — a rate-limit, IP/Cloudflare 403,
 *  5xx, or network blip must NOT reject a key the user actually copied, so those
 *  are accepted (the key is still stored and used at download time). */
export async function jimakuKeyValid(key: string): Promise<boolean> {
  if (!key) return false;
  try {
    const res = await fetch(`${JIMAKU}/user`, {
      headers: { Authorization: key, accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return false;       // definitively invalid
    if (!res.ok) log.warn("jimaku key check inconclusive", res.status); // accept anyway
    return true;
  } catch (e) { log.warn("jimaku key check failed (accepting)", String(e)); return true; }
}

function fmtOf(name: string): SubtitleTrack["format"] {
  if (/\.ass$/i.test(name)) return "ass";
  if (/\.vtt$/i.test(name)) return "vtt";
  return "srt";
}

function langOf(name: string): string {
  const n = name.toLowerCase();
  if (/(\.|_|\b)(en|eng|english)(\.|_|\b)/.test(n)) return "en";
  if (/(\.|_|\b)(ja|jp|jpn|japanese)(\.|_|\b)/.test(n)) return "ja";
  if (/(\.|_|\b)(es|spa|spanish)(\.|_|\b)/.test(n)) return "es";
  return "en"; // anime subs are overwhelmingly English by default
}

/** Find subtitle tracks for a given AniList id + optional episode. `key` is the
 *  requesting user's Jimaku API key (per-user credential). */
export async function findSubtitles(anilistId: number, episode?: number, key?: string): Promise<SubtitleTrack[]> {
  const entries = await jimaku<{ id: number; name: string }[]>(
    `/entries/search?anilist_id=${anilistId}`, key,
  );
  if (!entries?.length) return [];

  const tracks: SubtitleTrack[] = [];
  for (const entry of entries.slice(0, 3)) {
    const files = await jimaku<{ name: string; url: string; size: number }[]>(
      `/entries/${entry.id}/files`, key,
    );
    if (!files) continue;
    for (const f of files) {
      if (!/\.(srt|ass|ssa|vtt)$/i.test(f.name)) continue;
      const ep = parseEpisode(f.name);
      if (episode !== undefined && ep !== undefined && ep !== episode) continue;
      const lang = langOf(f.name);
      if (config.subtitleLangs.length && !config.subtitleLangs.includes(lang)) continue;
      tracks.push({
        id: Buffer.from(`${f.url}::${fmtOf(f.name)}`).toString("base64url"),
        label: `${entry.name} — ${f.name}`.slice(0, 80),
        lang,
        format: fmtOf(f.name),
        remoteUrl: f.url,
      });
    }
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Fetch + convert to WebVTT (what the built-in HTML5 player understands)
// ---------------------------------------------------------------------------
export function decodeTrackId(id: string): { url: string; format: string } {
  const [url, format] = Buffer.from(id, "base64url").toString("utf8").split("::");
  return { url, format: format || "srt" };
}

// The track id encodes a remote URL; without a host allowlist this endpoint
// would be an SSRF proxy ("fetch any URL as the server"). Lock it to known
// subtitle sources over https.
const ALLOWED_SUB_HOSTS = ["jimaku.cc", "opensubtitles.com", "opensubtitles.org"];
function assertAllowedSubtitleUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid subtitle url");
  }
  const ok =
    u.protocol === "https:" &&
    ALLOWED_SUB_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  if (!ok) throw new Error("subtitle host not allowed");
}

/** Fetch with manual redirects, re-validating the allowlist on every hop (SSRF-safe). */
async function fetchAllowlisted(startUrl: string, key?: string): Promise<Response> {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    assertAllowedSubtitleUrl(url);
    const u = new URL(url);
    // jimaku.cc download links may require the user's key; other allowlisted CDNs don't.
    const headers = (key && (u.hostname === "jimaku.cc" || u.hostname.endsWith(".jimaku.cc"))) ? { Authorization: key } : undefined;
    const res = await fetch(url, { redirect: "manual", headers });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("redirect without location");
      url = new URL(loc, url).toString(); // resolve relative, re-check next loop
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export async function fetchAsVtt(id: string, key?: string): Promise<string> {
  const { url, format } = decodeTrackId(id);
  const res = await fetchAllowlisted(url, key);
  if (!res.ok) throw new Error(`subtitle fetch ${res.status}`);
  const raw = await res.text();
  if (format === "vtt") return raw.startsWith("WEBVTT") ? raw : `WEBVTT\n\n${raw}`;
  if (format === "ass" || format === "ssa") return assToVtt(raw);
  return srtToVtt(raw);
}

function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^﻿/, "")
    // 00:00:01,000 --> 00:00:04,000  =>  use dots for ms
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`.trim() + "\n";
}

/** Minimal ASS -> VTT: extract Dialogue lines, strip styling override tags. */
function assToVtt(ass: string): string {
  const lines = ass.replace(/\r+/g, "").split("\n");
  const cues: string[] = [];
  const fmtLine = lines.find((l) => l.startsWith("Format:") && /Start/.test(l));
  const cols = fmtLine ? fmtLine.replace(/^Format:\s*/, "").split(",").map((s) => s.trim()) : [];
  const iStart = cols.indexOf("Start");
  const iEnd = cols.indexOf("End");
  const iText = cols.indexOf("Text");
  for (const l of lines) {
    if (!l.startsWith("Dialogue:")) continue;
    const parts = l.replace(/^Dialogue:\s*/, "").split(",");
    const start = assTime(parts[iStart >= 0 ? iStart : 1]);
    const end = assTime(parts[iEnd >= 0 ? iEnd : 2]);
    const text = parts.slice(iText >= 0 ? iText : 9).join(",")
      .replace(/\{[^}]*\}/g, "")  // drawing/override tags
      .replace(/\\N/gi, "\n")
      .trim();
    if (start && end && text) cues.push(`${start} --> ${end}\n${text}`);
  }
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

function assTime(t: string): string | null {
  // H:MM:SS.cc -> HH:MM:SS.mmm
  const m = t?.trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return null;
  const [, h, mm, ss, cc] = m;
  return `${h.padStart(2, "0")}:${mm}:${ss}.${cc}0`;
}
