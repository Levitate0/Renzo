// ---------------------------------------------------------------------------
// TypeScript DTOs for every backend endpoint the UI consumes.
// Derived from ../src/routes/api.ts + ../src/routes/auth.ts (ground truth).
// The backend is untouchable — these types mirror it, they don't shape it.
// ---------------------------------------------------------------------------

export type Role = "owner" | "manager" | "user";
export type MediaType = "movie" | "series";
export type TrackStatus =
  | "watching"
  | "completed"
  | "planning"
  | "paused"
  | "dropped"
  | "rewatching";

// --- Auth / account ---------------------------------------------------------

export interface ThemeSettings {
  preset: string;
  accent?: string;
  bg?: string;
}

export interface AddDefaults {
  track?: TrackStatus;
  autoDownload?: boolean;
  folder?: string;
}

/** Shape of `publicUser()` in src/routes/auth.ts. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  email: string | null;
  realDebridConnected: boolean;
  allDebridConnected: boolean;
  debrid: "realdebrid" | "alldebrid" | null;
  jimakuConnected: boolean;
  anilistConnected: boolean;
  malConnected: boolean;
  theme: ThemeSettings | null;
  downloadsDenied: boolean;
  addDefaults: AddDefaults | null;
  autoStatus: boolean;
  ccLang: string;
  /** Shiori-style profile avatar — small base64 image stored on the user. */
  avatarBase64: string | null;
  avatarContentType: string | null;
}

/** GET /api/auth/me — 200 with user, `{ setupRequired: true }`, or 401. */
export interface MeResponse {
  user?: PublicUser;
  setupRequired?: boolean;
  authDisabled?: boolean;
  error?: string;
}

/** POST /api/auth/{login,setup,reset,invite/accept} success payload. */
export interface AuthSuccess {
  user: PublicUser;
}

/** GET /api/auth/invite/:token */
export interface InviteInfo {
  valid: boolean;
  role?: Role;
  username?: string | null;
  presetUsername?: boolean;
  error?: string;
}

/** GET /api/auth/reset/:token */
export interface ResetInfo {
  valid: boolean;
  username?: string;
  error?: string;
}

/** POST /api/account/realdebrid | /alldebrid extra fields. */
export interface DebridSaveResponse extends PublicUser {
  premium: boolean;
  username_rd?: string;
  username_ad?: string;
}

/** GET /api/account/apikey */
export interface ApiKeyInfo {
  apiKey: string;
  renzoUrl: string;
  manifestUrl: string;
}

/** POST /api/account/avatar — save `{avatarBase64, contentType}` (png/jpeg/
 *  webp, ≤256KB decoded) or clear with `{avatarBase64: null}`. The returned
 *  base64 is the server's re-encoded copy — patch the auth user with it. */
export interface AvatarSaveResponse {
  ok: boolean;
  avatarBase64: string | null;
  avatarContentType: string | null;
}

/** POST /api/account/avatar/gravatar `{email}` — a PREVIEW payload (404 when
 *  no Gravatar exists); nothing is stored until saved via /account/avatar. */
export interface GravatarPreview {
  avatarBase64: string;
  avatarContentType: string;
}

// --- Health -----------------------------------------------------------------

export type DebridHealth =
  | "not-connected"
  | "connected"
  | "premium"
  | "not-premium"
  | "invalid";

/** GET /api/health */
export interface Health {
  ok: boolean;
  realdebrid: DebridHealth;
  alldebrid: DebridHealth;
  debrid: "realdebrid" | "alldebrid" | null;
  jellyfin: string;
  trackers: { anilist: boolean; mal: boolean };
  authsite: { enabled: boolean; url: string | null };
}

// --- Cards / discovery ------------------------------------------------------

/**
 * A poster card. Discover rows return the AniList shape (no library fields);
 * /library, /history add per-user fields; grouped library cards add
 * seasonCount; AniList-down fallback rows return `source: "mal"` cards that
 * must be resolved via GET /titles/resolve before opening.
 * Client-side `updKind`/`ep`/`upcoming`/`season` are mapped onto cards from
 * the updates feed for ribbon rendering (see old app.js loadUpdates).
 */
export interface CardItem {
  id?: number; // absent on MAL fallback cards
  type: MediaType;
  title: string;
  year: number | null;
  poster: string | null;
  genres: string[];
  content: string[];
  // per-user extras (library / history / grouped cards)
  inLibrary?: boolean;
  lists?: string[];
  folder?: string;
  downloaded?: number;
  upNext?: number | null;
  seasonCount?: number;
  // MAL fallback cards
  source?: "mal";
  malId?: number;
  // updates-feed ribbon fields (client-mapped)
  updKind?: "episode" | "movie" | "season";
  ep?: number;
  upcoming?: boolean;
  season?: number | null;
}

/** GET /api/titles/resolve?mal=<id> */
export interface ResolveResponse {
  id: number;
}

// --- Library / folders / lists ---------------------------------------------

/** GET /api/folders */
export interface FolderInfo {
  name: string;
  count: number;
  default: boolean;
}

/** GET /api/lists — list name -> title count. */
export type ListCounts = Record<string, number>;

/** POST /api/titles/:id/lists */
export interface ListToggleResponse {
  id: number;
  lists: string[];
  inLibrary: boolean;
}

/** POST /api/titles/:id/folder */
export interface FolderAssignResponse {
  id: number;
  folder: string;
}

/** POST /api/trackers/import */
export interface ImportResult {
  anilist: number;
  mal: number;
}

// --- Title detail -----------------------------------------------------------

export type SeasonKind = "season" | "extra";

/** Entry in `detail.seasons` / `detail.nextUp` (anilist.SeasonRef). */
export interface SeasonRef {
  id: number;
  title: string;
  year: number | null;
  format: string | null;
  episodes: number | null;
  poster: string | null;
  relation: string;
  status: string | null;
  num: number;
  part: number | null;
  kind: SeasonKind;
}

export type DownloadStatus = "wanted" | "queued" | "downloading" | "downloaded" | "failed";

export interface EpisodeInfo {
  number: number;
  status: DownloadStatus | string;
  hasFile: boolean;
  progress: number;
  aired: boolean;
  thumbnail: string | null;
  epTitle: string | null;
}

/** GET /api/titles/:id — Title record spread + detail extras. */
export interface TitleDetail {
  id: number;
  malId?: number;
  type: MediaType;
  format?: string;
  romaji: string;
  english?: string;
  synonyms?: string[];
  year?: number | null;
  episodeCount?: number;
  description?: string;
  genres: string[];
  content?: string[];
  isAdult?: boolean;
  poster?: string;
  banner?: string;
  airingStatus?: string;
  nextAiringEpisode?: number;
  seriesKey: number | null;
  autoDownload: boolean;
  episodesTotal: number;
  airedEpisodes: number;
  episodeList: EpisodeInfo[];
  seasons: SeasonRef[];
  seasonNum: number;
  seasonPart: number | null;
  seasonKind: SeasonKind;
  seasonFormat: string | null;
  nextUp: SeasonRef | null;
  duration: number | null;
  watchedThrough: number;
  lists: string[];
  inLibrary: boolean;
  folder: string;
  folders: string[];
  provider: string | null;
}

/** GET /api/titles/:id/providers */
export interface ProviderOption {
  group: string;
  count: number;
  resolutions: number[];
}

/** POST /api/titles/:id/provider */
export interface ProviderSetResponse {
  id: number;
  provider: string | null;
}

// --- Tracking ---------------------------------------------------------------

export interface TrackEntry {
  status: TrackStatus | null;
  progress: number;
  score: number;
  total: number | null;
}

/** GET/POST /api/titles/:id/tracking — key present = tracker connected. */
export interface Tracking {
  anilist?: TrackEntry | null;
  mal?: TrackEntry | null;
}

// --- Playback / watch links -------------------------------------------------

export interface SubtitleRef {
  id: string;
  label: string;
  lang: string;
}

/** GET /api/titles/:id/play/:ep (downloader.ResolvedStream). */
export interface ResolvedStream {
  source: "local" | "realdebrid" | "alldebrid";
  url: string;
  filename?: string;
  subtitles: SubtitleRef[];
}

/** GET /api/titles/:id/offline/:ep — token-signed, cookie-free URLs. */
export interface OfflineResolve {
  source: "local";
  url: string;
  subtitles: { label: string; lang: string; src: string }[];
}

/** POST /api/titles/:id/watch */
export interface WatchStart {
  watchId: string;
  titleId: number;
}

/** GET /api/watch/:watchId */
export interface WatchResolve {
  titleId: number;
  resumeEp: number;
  temp: boolean;
}

// --- Progress / history / updates ------------------------------------------

/** POST /api/titles/:id/progress */
export interface ProgressResult {
  id: number;
  watchedThrough: number;
  upNext: number | null;
}

/** POST /api/titles/:id/watched/:ep */
export interface WatchedResult {
  ok: boolean;
  upNext: number | null;
}

/** A saved playback position INSIDE one episode (src/types.ts ResumePoint) —
 *  distinct from `progress`/`watchedThrough`, which counts whole episodes. */
export interface ResumePoint {
  positionMs: number;
  /** 0 when the writing client didn't know it. */
  durationMs: number;
  updatedAt: string;
}

/** GET /api/titles/:id/resume — every saved episode of one title, keyed by
 *  episode number as a string; `{}` when nothing is saved. */
export type ResumeMap = Record<string, ResumePoint>;

/** POST /api/titles/:id/resume/:ep — `saved: null` means the server judged the
 *  position not worth keeping (too near the start/end) and dropped the entry. */
export interface ResumeSaveResult {
  ok: boolean;
  saved: ResumePoint | null;
}

/** GET /api/history item — a card + last watched ep/time. */
export interface HistoryItem extends CardItem {
  id: number;
  ep: number;
  at: string;
}

/** GET /api/updates item. */
export interface UpdateItem {
  kind: "episode" | "movie" | "season";
  id: number;
  type: MediaType | string;
  title: string;
  poster: string | null;
  ep?: number;
  latest?: number;
  releasing?: boolean;
  upcoming?: boolean;
  year?: number | null;
  season: number | null;
  seasonPart: number | null;
  /** Adult tags, so the "show up to" filter applies here like everywhere else. */
  content?: string[];
}

// --- Jobs / downloads -------------------------------------------------------

export type JobStatus = "queued" | "searching" | "downloading" | "downloaded" | "failed";

/** GET /api/jobs item. */
export interface Job {
  id: string;
  titleId: number;
  episode: number;
  status: JobStatus;
  progress: number;
  message?: string;
  title: string;
  mine: boolean;
}

/** POST /api/titles/:id/download-season */
export interface SeasonDownloadResult {
  queued: number;
  skipped?: number;
  message?: string;
}

// --- Auto-downloader --------------------------------------------------------

/** Self-check finding (selfcheck.PublicCheck). */
export interface AutodlCheck {
  code: string;
  scope: "server" | "you" | "user";
  user?: string;
  severity: "warn";
  since?: string;
  message: string;
  /** e.g. "settings:credentials" — clicking should open that settings pane. */
  action?: string;
}

/** GET /api/autodl/status */
export interface AutodlStatus {
  enabled: boolean;
  intervalMin: number;
  maxPerTick: number;
  running: boolean;
  lastRun?: string | null;
  lastQueued: number;
  lastError?: string;
  trackedTitles: number;
  scope: "server" | "you";
  canRun?: boolean;
  checks: AutodlCheck[];
}

/** POST /api/autodl/run */
export interface AutodlRunResult {
  queued: number;
}

// --- Admin: users / invites / SMTP -----------------------------------------

/** GET /api/users — array of PublicUser (staff only). */
export type UsersList = PublicUser[];

/** GET /api/invites item. */
export interface InvitePublic {
  token: string;
  role: Role;
  email: string | null;
  username: string | null;
  expiresAt: string;
  url: string;
}

/** POST /api/invites */
export interface InviteCreated {
  token: string;
  role: Role;
  url: string;
  emailed: boolean;
}

/** GET /api/smtp — null when not configured. */
export interface SmtpPublic {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPassword: boolean;
}

// --- Native shell plumbing (window globals from the shipped clients) --------

export interface RenzoServerPlugin {
  get(): Promise<{ url?: string | null }>;
  set(opts: { url: string }): Promise<void>;
  clear(): Promise<void>;
}

/** Minimal typed view of the native globals the shell needs. The full native
 *  bridge (RenzoSaf / RenzoDownloader / RenzoNative) lives in lib/native.ts
 *  (native-libs phase) — only RenzoServer + the TV flag are needed here. */
export interface NativeWindow {
  __RENZO_TV?: boolean;
  RenzoTV?: { enable(): void; isOn(): boolean; back(): boolean; playPause(): boolean };
  Capacitor?: {
    isNativePlatform?: () => boolean;
    Plugins?: { RenzoServer?: RenzoServerPlugin } & Record<string, unknown>;
  };
}
