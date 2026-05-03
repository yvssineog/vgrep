// ─── Merkle Tree ───────────────────────────────────────────────
export interface MerkleNode {
  /** Relative path from repo root */
  path: string;
  type: "file" | "directory";
  /** SHA-256 hex digest */
  hash: string;
  /** Child nodes (directories only) */
  children?: MerkleNode[];
  /** File size in bytes (files only) */
  size?: number;
  /** Last modification time epoch ms (files only, used as fast-skip heuristic) */
  mtime?: number;
}

// ─── Diffing ───────────────────────────────────────────────────
export type ChangeType = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  type: ChangeType;
  /** New hash (undefined for deletions) */
  hash?: string;
}

// ─── Code Chunking ─────────────────────────────────────────────
export interface CodeChunk {
  /** Relative file path */
  filePath: string;
  /** SHA-256 of the chunk content */
  chunkHash: string;
  /** The raw text content of this chunk */
  content: string;
  /** 1-indexed start line in the original file */
  startLine: number;
  /** 1-indexed end line in the original file */
  endLine: number;
  /** Programming language identifier */
  language?: string;
}

// ─── Index Entry (chunk + embedding) ───────────────────────────
export interface IndexEntry {
  filePath: string;
  chunkHash: string;
  content: string;
  startLine: number;
  endLine: number;
  /** Programming language identifier */
  language?: string;
  /** 384-dim embedding vector */
  vector: number[];
}

// ─── Search ────────────────────────────────────────────────────
export interface SearchResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  /** Cosine similarity score (0–1) */
  score: number;
}

// ─── Config ────────────────────────────────────────────────────
export type VgrepMode = "local" | "cloud";

export interface VgrepConfig {
  mode: VgrepMode;
  /** Team API key for cloud mode */
  teamApiKey?: string;
  /** SST backend URL */
  backendUrl?: string;
  /** Profiles available for file selection during indexing */
  fileProfiles?: Record<string, FileProfile>;
  /** Profiles used when no --include or --only option is supplied */
  defaultProfiles?: string[];
}

export interface FileProfile {
  /** Human-readable explanation shown in generated config */
  description?: string;
  /** File extensions without the leading dot */
  extensions: string[];
  /** Exact lowercase filenames without paths, e.g. "dockerfile" */
  filenames?: string[];
}

// ─── Merkle Tree Stats ─────────────────────────────────────────
export interface TreeStats {
  totalFiles: number;
  totalDirectories: number;
  totalSizeBytes: number;
  rootHash: string;
}
