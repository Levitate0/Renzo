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
  /**
   * Kitsu id, resolved lazily from `malId` through Kitsu's own public
   * mappings endpoint and cached here. AniList does not return a Kitsu id, so
   * unlike malId there is no free source for it — see tracker.kitsuIdFor.
   */
  kitsuId?: number;
  type: MediaType;
  format?: string;        // AniList format (TV, TV_SHORT, ONA, MOVIE, OVA, SPECIAL)
  romaji: string;
  english?: string;
  synonyms: string[];
  year?: number;
  episodeCount?: number;  // total episodes (series)
  description?: string;
  genres: string[];
  isAdult?: boolean;      // AniList adult flag (hentai / R18) — for content filtering
  poster?: string;        // cover image url (AniList)
  banner?: string;
  airingStatus?: string;      // FINISHED | RELEASING | NOT_YET_RELEASED | ...
  nextAiringEpisode?: number; // next episode number to air (while RELEASING)
  nextAiringAt?: number;      // when it airs, epoch ms (AniList airingAt)
  autoDownload?: boolean;     // auto-grab new episodes on the schedule
  autoFromTracker?: boolean;  // autoDownload=true came from tracker sync (so sync may also clear it)
  lists?: string[];           // DEPRECATED: lists moved to UserRecord.lists (per-user)
  seriesKey?: number;         // canonical id shared by every season of a series (library grouping)
  seriesKeyV?: number;        // chain-walk version the key came from (see anilist.SERIES_CHAIN_VERSION)
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
  subs?: { file: string; lang: string; label: string }[]; // extracted embedded subtitle sidecars (rel paths)
  subsV?: number;         // extraction-logic version the subs were produced with (see captions.SUBS_VERSION)
  updatedAt: string;
}

/** A running/queued download job. */
/** Saved playback position for one episode (see UserRecord.resume). */
export interface ResumePoint {
  positionMs: number;
  /** 0 when the client didn't know it; clients should then offer the resume anyway. */
  durationMs: number;
  updatedAt: string;
}

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
  /**
   * titleId -> episode -> where playback stopped, so a series picks up on any
   * device. Distinct from `progress`, which is a whole-episode high-water mark:
   * this is a position INSIDE one episode and is last-write-wins, because
   * seeking backwards is normal. Cleared when the episode is marked watched.
   */
  resume?: Record<string, Record<string, ResumePoint>>;
  history?: WatchHistoryEntry[];        // recently-watched titles, most-recent first
  watchIds?: Record<string, string>;   // titleId -> stable per-user watch token (for saved titles)
  updatesSeen?: Record<string, number>; // titleId -> aired-count last acknowledged in Updates
  realDebridToken?: string;        // per-user RD creds — required to stream/download
  allDebridKey?: string;           // per-user AllDebrid API key (alternative debrid)
  debrid?: "realdebrid" | "alldebrid"; // preferred provider when both are connected
  jimakuKey?: string;              // per-user Jimaku API key (anime subtitles)
  apiKey?: string;                 // per-user API key (Jellyfin plugin / external clients)
  downloadsDenied?: boolean;       // staff can block this user from ALL downloads (streaming still allowed)
  autoStatus?: boolean;            // auto-manage tracking status as you watch (default on; undefined = on)
  ccLang?: string;                 // preferred subtitle/caption language ("en", "ja", … or "off")
  autoTitles?: number[];           // titles this user auto-downloads to THEIR OWN Real-Debrid
  addDefaults?: AddDefaults;       // states applied when a title first enters this user's library
  anilistToken?: string;           // per-user tracker connections
  anilistRefresh?: string;         // OAuth refresh token (auth-site machine flow)
  anilistExpiresAt?: string;       // ISO — refresh via the auth site when past
  malToken?: string;
  malRefresh?: string;
  malExpiresAt?: string;
  kitsuToken?: string;
  kitsuRefresh?: string;
  kitsuExpiresAt?: string;
  resetToken?: string;             // active password-reset token (emailed)
  resetExpires?: number;           // epoch ms
  theme?: ThemeSettings;           // per-user appearance
  avatarBase64?: string;           // profile picture, small (<=256KB decoded) base64 image
  avatarContentType?: string;      // image/png | image/jpeg | image/webp
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
  /**
   * Stable device identity, independent of the token. The token ROTATES (see
   * services/auth.ts), and the device list and its revoke button must keep
   * pointing at the same device across a rotation — deriving the id from the
   * token would rename the device every time it rotated. Optional because rows
   * written before rotation existed have none; one is assigned on first read.
   */
  id?: string;
  /** Whether the browser was given a persistent cookie ("remember me"). Kept so
   *  a rotation re-issues the SAME kind of cookie instead of silently promoting
   *  a session cookie to a persistent one, or demoting the reverse. */
  remember?: boolean;
  /** The token this session's current token replaced. Honoured until prevUntil
   *  so a client that never received the replacement isn't signed out. */
  prevToken?: string;
  prevUntil?: string;
  rotatedAt?: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  deviceName?: string;            // set when a TV pairing created this session (shown in "your devices")
  /**
   * True when a TV pairing minted this session. A television is not a browser:
   * nobody is there to sign it in again, and asking a living room to re-pair on
   * the browser cadence is the failure this flow exists to remove — so these
   * carry their own, longer lifetime (TV_SESSION_TTL_DAYS).
   */
  tv?: boolean;
  /**
   * Coarse last-use stamp. Persisted at most ~hourly per session (see
   * services/auth.ts): db.json is rewritten in FULL on every save, so writing
   * this per request would rewrite the whole database on every API call.
   */
  lastSeenAt?: string;
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
  settings: { smtp?: SmtpSettings; dtokenSecret?: string; oauthInstanceKey?: string };
  watch: Record<string, WatchToken>;   // watchId -> token
}
