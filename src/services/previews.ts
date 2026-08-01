import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
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

/** In-flight extractions, so a scrub burst doesn't stampede ffmpeg. */
const inflight = new Map<string, Promise<string | null>>();

export function bucketFor(atSeconds: number): number {
  return Math.max(0, Math.floor(atSeconds / BUCKET_S) * BUCKET_S);
}

/** Cached-or-extracted preview frame path, or null when extraction fails
 *  (e.g. the bucket is past the end of the file). */
export async function frame(absVideo: string, titleId: number, ep: number, bucket: number): Promise<string | null> {
  const dir = path.join(config.dataDir, "previews", String(titleId), String(ep));
  const out = path.join(dir, `${bucket}.jpg`);
  if (await library.exists(out)) return out;

  const key = out;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        const p = spawn("ffmpeg", [
          "-ss", String(bucket), "-i", absVideo,
          "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5",
          "-y", out,
        ], { stdio: "ignore" });
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
      });
      return (await library.exists(out)) ? out : null;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}
