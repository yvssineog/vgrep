import { join, posix } from "node:path";
import type { MerkleNode, TreeStats } from "../types";
import { isIndexableTextFile } from "../chunking/languages";

/** File name for the user-defined ignore list. */
const VGREPIGNORE_FILE = ".vgrepignore";

interface IgnoreRules {
  exactNames: Set<string>;
  globPatterns: Bun.Glob[];
}

/**
 * Parse ignore patterns into two simple matching buckets.
 *
 * Plain names like `node_modules/` or `.env` become exact names.
 * Patterns with glob metacharacters like `*.log` become Bun.Glob matchers.
 */
function parseIgnorePatterns(patterns: Iterable<string>): IgnoreRules {
  const exactNames = new Set<string>();
  const globPatterns: Bun.Glob[] = [];

  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const pattern = line.endsWith("/") ? line.slice(0, -1) : line;

    if (/[*?{}\[\]]/.test(pattern)) {
      globPatterns.push(new Bun.Glob(pattern));
    } else {
      exactNames.add(normalizeRelativePath(pattern));
    }
  }

  return { exactNames, globPatterns };
}

function mergeIgnoreRules(target: IgnoreRules, source: IgnoreRules): void {
  for (const name of source.exactNames) {
    target.exactNames.add(name);
  }
  target.globPatterns.push(...source.globPatterns);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Builds a Merkle tree from indexed files.
 *
 * Ignore rules are accumulated from two places:
 * 1. extraIgnorePatterns: optional caller-provided patterns for tests/tools.
 * 2. .vgrepignore: project-level user config parsed on build().
 *
 * The CLI creates a default .vgrepignore during `vgrep init`; the core tree
 * builder only applies ignore rules it is explicitly given or can read there.
 *
 * File discovery uses Bun.Glob, file reads use Bun.file(), and hashing uses
 * Bun.CryptoHasher. Empty directories are not represented because they do not
 * affect the content index.
 */
export class MerkleTree {
  private root: MerkleNode | null = null;
  private ignoreRules: IgnoreRules;

  constructor(
    private readonly rootDir: string,
    extraIgnorePatterns: string[] = [],
    private readonly isIndexableFile: (relativePath: string) => boolean =
      isIndexableTextFile,
  ) {
    this.ignoreRules = parseIgnorePatterns(extraIgnorePatterns);
  }

  /**
   * Build the Merkle tree and return its root node.
   */
  async build(): Promise<MerkleNode> {
    await this.loadVgrepignore();
    this.root = await this.buildFromFiles();
    return this.root;
  }

  /** Get the root node (must call build() first). */
  getRoot(): MerkleNode {
    if (!this.root) {
      throw new Error("MerkleTree not built yet. Call build() first.");
    }
    return this.root;
  }

  /** Compute tree statistics. */
  getStats(): TreeStats {
    const root = this.getRoot();
    let totalFiles = 0;
    let totalDirectories = 0;
    let totalSizeBytes = 0;

    const walk = (node: MerkleNode): void => {
      if (node.type === "file") {
        totalFiles++;
        totalSizeBytes += node.size ?? 0;
      } else {
        totalDirectories++;
        node.children?.forEach(walk);
      }
    };

    walk(root);

    return {
      totalFiles,
      totalDirectories,
      totalSizeBytes,
      rootHash: root.hash,
    };
  }

  /** Serialize the tree to a JSON string. */
  serialize(): string {
    return JSON.stringify(this.getRoot(), null, 2);
  }

  /** Deserialize a JSON string into a MerkleNode tree. */
  static deserialize(json: string): MerkleNode {
    return JSON.parse(json) as MerkleNode;
  }

  /** Collect all leaf (file) hashes for simhash computation. */
  collectFileHashes(): string[] {
    const hashes: string[] = [];
    const walk = (node: MerkleNode): void => {
      if (node.type === "file") {
        hashes.push(node.hash);
      } else {
        node.children?.forEach(walk);
      }
    };
    walk(this.getRoot());
    return hashes;
  }

  private async loadVgrepignore(): Promise<void> {
    const ignoreFile = Bun.file(join(this.rootDir, VGREPIGNORE_FILE));
    if (!(await ignoreFile.exists())) return;

    const content = await ignoreFile.text();
    mergeIgnoreRules(this.ignoreRules, parseIgnorePatterns(content.split("\n")));
  }

  private isIgnored(relativePath: string): boolean {
    const normalizedPath = normalizeRelativePath(relativePath);
    const name = posix.basename(normalizedPath);
    const segments = normalizedPath.split("/");

    if (
      this.ignoreRules.exactNames.has(name) ||
      this.ignoreRules.exactNames.has(normalizedPath) ||
      segments.some((segment) => this.ignoreRules.exactNames.has(segment))
    ) {
      return true;
    }

    for (const glob of this.ignoreRules.globPatterns) {
      if (glob.match(name) || glob.match(normalizedPath)) return true;
    }

    return false;
  }

  private async buildFromFiles(): Promise<MerkleNode> {
    const glob = new Bun.Glob("**/*");
    const filePaths: string[] = [];

    for await (const path of glob.scan({
      cwd: this.rootDir,
      dot: true,
      onlyFiles: true,
    })) {
      const relativePath = normalizeRelativePath(path);
      if (
        !this.isIgnored(relativePath) &&
        this.isIndexableFile(relativePath)
      ) {
        filePaths.push(relativePath);
      }
    }

    filePaths.sort((a, b) => a.localeCompare(b));

    const fileNodes = await Promise.all(
      filePaths.map((relativePath) => this.hashFile(relativePath)),
    );

    const directoryChildren = new Map<string, MerkleNode[]>();
    directoryChildren.set(".", []);

    for (const fileNode of fileNodes) {
      const dirPath = posix.dirname(fileNode.path);
      this.ensureDirectoryPath(directoryChildren, dirPath);
      directoryChildren.get(dirPath)!.push(fileNode);
    }

    return this.buildDirectoryNode(".", directoryChildren);
  }

  private async hashFile(relativePath: string): Promise<MerkleNode> {
    const absolutePath = join(this.rootDir, ...relativePath.split("/"));
    const file = Bun.file(absolutePath);
    const content = await file.bytes();
    const hash = Bun.CryptoHasher.hash("sha256", content, "hex");

    return {
      path: relativePath,
      type: "file",
      hash,
      size: file.size,
      mtime: file.lastModified,
    };
  }

  private ensureDirectoryPath(
    directoryChildren: Map<string, MerkleNode[]>,
    dirPath: string,
  ): void {
    if (directoryChildren.has(dirPath)) return;

    const parentPath = posix.dirname(dirPath);
    this.ensureDirectoryPath(directoryChildren, parentPath);

    const directoryNode: MerkleNode = {
      path: dirPath,
      type: "directory",
      hash: "",
      children: [],
    };

    directoryChildren.set(dirPath, directoryNode.children!);
    directoryChildren.get(parentPath)!.push(directoryNode);
  }

  private buildDirectoryNode(
    path: string,
    directoryChildren: Map<string, MerkleNode[]>,
  ): MerkleNode {
    const children = directoryChildren.get(path) ?? [];

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === "directory") {
        children[i] = this.buildDirectoryNode(child.path, directoryChildren);
      }
    }

    children.sort((a, b) => a.path.localeCompare(b.path));

    const hash = Bun.CryptoHasher.hash(
      "sha256",
      children.map((child) => child.hash).join("\n"),
      "hex",
    );

    return {
      path,
      type: "directory",
      hash,
      children,
    };
  }
}
