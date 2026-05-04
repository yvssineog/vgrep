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
export {
  MerkleTree,
  buildMerkleTree,
  collectFileHashes,
  deserializeTree,
  treeStats,
} from "./merkle/tree";
export { updateMerkleTree, type MerkleUpdateResult } from "./merkle/updater";
export { diffTrees } from "./merkle/diff";

// Ignore rules + path helpers (shared between core and CLI)
export {
  emptyIgnore,
  loadIgnore,
  matchesIgnore,
  mergeIgnore,
  parseIgnore,
  type IgnoreRules,
} from "./ignore";
export * as paths from "./util/paths";

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
export { readCachedVector, writeCachedVector } from "./embedding/cache";
export {
  embedChunksEffect,
  embedTextEffect,
  type EmbeddingModel,
} from "./embedding/embedder";
export {
  transformersEmbedding,
  type TransformersEmbeddingOptions,
} from "./embedding/transformers";

// Vector engine
export { localEngine, type LocalEngineE } from "./engine/local-engine";
