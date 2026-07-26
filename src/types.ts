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
  releaseGroup?: string; // e.g. "SubsPlease", "Erai-raws"
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
export type Role = "owner" | "manager" | "user";

export interface UserRecord {
  id: string;
  username: string;
  passHash: string;               // scrypt "salt:hash" (hex)
  role: Role;
  email?: string;
  createdAt: string;
  library?: number[];              // AniList ids in MY library (metadata is shared)
  eps?: Record<string, EpisodeRecord>; // "titleId:ep" -> MY download state (isolated per user)
  lists: Record<string, number[]>; // list name -> AniList ids (per-user)
  folders?: string[];              // MY named folders/collections (physical, ordered)
  titleFolder?: Record<string, string>; // titleId -> folder name (default folder if unset)
  titleProvider?: Record<string, string>; // titleId -> preferred release group (all eps/seasons)
  progress?: Record<string, number>;   // titleId -> last episode watched (for "up next")
  history?: WatchHistoryEntry[];        // recently-watched titles, most-recent first
  watchIds?: Record<string, string>;   // titleId -> stable per-user watch token (for saved titles)
  updatesSeen?: Record<string, number>; // titleId -> aired-count last acknowledged in Updates
  realDebridToken?: string;        // per-user RD creds — required to stream/download
  apiKey?: string;                 // per-user API key (Jellyfin plugin / external clients)
  downloadsDenied?: boolean;       // staff can block this user from ALL downloads (streaming still allowed)
  autoStatus?: boolean;            // auto-manage tracking status as you watch (default on; undefined = on)
  ccLang?: string;                 // preferred subtitle/caption language ("en", "ja", … or "off")
  autoTitles?: number[];           // titles this user auto-downloads to THEIR OWN Real-Debrid
  addDefaults?: AddDefaults;       // states applied when a title first enters this user's library
  anilistToken?: string;           // per-user tracker connections
  malToken?: string;
  resetToken?: string;             // active password-reset token (emailed)
  resetExpires?: number;           // epoch ms
  theme?: ThemeSettings;           // per-user appearance
}

export interface ThemeSettings {
  preset: string;                  // preset id (e.g. "renzo", "amoled", "light")
  accent?: string;                 // optional custom accent (#rrggbb)
  bg?: string;                     // optional custom background (#rrggbb)
}

/** Per-user defaults applied when a title first enters the user's library. */
export interface AddDefaults {
  track?: string;                  // tracking status to sync on add (validated as TrackStatus)
  autoDownload?: boolean;          // start auto-downloading the series on add
  folder?: string;                 // file the series into this folder
}

export interface SessionRecord {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface InviteRecord {
  token: string;
  role: Role;                     // role the invitee will get (not owner)
  email?: string;                 // optional; if set + SMTP configured, emailed
  username?: string;              // optional pre-set username
  createdBy: string;              // user id
  createdAt: string;
  expiresAt: string;
  usedAt?: string;                // set once accepted
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;                // true = implicit TLS (465); false = STARTTLS
  user: string;
  pass: string;
  from: string;
}

/** One entry in a user's watch history. */
export interface WatchHistoryEntry {
  id: number;      // AniList title id
  ep: number;      // episode last watched
  at: string;      // ISO timestamp
}

/** A shareable/bookmarkable per-series watch URL id (temp or per-user stable). */
export interface WatchToken {
  userId: string;
  titleId: number;
  temp: boolean;       // true = ephemeral (title not in the user's library)
  createdAt: number;
}

export interface DbShape {
  titles: Title[];
  jobs: DownloadJob[];
  users: UserRecord[];
  sessions: SessionRecord[];
  invites: InviteRecord[];
  settings: { smtp?: SmtpSettings };
  watch: Record<string, WatchToken>;   // watchId -> token
}
