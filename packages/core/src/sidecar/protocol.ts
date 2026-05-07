import type { ChangedFile, MerkleNode, SearchResult } from "../types";

/**
 * Wire protocol shared with `packages/core-mojo/src/protocol.mojo`.
 *
 * Each request is one NDJSON frame on the sidecar's stdin:
 *
 *   { "id": "<uuid>", "method": "search", "params": {...} }
 *
 * The sidecar replies with one or more frames sharing the same `id`:
 *
 *   { "id": "<uuid>", "type": "progress", "stage": "embed", "done": 42, "total": 256 }
 *   { "id": "<uuid>", "type": "result", "result": {...} }
 *
 * `progress` frames are zero-or-more, terminated by exactly one
 * `result` or `error`. The client multiplexes by `id` so multiple
 * requests can be in flight (the sidecar handles them sequentially
 * today, but the protocol leaves room for that to change).
 */

export type Method =
  | "open"
  | "close"
  | "health"
  | "merkle.build"
  | "merkle.update"
  | "index.applyDiff"
  | "search";

export interface OpenParams {
  projectRoot: string;
  dbPath: string;
  cacheDir: string;
  /** File extensions (no leading dot) the active profiles include. */
  extensions: string[];
  /** Exact lowercase filenames the active profiles include (e.g. "dockerfile"). */
  filenames: string[];
  /** Raw `.vgrepignore` text — sidecar parses and applies it. */
  ignoreText: string;
}

export interface BuildTreeResult {
  tree: MerkleNode;
}

export interface UpdateTreeParams {
  /** Previous tree (or null on first run). */
  previous: MerkleNode | null;
}

export interface UpdateTreeResult {
  tree: MerkleNode;
  changes: ChangedFile[];
}

export interface ApplyDiffParams {
  changes: ChangedFile[];
}

export interface ApplyDiffResult {
  indexedChunks: number;
  failedFiles: number;
  deletedFiles: number;
}

export interface SearchParams {
  query: string;
  topK: number;
}

export interface SearchOk {
  results: SearchResult[];
}

export type ProgressFrame = {
  id: string;
  type: "progress";
  stage: "chunk" | "embed";
  done: number;
  total: number;
};

export type ResultFrame<T = unknown> = {
  id: string;
  type: "result";
  result: T;
};

export type ErrorFrame = {
  id: string;
  type: "error";
  error: string;
};

export type Frame = ProgressFrame | ResultFrame | ErrorFrame;
