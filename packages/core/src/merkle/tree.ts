import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MerkleNode, TreeStats } from "../types";

/** File name for the user-defined ignore list (like .gitignore). */
const VGREPIGNORE_FILE = ".vgrepignore";

/**
 * Default ignore patterns — always excluded, even without a .vgrepignore file.
 */
const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".vgrep",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".DS_Store",
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/**
 * Parse a .vgrepignore file into two buckets:
 *   - exactNames: simple names with no wildcards (e.g. "tmp", ".env")
 *   - globPatterns: patterns containing wildcards (e.g. "*.log", "**\/*.test.ts")
 *
 * Syntax rules (same conventions as .gitignore):
 *   - Empty lines and lines starting with `#` are ignored.
 *   - Trailing `/` marks a directory-only pattern (stripped before matching).
 *   - All other lines are matched against both the entry's base name
 *     and its relative path from the project root.
 */
function parseIgnoreFile(content: string): {
  exactNames: Set<string>;
  globPatterns: Bun.Glob[];
} {
  const exactNames = new Set<string>();
  const globPatterns: Bun.Glob[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) continue;

    // Strip trailing slash (directory marker — we ignore dirs and files alike)
    const pattern = line.endsWith("/") ? line.slice(0, -1) : line;

    // If the pattern contains glob metacharacters → compile to Bun.Glob
    if (/[*?{}\[\]]/.test(pattern)) {
      globPatterns.push(new Bun.Glob(pattern));
    } else {
      exactNames.add(pattern);
    }
  }

  return { exactNames, globPatterns };
}

/**
 * Builds a Merkle tree from a directory on disk.
 *
 * Each file node's hash is SHA-256(file content).
 * Each directory node's hash is SHA-256(sorted child hashes joined by newline).
 *
 * Ignore rules are resolved in order:
 *   1. DEFAULT_IGNORE — hardcoded names always excluded.
 *   2. .vgrepignore  — project-level ignore file (parsed on build()).
 *   3. additionalIgnores — programmatic overrides passed to the constructor.
 *
 * Uses Bun.file() for zero-copy file reads — significantly faster than
 * Node's fs.readFile() thanks to Bun's optimized I/O pipeline.
 *
 * The tree is built fully asynchronously with concurrent I/O.
 */
export class MerkleTree {
  private root: MerkleNode | null = null;

  /** Exact-name ignores (DEFAULT_IGNORE + .vgrepignore simple names + additionalIgnores). */
  private exactIgnores: Set<string>;

  /** Glob-based ignores from .vgrepignore (e.g. "*.log", "docs/**"). */
  private globIgnores: Bun.Glob[] = [];

  constructor(
    private readonly rootDir: string,
    additionalIgnores: string[] = [],
  ) {
    this.exactIgnores = new Set([...DEFAULT_IGNORE, ...additionalIgnores]);
  }

  /**
   * Build the Merkle tree by recursively walking the file system.
   * Loads .vgrepignore from the project root before walking.
   * Returns the root MerkleNode.
   */
  async build(): Promise<MerkleNode> {
    await this.loadVgrepignore();
    this.root = await this.walkDir(this.rootDir, ".");
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

  // ─── Private helpers ───────────────────────────────────────────

  /**
   * Load and parse .vgrepignore from the project root (if it exists).
   */
  private async loadVgrepignore(): Promise<void> {
    const ignoreFile = Bun.file(join(this.rootDir, VGREPIGNORE_FILE));

    if (!(await ignoreFile.exists())) return;

    const content = await ignoreFile.text();
    const { exactNames, globPatterns } = parseIgnoreFile(content);

    // Merge into the existing ignore sets
    for (const name of exactNames) {
      this.exactIgnores.add(name);
    }
    this.globIgnores = globPatterns;
  }

  /**
   * Check whether a file or directory should be ignored.
   *
   * @param name         - Base name of the entry (e.g. "utils.ts")
   * @param relativePath - Path relative to the project root (e.g. "src/utils.ts")
   */
  private isIgnored(name: string, relativePath: string): boolean {
    // 1. Exact name match (fastest path)
    if (this.exactIgnores.has(name)) return true;

    // 2. Glob pattern match against both base name and relative path
    for (const glob of this.globIgnores) {
      if (glob.match(name) || glob.match(relativePath)) return true;
    }

    return false;
  }

  /**
   * Walk a directory recursively, building MerkleNode tree.
   */
  private async walkDir(
    absolutePath: string,
    relativePath: string,
  ): Promise<MerkleNode> {
    const entries = await readdir(absolutePath, { withFileTypes: true });

    // Filter out ignored entries
    const filtered = entries.filter((entry) => {
      const childRelative =
        relativePath === "." ? entry.name : join(relativePath, entry.name);
      return !this.isIgnored(entry.name, childRelative);
    });

    // Process children concurrently
    const childPromises = filtered.map(async (entry) => {
      const childAbsolute = join(absolutePath, entry.name);
      const childRelative =
        relativePath === "." ? entry.name : join(relativePath, entry.name);

      if (entry.isDirectory()) {
        return this.walkDir(childAbsolute, childRelative);
      }

      if (entry.isFile()) {
        return this.hashFile(childAbsolute, childRelative);
      }

      // Skip symlinks, sockets, etc.
      return null;
    });

    const children = (await Promise.all(childPromises)).filter(
      (c): c is MerkleNode => c !== null,
    );

    // Sort children deterministically by path
    children.sort((a, b) => a.path.localeCompare(b.path));

    // Directory hash = SHA-256 of sorted child hashes
    const dirHash = createHash("sha256")
      .update(children.map((c) => c.hash).join("\n"))
      .digest("hex");

    return {
      path: relativePath,
      type: "directory",
      hash: dirHash,
      children,
    };
  }

  /**
   * Hash a single file using Bun.file() — zero-copy optimized I/O.
   * Avoids Node's fs.readFile() + fs.stat() double syscall overhead.
   */
  private async hashFile(
    absolutePath: string,
    relativePath: string,
  ): Promise<MerkleNode> {
    const file = Bun.file(absolutePath);

    // Bun.file().bytes() is the fastest path — zero-copy Uint8Array
    const content = await file.bytes();
    const hash = createHash("sha256").update(content).digest("hex");

    return {
      path: relativePath,
      type: "file",
      hash,
      size: file.size,
      mtime: file.lastModified,
    };
  }
}
