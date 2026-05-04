import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { cosineSimilarity } from "ai";
import type { CodeChunk, IndexEntry, SearchResult } from "../types";
import {
  embedChunksEffect,
  embedTextEffect,
  type EmbeddingModel,
} from "../embedding/embedder";
import { transformersEmbedding } from "../embedding/transformers";
import { tryAsync, trySync } from "../util/effect";

/**
 * Local SQLite-backed vector engine.
 *
 * Storage shape: one `chunks` row per code chunk, with the embedding stored
 * as a 4-byte-per-float little-endian BLOB (compact, no JSON overhead).
 *
 * Search is a brute-force cosine kNN over all rows. At repo scale (≤100k
 * chunks) this beats any index since the dot product is already vectorised
 * and we avoid index-build cost on every change.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chunks (
    chunkhash TEXT PRIMARY KEY,
    filepath  TEXT NOT NULL,
    startline INTEGER NOT NULL,
    endline   INTEGER NOT NULL,
    content   TEXT NOT NULL,
    language  TEXT NOT NULL,
    vector    BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_filepath ON chunks(filepath);
`;

export interface LocalEngineOptions {
  /** Path to the SQLite index file (e.g. `.vgrep/index.db`). */
  dbPath: string;
  /** Directory for the per-chunk embedding cache. */
  cacheDir: string;
  /** AI SDK embedding model. Defaults to local in-process MiniLM-L6-v2. */
  embeddingModel?: EmbeddingModel;
}

interface ChunkRow {
  chunkhash: string;
  filepath: string;
  startline: number;
  endline: number;
  content: string;
  vector: Uint8Array;
}

export interface LocalEngineE {
  upsert: (entries: IndexEntry[]) => Effect.Effect<void, Error>;
  deleteByFile: (paths: string[]) => Effect.Effect<void, Error>;
  search: (query: string, topK?: number) => Effect.Effect<SearchResult[], Error>;
  hasIndex: () => Effect.Effect<boolean, Error>;
  embedChunks: (chunks: CodeChunk[]) => Effect.Effect<IndexEntry[], Error>;
}

/** Open the SQLite db; close on scope exit (even under interruption). */
const acquireDb = (dbPath: string) =>
  Effect.acquireRelease(
    tryAsync(async () => {
      await mkdir(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath, { create: true });
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = NORMAL");
      db.run(SCHEMA);
      return db;
    }),
    (db) => Effect.sync(() => db.close()),
  );

/**
 * Scoped engine factory. Use inside `Effect.scoped`:
 *
 *   Effect.scoped(Effect.gen(function* () {
 *     const engine = yield* localEngine(opts)
 *     yield* engine.upsert(entries)
 *   }))
 */
export const localEngine = (options: LocalEngineOptions) => {
  const model = options.embeddingModel ?? transformersEmbedding();
  return Effect.map(acquireDb(options.dbPath), (db): LocalEngineE => ({
    upsert: (entries) => upsert(db, entries),
    deleteByFile: (paths) => deleteByFile(db, paths),
    search: (query, topK = 10) => search(db, model, query, topK),
    hasIndex: () =>
      trySync(() => {
        const row = db.query(`SELECT COUNT(*) AS n FROM chunks`).get() as {
          n: number;
        };
        return row.n > 0;
      }),
    embedChunks: (chunks) => embedChunksEffect(options.cacheDir, model, chunks),
  }));
};

const upsert = (db: Database, entries: IndexEntry[]) =>
  trySync(() => {
    const valid = entries.filter(
      (e) => e.vector.length > 0 && e.vector.every(Number.isFinite),
    );
    if (valid.length === 0) return;

    const stmt = db.prepare(`
      INSERT INTO chunks (chunkhash, filepath, startline, endline, content, language, vector)
      VALUES ($chunkhash, $filepath, $startline, $endline, $content, $language, $vector)
      ON CONFLICT(chunkhash) DO UPDATE SET
        filepath  = excluded.filepath,
        startline = excluded.startline,
        endline   = excluded.endline,
        content   = excluded.content,
        language  = excluded.language,
        vector    = excluded.vector
    `);
    db.transaction((rows: IndexEntry[]) => {
      for (const e of rows) {
        const arr = new Float32Array(e.vector);
        stmt.run({
          $chunkhash: e.chunkHash,
          $filepath: e.filePath,
          $startline: e.startLine,
          $endline: e.endLine,
          $content: e.content,
          $language: e.language ?? "",
          $vector: new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
        });
      }
    })(valid);
  });

const deleteByFile = (db: Database, filePaths: string[]) =>
  trySync(() => {
    if (filePaths.length === 0) return;
    const stmt = db.prepare(`DELETE FROM chunks WHERE filepath = $filepath`);
    db.transaction((paths: string[]) => {
      for (const p of paths) stmt.run({ $filepath: p });
    })(filePaths);
  });

const search = (
  db: Database,
  model: EmbeddingModel,
  query: string,
  topK: number,
): Effect.Effect<SearchResult[], Error> =>
  Effect.gen(function* () {
    if (topK <= 0) return [];

    const queryVector = yield* embedTextEffect(model, query);
    const rows = yield* trySync(() =>
      db
        .query(
          `SELECT chunkhash, filepath, startline, endline, content, vector FROM chunks`,
        )
        .all() as ChunkRow[],
    );
    if (rows.length === 0) return [];

    return rows
      .map((row) => ({
        row,
        score: clamp01(cosineSimilarity(queryVector, blobToVector(row.vector))),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ row, score }) => ({
        filePath: row.filepath,
        content: row.content,
        startLine: row.startline,
        endLine: row.endline,
        score,
      }));
  });

const blobToVector = (blob: Uint8Array): number[] =>
  Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));

const clamp01 = (s: number): number =>
  Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0;
