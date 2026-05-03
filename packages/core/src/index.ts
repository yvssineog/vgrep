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
export {
  CachedEmbedder,
  TransformersEmbedder,
  type Embedder,
} from "./embedding/embedder";

// Vector engines
export { LocalEngine } from "./engine/local-engine";
export type { VectorEngine } from "./engine/interface";
