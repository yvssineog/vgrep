// @vgrep/core — Public API

// Types
export type {
  MerkleNode,
  ChangedFile,
  ChangeType,
  CodeChunk,
  IndexEntry,
  SearchResult,
  VgrepConfig,
  VgrepMode,
  TreeStats,
} from "./types";

// Merkle Tree
export { MerkleTree } from "./merkle/tree";
export { MerkleTreeUpdater, type MerkleUpdateResult } from "./merkle/updater";
export { diffTrees } from "./merkle/diff";

// Simhash
export { computeSimhash, hammingDistance } from "./simhash/simhash";

// Chunking
export { chunkFile, initTreeSitter } from "./chunking/chunker";
export {
  DEFAULT_FILE_PROFILES,
  createIndexableFileMatcher,
  detectLanguage,
  hasGrammar,
  isIndexableTextFile,
} from "./chunking/languages";

// Embeddings
export { EmbeddingCache } from "./embedding/cache";
export { CachedEmbedder, type EmbeddingModel } from "./embedding/embedder";
export {
  transformersEmbedding,
  type TransformersEmbeddingOptions,
} from "./embedding/transformers";

// Vector engines
export { LocalEngine } from "./engine/local-engine";
export type { VectorEngine } from "./engine/interface";
