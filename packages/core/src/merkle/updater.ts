import { Effect } from "effect";
import type { ChangedFile, MerkleNode } from "../types";
import { isIndexableTextFile } from "../chunking/languages";
import {
  emptyIgnore,
  loadIgnore,
  matchesIgnore,
  type IgnoreRules,
} from "../ignore";
import { joinSystem, resolveCandidate } from "../util/paths";
import { buildRootFromLeaves, hashFileEffect } from "./internal";

const HASH_CONCURRENCY = 32;

export interface MerkleUpdateResult {
  changed: boolean;
  changes: ChangedFile[];
  root: MerkleNode;
}

interface UpdaterState {
  rootDir: string;
  isIndexable: (p: string) => boolean;
  leaves: Map<string, MerkleNode>;
  ignore: IgnoreRules;
}

/** Flatten a tree into `path → leaf` (file nodes only). */
const collectLeaves = (root: MerkleNode): Map<string, MerkleNode> => {
  const out = new Map<string, MerkleNode>();
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") out.set(n.path, { ...n });
    else for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
};

const fileExists = (rootDir: string, path: string): Effect.Effect<boolean, Error> =>
  Effect.tryPromise({
    try: () => Bun.file(joinSystem(rootDir, path)).exists(),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

/** Reconcile one candidate path against the current leaves; returns the
 *  diff entry produced (if any). Mutates `state.leaves`. */
const reconcilePath = (
  state: UpdaterState,
  path: string,
): Effect.Effect<ChangedFile | null, Error> =>
  Effect.gen(function* () {
    const exists = yield* fileExists(state.rootDir, path);
    if (!exists || matchesIgnore(state.ignore, path) || !state.isIndexable(path)) {
      const previous = state.leaves.get(path);
      if (!previous) return null;
      state.leaves.delete(path);
      return { path, type: "deleted" } satisfies ChangedFile;
    }
    const previous = state.leaves.get(path);
    const node = yield* hashFileEffect(state.rootDir, path);
    state.leaves.set(path, node);
    if (previous?.hash === node.hash) return null;
    return {
      path,
      type: previous ? "modified" : "added",
      hash: node.hash,
    } satisfies ChangedFile;
  });

/**
 * Apply a candidate-set update to a previous tree. File IO is bounded by
 * `HASH_CONCURRENCY`. The root is rebuilt only when at least one candidate
 * actually changed.
 */
export const updateMerkleTree = (
  rootDir: string,
  previous: MerkleNode,
  candidates: Iterable<string>,
  isIndexable: (p: string) => boolean = isIndexableTextFile,
): Effect.Effect<MerkleUpdateResult, Error> =>
  Effect.gen(function* () {
    const state: UpdaterState = {
      rootDir,
      isIndexable,
      leaves: collectLeaves(previous),
      ignore: emptyIgnore(),
    };
    state.ignore = yield* loadIgnore(rootDir);

    const normalized = new Set<string>();
    for (const c of candidates) {
      const n = resolveCandidate(rootDir, c);
      if (n) normalized.add(n);
    }

    const changes = (yield* Effect.forEach(
      [...normalized],
      (p) => reconcilePath(state, p),
      { concurrency: HASH_CONCURRENCY },
    )).filter((r): r is ChangedFile => r !== null);

    const root =
      changes.length > 0 ? buildRootFromLeaves(state.leaves.values()) : previous;
    return { changed: changes.length > 0, changes, root };
  });
