import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { tryAsync } from "../util/effect";

/**
 * Per-chunk embedding cache.
 *
 * Each cached vector is one file at `<cacheDir>/<chunkHash>.bin`, containing
 * the raw little-endian Float32 bytes. This makes cache reads a single
 * `Bun.file().arrayBuffer()` and trivially atomic via `Bun.write`.
 */

const FLOAT_BYTES = 4;

const cachePath = (dir: string, hash: string): string =>
  join(dir, `${hash}.bin`);

/** Read a cached vector by chunk hash, or `null` if not present / corrupt. */
export const readCachedVector = (
  dir: string,
  hash: string,
): Effect.Effect<number[] | null, Error> =>
  tryAsync(async () => {
    const file = Bun.file(cachePath(dir, hash));
    if (!(await file.exists())) return null;
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength % FLOAT_BYTES !== 0) return null;
    return Array.from(new Float32Array(bytes));
  });

/** Persist a vector for a chunk hash. Creates the cache dir if needed. */
export const writeCachedVector = (
  dir: string,
  hash: string,
  vector: number[],
): Effect.Effect<void, Error> =>
  tryAsync(async () => {
    await mkdir(dir, { recursive: true });
    await Bun.write(cachePath(dir, hash), new Float32Array(vector));
  });
