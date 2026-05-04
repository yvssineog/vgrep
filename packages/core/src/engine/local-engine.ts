import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { CodeChunk, IndexEntry, SearchResult } from "../types";
import type { VectorEngine } from "./interface";
import { CachedEmbedder, type EmbeddingModel } from "../embedding/embedder";
import { transformersEmbedding } from "../embedding/transformers";

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

export class LocalEngine implements VectorEngine {
  private dbPromise: Promise<Database> | null = null;
  private readonly cachedEmbedder: CachedEmbedder;

  constructor(private readonly options: LocalEngineOptions) {
    this.cachedEmbedder = new CachedEmbedder(
      options.cacheDir,
      options.embeddingModel ?? transformersEmbedding(),
    );
  }

  async upsert(entries: IndexEntry[]): Promise<void> {
    const valid = entries.filter((e) => isFiniteVector(e.vector));
    if (valid.length === 0) return;

    const db = await this.getDb();
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
        stmt.run({
          $chunkhash: e.chunkHash,
          $filepath: e.filePath,
          $startline: e.startLine,
          $endline: e.endLine,
          $content: e.content,
          $language: e.language ?? "",
          $vector: vectorToBlob(e.vector),
        });
      }
    })(valid);
  }

  async deleteByFile(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    const db = await this.getDb();
    const stmt = db.prepare(`DELETE FROM chunks WHERE filepath = $filepath`);
    db.transaction((paths: string[]) => {
      for (const p of paths) stmt.run({ $filepath: p });
    })(filePaths);
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    if (topK <= 0) return [];

    const db = await this.getDb();
    const queryVector = await this.cachedEmbedder.embedText(query);
    const queryArr = new Float32Array(queryVector);
    const queryNorm = norm(queryArr);
    if (queryNorm === 0) return [];

    // Brute-force cosine kNN. At repo scale (≤100k chunks) iterating all rows
    // and computing dot products is faster than maintaining any index.
    const rows = db
      .query(
        `SELECT chunkhash, filepath, startline, endline, content, vector FROM chunks`,
      )
      .all() as ChunkRow[];

    if (rows.length === 0) return [];

    const heap = new TopK<ChunkRow>(Math.min(topK, rows.length));
    for (const row of rows) {
      const score = cosineFromBlob(queryArr, row.vector, queryNorm);
      heap.push(score, row);
    }

    return heap.drain().map(({ score, value }) => ({
      filePath: value.filepath,
      content: value.content,
      startLine: value.startline,
      endLine: value.endline,
      score: clampScore(score),
    }));
  }

  async hasIndex(_simhash: string): Promise<boolean> {
    const db = await this.getDb();
    const row = db
      .query(`SELECT COUNT(*) AS n FROM chunks`)
      .get() as { n: number };
    return row.n > 0;
  }

  async embedChunks(chunks: CodeChunk[]): Promise<IndexEntry[]> {
    return this.cachedEmbedder.embedChunks(chunks);
  }

  private getDb(): Promise<Database> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        await mkdir(dirname(this.options.dbPath), { recursive: true });
        const db = new Database(this.options.dbPath, { create: true });
        db.run("PRAGMA journal_mode = WAL");
        db.run("PRAGMA synchronous = NORMAL");
        db.run(SCHEMA);
        return db;
      })();
    }
    return this.dbPromise;
  }
}

function vectorToBlob(vector: number[]): Uint8Array {
  const arr = new Float32Array(vector);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function isFiniteVector(vector: number[]): boolean {
  return vector.length > 0 && vector.every(Number.isFinite);
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    s += x * x;
  }
  return Math.sqrt(s);
}

// DataView avoids per-row Float32Array allocations and any alignment surprises
// from sqlite blobs; the inner loop still vectorizes well in JSC.
function cosineFromBlob(
  query: Float32Array,
  blob: Uint8Array,
  queryNorm: number,
): number {
  const dim = query.length;
  if (blob.byteLength !== dim * 4) return 0;

  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let dot = 0;
  let bNorm2 = 0;
  for (let i = 0; i < dim; i++) {
    const bv = dv.getFloat32(i * 4, true);
    dot += query[i]! * bv;
    bNorm2 += bv * bv;
  }
  if (bNorm2 === 0) return 0;
  return dot / (queryNorm * Math.sqrt(bNorm2));
}

function clampScore(s: number): number {
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(1, s));
}

interface HeapEntry<T> {
  score: number;
  value: T;
}

// Min-heap of size k: root holds the *smallest* of the top-k scores so far,
// so a new candidate replaces it iff it beats the current floor.
class TopK<T> {
  private readonly heap: HeapEntry<T>[] = [];

  constructor(private readonly k: number) {}

  push(score: number, value: T): void {
    if (this.k === 0) return;

    if (this.heap.length < this.k) {
      this.heap.push({ score, value });
      this.siftUp(this.heap.length - 1);
      return;
    }

    if (score > this.heap[0]!.score) {
      this.heap[0] = { score, value };
      this.siftDown(0);
    }
  }

  drain(): HeapEntry<T>[] {
    return [...this.heap].sort((a, b) => b.score - a.score);
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent]!.score <= this.heap[i]!.score) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.heap[l]!.score < this.heap[smallest]!.score) smallest = l;
      if (r < n && this.heap[r]!.score < this.heap[smallest]!.score) smallest = r;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i]!, this.heap[smallest]!];
      i = smallest;
    }
  }
}
