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
