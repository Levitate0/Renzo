// ---------------------------------------------------------------------------
// One render model for the title page, fed from either the online detail
// payload (GET /titles/:id) or the cached offline detail (lib/offline
// offlineDetail) — so both paint identically, exactly like the old
// paintDetail(d, { offline }) sharing (public/app.js:835).
// ---------------------------------------------------------------------------

import type { OfflineTitleDetail } from "@/lib/offline";
import type { EpisodeInfo, SeasonRef, TitleDetail } from "@/lib/types";

export interface DetailModel {
  id: number;
  type: string; // "movie" | "series"
  english?: string;
  romaji?: string;
  year: number | null;
  poster: string;
  banner: string;
  description: string;
  genres: string[];
  episodesTotal: number;
  duration: number | null;
  watchedThrough: number;
  episodeList: EpisodeInfo[];
  seasons: SeasonRef[];
  seasonNum: number | null;
  seasonPart: number | null;
  seasonKind: string | null;
  seasonFormat: string | null;
  autoDownload: boolean;
  lists: string[];
  folder: string;
  folders: string[];
  provider: string | null;
}

export function modelFromOnline(d: TitleDetail): DetailModel {
  return {
    id: d.id,
    type: d.type,
    english: d.english,
    romaji: d.romaji,
    year: d.year ?? null,
    poster: d.poster || "",
    banner: d.banner || "",
    description: d.description || "",
    genres: d.genres || [],
    episodesTotal: d.episodesTotal || (d.episodeList || []).length,
    duration: d.duration ?? null,
    watchedThrough: d.watchedThrough || 0,
    episodeList: d.episodeList || [],
    seasons: d.seasons || [],
    seasonNum: d.seasonNum ?? null,
    seasonPart: d.seasonPart ?? null,
    seasonKind: d.seasonKind ?? null,
    seasonFormat: d.seasonFormat ?? null,
    autoDownload: !!d.autoDownload,
    lists: d.lists || [],
    folder: d.folder || "",
    folders: d.folders || [],
    provider: d.provider ?? null,
  };
}

export function modelFromOffline(d: OfflineTitleDetail): DetailModel {
  return {
    id: d.id,
    type: d.type || "series",
    english: d.english,
    romaji: d.romaji,
    year: d.year ?? null,
    poster: d.poster || "",
    banner: d.banner || "",
    description: d.description || "",
    genres: d.genres || [],
    episodesTotal: d.episodesTotal || d.episodeList.length,
    duration: d.duration ?? null,
    watchedThrough: d.watchedThrough || 0,
    episodeList: d.episodeList.map((e) => ({
      number: e.number,
      status: "",
      hasFile: e.hasFile,
      progress: 0,
      aired: e.aired !== false,
      thumbnail: e.thumbnail,
      epTitle: e.epTitle,
    })),
    seasons: [],
    seasonNum: d.seasonNum ?? null,
    seasonPart: d.seasonPart ?? null,
    seasonKind: d.seasonKind ?? null,
    seasonFormat: d.seasonFormat ?? null,
    autoDownload: false,
    lists: [],
    folder: "",
    folders: [],
    provider: null,
  };
}
