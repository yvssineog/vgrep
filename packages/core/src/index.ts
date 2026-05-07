// @vgrep/core — public surface
//
// All heavy lifting (chunking, embedding, vector search, merkle hashing)
// lives in the Mojo sidecar (`@vgrep/core-mojo`). This package exposes:
//
//   - The TS types that flow over the wire (no behavior change for callers
//     that already consume `MerkleNode`, `SearchResult`, etc.)
//   - The sidecar client and its protocol types
//   - Path/ignore helpers the Bun parent still needs for the watch poller
//
// Anything that used to import `localEngine`, `chunkFile`, `embedChunksEffect`,
// or `buildMerkleTree` should now go through `SidecarClient` instead.

export type {
  ChangedFile,
  ChangeType,
  CodeChunk,
  FileProfile,
  IndexEntry,
  MerkleNode,
  SearchResult,
  TreeStats,
  VgrepConfig,
  VgrepMode,
} from "./types";

export { SidecarClient, type SidecarClientOptions } from "./sidecar/client";
export type {
  ApplyDiffParams,
  ApplyDiffResult,
  BuildTreeResult,
  ErrorFrame,
  Frame,
  Method,
  OpenParams,
  ProgressFrame,
  ResultFrame,
  SearchOk,
  SearchParams,
  UpdateTreeParams,
  UpdateTreeResult,
} from "./sidecar/protocol";

export { DEFAULT_FILE_PROFILES, resolveProfileFilters } from "./profiles";
export {
  emptyIgnore,
  loadIgnore,
  matchesIgnore,
  mergeIgnore,
  parseIgnore,
  readIgnoreText,
  type IgnoreRules,
} from "./ignore";
export * as paths from "./util/paths";
