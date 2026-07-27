import type { UserRecord } from "../types.js";
import type { RdTorrentInfo, RdLink, RdAccount } from "./realdebrid.js";
import * as rd from "./realdebrid.js";
import * as ad from "./alldebrid.js";

// A debrid provider (Real-Debrid or AllDebrid) — same shapes so the downloader
// treats them interchangeably.
export interface DebridApi {
  getInfo(token: string, id: string): Promise<RdTorrentInfo>;
  addAndPrepare(token: string, magnet: string, opts?: { episode?: number; episodes?: number[]; timeoutMs?: number }): Promise<RdTorrentInfo>;
  resolveEpisodeLink(token: string, info: RdTorrentInfo, episode?: number): Promise<RdLink>;
  deleteTorrent(token: string, id: string): Promise<void>;
  accountInfo(token: string): Promise<RdAccount | null>;
  isPremium(acct: RdAccount | null): boolean;
}

export type Provider = "realdebrid" | "alldebrid";
export const LABELS: Record<Provider, string> = { realdebrid: "Real-Debrid", alldebrid: "AllDebrid" };

export interface Resolved { name: Provider; token: string; api: DebridApi }

/** The debrid provider to use for a user: their preferred one if its credential
 *  is set, otherwise whichever they have connected. null if neither. */
export function resolveDebrid(user: UserRecord | undefined): Resolved | null {
  if (!user) return null;
  const rdTok = user.realDebridToken;
  const adKey = user.allDebridKey;
  const pref = user.debrid;
  if (pref === "alldebrid" && adKey) return { name: "alldebrid", token: adKey, api: ad };
  if (pref === "realdebrid" && rdTok) return { name: "realdebrid", token: rdTok, api: rd };
  if (rdTok) return { name: "realdebrid", token: rdTok, api: rd };
  if (adKey) return { name: "alldebrid", token: adKey, api: ad };
  return null;
}
