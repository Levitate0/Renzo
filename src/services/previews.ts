import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import * as library from "./library.js";

// ---------------------------------------------------------------------------
// Scrub-preview frames for the player seek bar: one small JPEG per 10-second
// bucket, extracted with ffmpeg from a LOCAL episode file and cached on disk
// under <dataDir>/previews/<titleId>/<ep>/<bucket>.jpg. Extraction uses input
// seeking (-ss before -i), which is fast even deep into large MKVs.
// ---------------------------------------------------------------------------

export const BUCKET_S = 10;
/** Longest seek we'll ask ffmpeg for. Past the end it just fails, but an
 *  unclamped ?at= (1e300, Infinity) is a free ffmpeg launch per value. */
const MAX_AT_S = 12 * 3600;

/** In-flight extractions, so a scrub burst doesn't stampede ffmpeg. */
const inflight = new Map<string, Promise<string | null>>();

export function bucketFor(atSeconds: number): number {
  const at = Number.isFinite(atSeconds) ? Math.min(atSeconds, MAX_AT_S) : 0;
  return Math.max(0, Math.floor(at / BUCKET_S) * BUCKET_S);
}

// ---------------------------------------------------------------------------
// ffmpeg admission control. Every uncached bucket is a fresh ffmpeg process,
// and any signed-in user can ask for as many buckets as they like, so without
// a cap a scripted scrub (or a few players at once) forks ffmpeg without
// bound. MAX_RUNNING processes run server-wide, at most MAX_QUEUED wait behind
// them, and one user holds at most MAX_PER_USER of those places; anything
// beyond is refused with PreviewBusyError (the route answers 503 and the
// player shows its static thumbnail instead).
// ---------------------------------------------------------------------------

const MAX_RUNNING = 2;
const MAX_QUEUED = 16;
const MAX_PER_USER = 4;
/** A wedged ffmpeg (stalled mount, pathological file) must not hold a slot forever. */
const FFMPEG_TIMEOUT_MS = 20_000;

export class PreviewBusyError extends Error {
  constructor() { super("preview_busy"); }
}

type Waiter = { userId: string; resolve: () => void; reject: (e: Error) => void };
let running = 0;
const waiting: Waiter[] = [];
const perUser = new Map<string, number>(); // running + waiting, per user

function bump(userId: string, d: number): void {
  const n = (perUser.get(userId) ?? 0) + d;
  if (n > 0) perUser.set(userId, n);
  else perUser.delete(userId);
}

/** Wait for an ffmpeg slot; rejects with PreviewBusyError when full. */
function acquire(userId: string): Promise<void> {
  if ((perUser.get(userId) ?? 0) >= MAX_PER_USER) {
    // While scrubbing, the newest position is the one on screen: give up the
    // user's oldest WAITING request rather than this one. With everything of
    // theirs already running there is nothing to trade, so refuse.
    const i = waiting.findIndex((w) => w.userId === userId);
    if (i < 0) return Promise.reject(new PreviewBusyError());
    const [old] = waiting.splice(i, 1);
    bump(userId, -1);
    old.reject(new PreviewBusyError());
  }
  if (running < MAX_RUNNING) {
    running++;
    bump(userId, 1);
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUED) return Promise.reject(new PreviewBusyError());
  bump(userId, 1);
  return new Promise((resolve, reject) => waiting.push({ userId, resolve, reject }));
}

function release(userId: string): void {
  bump(userId, -1);
  const next = waiting.shift();
  if (next) next.resolve(); // the slot passes straight to the next waiter
  else running--;
}

/** Test/diagnostic view of the limiter. */
export function limiterState() {
  return { running, waiting: waiting.length, perUser: Object.fromEntries(perUser) };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: "ignore" });
    const timer = setTimeout(() => p.kill("SIGKILL"), FFMPEG_TIMEOUT_MS);
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}`));
    });
  });
}

/** Cached-or-extracted preview frame path, or null when extraction fails
 *  (e.g. the bucket is past the end of the file). Throws PreviewBusyError
 *  when the ffmpeg limiter is full — callers answer 503. `userId` is who the
 *  extraction is charged to. */
export async function frame(
  absVideo: string, titleId: number, ep: number, bucket: number, userId: string,
): Promise<string | null> {
  const dir = path.join(config.dataDir, "previews", String(titleId), String(ep));
  const out = path.join(dir, `${bucket}.jpg`);
  if (await library.exists(out)) return out;

  const key = out;
  const joined = inflight.get(key);
  if (joined) return joined;

  const job = (async () => {
    try {
      await acquire(userId); // PreviewBusyError propagates to the caller
      // Written under a temp name and renamed, so an ffmpeg killed by the
      // timeout never leaves a truncated JPEG that the cache check above
      // would then serve forever.
      const tmp = path.join(dir, `${bucket}.part.jpg`);
      try {
        await mkdir(dir, { recursive: true });
        await runFfmpeg([
          "-ss", String(bucket), "-i", absVideo,
          "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5",
          "-y", tmp,
        ]);
        if (!(await library.exists(tmp))) return null;
        await rename(tmp, out);
        return out;
      } catch {
        await rm(tmp, { force: true }).catch(() => {});
        return null;
      } finally {
        release(userId);
      }
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}
