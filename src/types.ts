export type MediaType = "movie" | "series";

export type DownloadStatus =
  | "wanted"
  | "searching"
  | "queued"      // added to Real-Debrid, waiting for RD to cache/finish
  | "downloading" // pulling the file from RD to local disk
  | "downloaded"
  | "failed";

/** A torrent candidate returned by a search source. */
export interface TorrentResult {
  source: string;
  title: string;
  magnet: string;
  infoHash: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  resolution: number; // 2160 / 1080 / 720 / 480 / 0=unknown
  isBatch: boolean;
  episode?: number;   // parsed absolute/season episode number, if any
  date?: string;
}

/** An anime title tracked in the library (keyed by AniList id). */
export interface Title {
  id: number;             // AniList id
  malId?: number;         // MyAnimeList id (for MAL scrobbling)
  type: MediaType;
  romaji: string;
  english?: string;
  synonyms: string[];
  year?: number;
  episodeCount?: number;  // total episodes (series)
  description?: string;
  genres: string[];
  poster?: string;        // cover image url (AniList)
  banner?: string;
  airingStatus?: string;      // FINISHED | RELEASING | NOT_YET_RELEASED | ...
  nextAiringEpisode?: number; // next episode number to air (while RELEASING)
  autoDownload?: boolean;     // auto-grab new episodes on the schedule
  autoFromTracker?: boolean;  // autoDownload=true came from tracker sync (so sync may also clear it)
  lists?: string[];           // DEPRECATED: lists moved to UserRecord.lists (per-user)
  addedAt: string;
  episodes: EpisodeRecord[];
}

export interface EpisodeRecord {
  number: number;         // 1 for movies
  title?: string;
  status: DownloadStatus;
  filePath?: string;      // relative to LIBRARY_DIR
  sizeBytes?: number;
  progress?: number;      // 0..1 while downloading
  rdTorrentId?: string;
  magnet?: string;
  updatedAt: string;
}

/** A running/queued download job. */
export interface DownloadJob {
  id: string;
  titleId: number;
  userId: string;        // which user's Real-Debrid creds to use
  episode: number;
  status: DownloadStatus;
  progress: number;
  message?: string;
  magnet: string;
  rdTorrentId?: string;
  filePath?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------
export interface UserRecord {
  id: string;
  username: string;
  passHash: string;               // scrypt "salt:hash" (hex)
  role: "admin" | "user";
  createdAt: string;
  library?: number[];              // AniList ids in MY library (metadata is shared)
  eps?: Record<string, EpisodeRecord>; // "titleId:ep" -> MY download state (isolated per user)
  lists: Record<string, number[]>; // list name -> AniList ids (per-user)
  folders?: string[];              // MY named folders/collections (physical, ordered)
  titleFolder?: Record<string, string>; // titleId -> folder name (default folder if unset)
  realDebridToken?: string;        // per-user RD creds — required to stream/download
  anilistToken?: string;           // per-user tracker connections
  malToken?: string;
}

export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface DbShape {
  titles: Title[];
  jobs: DownloadJob[];
  users: UserRecord[];
  sessions: SessionRecord[];
}
