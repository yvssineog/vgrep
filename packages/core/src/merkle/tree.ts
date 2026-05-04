import { Effect } from "effect";
import type { MerkleNode, TreeStats } from "../types";
import { isIndexableTextFile } from "../chunking/languages";
import {
  emptyIgnore,
  loadIgnore,
  matchesIgnore,
  mergeIgnore,
  parseIgnore,
  type IgnoreRules,
} from "../ignore";
import { toRelative } from "../util/paths";
import { buildRootFromLeaves, hashFileEffect } from "./internal";

const FILE_HASH_CONCURRENCY = 32;

const scanFiles = (rootDir: string): Effect.Effect<string[], Error> =>
  Effect.tryPromise({
    try: async () => {
      const out: string[] = [];
      for await (const path of new Bun.Glob("**/*").scan({
        cwd: rootDir,
        dot: true,
        onlyFiles: true,
      })) {
        out.push(toRelative(path));
      }
      return out;
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

/**
 * Build a Merkle tree of the project under `rootDir`.
 *
 * - Concurrency is bounded by `FILE_HASH_CONCURRENCY` (file hashing is IO-
 *   bound; 32 saturates SSDs without blowing up open-fd counts).
 * - Ignore rules layer: `extraIgnore` (caller-provided) merged onto the
 *   `.vgrepignore` discovered at the project root.
 */
export const buildMerkleTree = (
  rootDir: string,
  isIndexable: (relativePath: string) => boolean = isIndexableTextFile,
  extraIgnore: IgnoreRules = emptyIgnore(),
): Effect.Effect<MerkleNode, Error> =>
  Effect.gen(function* () {
    const rules = emptyIgnore();
    mergeIgnore(rules, extraIgnore);
    mergeIgnore(rules, yield* loadIgnore(rootDir));

    const filtered = (yield* scanFiles(rootDir))
      .filter((p) => !matchesIgnore(rules, p) && isIndexable(p))
      .sort((a, b) => a.localeCompare(b));

    const fileNodes = yield* Effect.forEach(
      filtered,
      (p) => hashFileEffect(rootDir, p),
      { concurrency: FILE_HASH_CONCURRENCY },
    );

    return buildRootFromLeaves(fileNodes);
  });

/** Parse a previously-serialized tree (the format is plain JSON). */
export const deserializeTree = (json: string): MerkleNode =>
  JSON.parse(json) as MerkleNode;

/** Walk a tree and report file/directory counts and total bytes. */
export function treeStats(root: MerkleNode): TreeStats {
  let totalFiles = 0;
  let totalDirectories = 0;
  let totalSizeBytes = 0;
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") {
      totalFiles++;
      totalSizeBytes += n.size ?? 0;
    } else {
      totalDirectories++;
      n.children?.forEach(walk);
    }
  };
  walk(root);
  return { totalFiles, totalDirectories, totalSizeBytes, rootHash: root.hash };
}

/** Collect all file (leaf) hashes in tree order — used as input to simhash. */
export function collectFileHashes(root: MerkleNode): string[] {
  const out: string[] = [];
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") out.push(n.hash);
    else n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Class wrapper kept for the test suite (`new MerkleTree(...).build()`).
 * New code should call `buildMerkleTree(...)` directly.
 */
export class MerkleTree {
  private root: MerkleNode | null = null;
  constructor(
    private readonly rootDir: string,
    private readonly extraIgnorePatterns: string[] = [],
    private readonly isIndexableFile: (relativePath: string) => boolean =
      isIndexableTextFile,
  ) {}

  async build(): Promise<MerkleNode> {
    this.root = await Effect.runPromise(
      buildMerkleTree(
        this.rootDir,
        this.isIndexableFile,
        parseIgnore(this.extraIgnorePatterns),
      ),
    );
    return this.root;
  }

  getRoot(): MerkleNode {
    if (!this.root)
      throw new Error("MerkleTree not built yet. Call build() first.");
    return this.root;
  }

  getStats(): TreeStats {
    return treeStats(this.getRoot());
  }

  serialize(): string {
    return JSON.stringify(this.getRoot(), null, 2);
  }

  collectFileHashes(): string[] {
    return collectFileHashes(this.getRoot());
  }

  static deserialize = deserializeTree;
}
