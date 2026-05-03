import { mkdir } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import type { CodeChunk, IndexEntry, SearchResult } from "../types";
import type { VectorEngine } from "./interface";
import { CachedEmbedder, type Embedder } from "../embedding/embedder";

const TABLE_NAME = "embeddings";

export interface LocalEngineOptions {
  dbPath: string;
  cacheDir: string;
  embedder?: Embedder;
}

interface LanceRow {
  vector: number[];
  filepath: string;
  chunkhash: string;
  content: string;
  startline: number;
  endline: number;
  language: string;
  _distance?: number;
}

export class LocalEngine implements VectorEngine {
  private connectionPromise: Promise<Connection> | null = null;
  private tablePromise: Promise<Table | null> | null = null;
  private readonly cachedEmbedder: CachedEmbedder;

  constructor(private readonly options: LocalEngineOptions) {
    this.cachedEmbedder = new CachedEmbedder(
      options.cacheDir,
      options.embedder,
    );
  }

  async upsert(entries: IndexEntry[]): Promise<void> {
    const validEntries = entries.filter((entry) => isFiniteVector(entry.vector));
    if (validEntries.length === 0) return;

    const rows = validEntries.map(toRow);
    const { table, created } = await this.getOrCreateTable(rows);
    if (created) return;

    await this.deleteByChunkHash(
      table,
      validEntries.map((entry) => entry.chunkHash),
    );
    await table.add(rows as unknown as Record<string, unknown>[]);
  }

  async deleteByFile(filePaths: string[]): Promise<void> {
    const table = await this.getTable();
    if (!table) return;

    for (const filePath of filePaths) {
      await table.delete(`filepath == ${sqlString(filePath)}`);
    }
  }

  async search(query: string, topK = 10): Promise<SearchResult[]> {
    const table = await this.getTable();
    if (!table) {
      throw new Error('No local search index found. Run "vgrep init" first.');
    }

    const vector = await this.cachedEmbedder.embedText(query);
    const rows = (await table
      .vectorSearch(vector)
      .distanceType("cosine")
      .limit(topK)
      .toArray()) as LanceRow[];

    return rows.map((row) => ({
      filePath: row.filepath,
      content: row.content,
      startLine: row.startline,
      endLine: row.endline,
      score: distanceToScore(row._distance),
    }));
  }

  async hasIndex(_simhash: string): Promise<boolean> {
    const table = await this.getTable();
    if (!table) return false;
    return (await table.countRows()) > 0;
  }

  async embedChunk(chunk: CodeChunk): Promise<IndexEntry> {
    return this.cachedEmbedder.embedChunk(chunk);
  }

  async embedChunks(chunks: CodeChunk[]): Promise<IndexEntry[]> {
    return Promise.all(chunks.map((chunk) => this.embedChunk(chunk)));
  }

  private async getConnection(): Promise<Connection> {
    if (!this.connectionPromise) {
      this.connectionPromise = mkdir(this.options.dbPath, {
        recursive: true,
      }).then(() => lancedb.connect(this.options.dbPath));
    }

    return this.connectionPromise;
  }

  private async getTable(): Promise<Table | null> {
    if (!this.tablePromise) {
      this.tablePromise = this.openTable();
    }

    return this.tablePromise;
  }

  private async openTable(): Promise<Table | null> {
    const db = await this.getConnection();
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return null;
    return db.openTable(TABLE_NAME);
  }

  private async getOrCreateTable(
    initialRows: LanceRow[],
  ): Promise<{ table: Table; created: boolean }> {
    const existing = await this.getTable();
    if (existing) return { table: existing, created: false };

    const db = await this.getConnection();
    const table = await db.createTable(
      TABLE_NAME,
      initialRows as unknown as Record<string, unknown>[],
      {
        mode: "create",
        existOk: true,
      },
    );
    this.tablePromise = Promise.resolve(table);
    return { table, created: true };
  }

  private async deleteByChunkHash(
    table: Table,
    chunkHashes: string[],
  ): Promise<void> {
    for (const chunkHash of new Set(chunkHashes)) {
      await table.delete(`chunkhash == ${sqlString(chunkHash)}`);
    }
  }
}

function toRow(entry: IndexEntry): LanceRow {
  return {
    vector: entry.vector,
    filepath: entry.filePath,
    chunkhash: entry.chunkHash,
    content: entry.content,
    startline: entry.startLine,
    endline: entry.endLine,
    language: entry.language ?? "",
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function distanceToScore(distance?: number): number {
  if (typeof distance !== "number" || !Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 2));
}

function isFiniteVector(vector: number[]): boolean {
  return vector.length > 0 && vector.every(Number.isFinite);
}
