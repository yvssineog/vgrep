import { join, posix } from "node:path";
import { Effect } from "effect";
import type { MerkleNode } from "../types";

/** Compute SHA-256 of a file's bytes; package as a Merkle leaf node. */
export const hashFileEffect = (
  rootDir: string,
  relativePath: string,
): Effect.Effect<MerkleNode, Error> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(join(rootDir, ...relativePath.split("/")));
      const content = await file.bytes();
      return {
        path: relativePath,
        type: "file",
        hash: Bun.CryptoHasher.hash("sha256", content, "hex"),
        size: file.size,
        mtime: file.lastModified,
      };
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

/**
 * Rebuild a directory tree from a flat collection of file leaves.
 * Each directory's hash is `sha256(child.hash \n child.hash …)` with children
 * sorted by path so the root hash is deterministic.
 */
export function buildRootFromLeaves(leaves: Iterable<MerkleNode>): MerkleNode {
  const dirs = new Map<string, MerkleNode[]>();
  dirs.set(".", []);

  const ensureDir = (dirPath: string): void => {
    if (dirs.has(dirPath)) return;
    ensureDir(posix.dirname(dirPath));
    const node: MerkleNode = {
      path: dirPath,
      type: "directory",
      hash: "",
      children: [],
    };
    dirs.set(dirPath, node.children!);
    dirs.get(posix.dirname(dirPath))!.push(node);
  };

  for (const file of leaves) {
    const dirPath = posix.dirname(file.path);
    ensureDir(dirPath);
    dirs.get(dirPath)!.push({ ...file });
  }

  const buildDir = (path: string): MerkleNode => {
    const children = dirs.get(path) ?? [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      if (c.type === "directory") children[i] = buildDir(c.path);
    }
    children.sort((a, b) => a.path.localeCompare(b.path));
    return {
      path,
      type: "directory",
      hash: Bun.CryptoHasher.hash(
        "sha256",
        children.map((c) => c.hash).join("\n"),
        "hex",
      ),
      children,
    };
  };

  return buildDir(".");
}
