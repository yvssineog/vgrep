import { embed, embedMany } from "ai";
import { Effect } from "effect";
import type { EmbeddingModelV2 } from "@ai-sdk/provider";
import type { CodeChunk, IndexEntry } from "../types";
import { readCachedVector, writeCachedVector } from "./cache";
import { tryAsync } from "../util/effect";

export type EmbeddingModel = EmbeddingModelV2<string>;

/** Cap on parallel filesystem ops for the cache. */
const CACHE_CONCURRENCY = 32;

const toEntry = (chunk: CodeChunk, vector: number[]): IndexEntry => ({
  filePath: chunk.filePath,
  chunkHash: chunk.chunkHash,
  content: chunk.content,
  startLine: chunk.startLine,
  endLine: chunk.endLine,
  language: chunk.language,
  vector,
});

/** Embed a single string via the AI SDK's `embed`. */
export const embedTextEffect = (
  model: EmbeddingModel,
  text: string,
): Effect.Effect<number[], Error> =>
  tryAsync(() => embed({ model, value: text }).then((r) => r.embedding));

/**
 * Embed `chunks` with cache-first lookups. Cache reads/writes are bounded
 * by `CACHE_CONCURRENCY` (no unbounded `Promise.all`). Cache misses go out
 * in a single bulk `embedMany` call so the SDK can batch optimally.
 */
export const embedChunksEffect = (
  cacheDir: string,
  model: EmbeddingModel,
  chunks: CodeChunk[],
): Effect.Effect<IndexEntry[], Error> =>
  Effect.gen(function* () {
    const lookups = yield* Effect.forEach(
      chunks,
      (chunk, index) =>
        Effect.map(readCachedVector(cacheDir, chunk.chunkHash), (cached) => ({
          chunk,
          index,
          cached,
        })),
      { concurrency: CACHE_CONCURRENCY },
    );

    const entries = new Array<IndexEntry | null>(chunks.length).fill(null);
    const missing: { index: number; chunk: CodeChunk }[] = [];
    for (const { chunk, index, cached } of lookups) {
      if (cached) entries[index] = toEntry(chunk, cached);
      else missing.push({ index, chunk });
    }

    if (missing.length === 0) return entries as IndexEntry[];

    const { embeddings } = yield* tryAsync(() =>
      embedMany({ model, values: missing.map(({ chunk }) => chunk.content) }),
    );

    yield* Effect.forEach(
      missing,
      ({ index, chunk }, i) =>
        Effect.gen(function* () {
          const vector = embeddings[i]!;
          yield* writeCachedVector(cacheDir, chunk.chunkHash, vector);
          entries[index] = toEntry(chunk, vector);
        }),
      { concurrency: CACHE_CONCURRENCY },
    );

    return entries as IndexEntry[];
  });
