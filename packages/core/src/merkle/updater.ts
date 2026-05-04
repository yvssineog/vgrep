import type { ChangedFile, MerkleNode } from "../types";
import { isIndexableTextFile } from "../chunking/languages";

const VGREPIGNORE_FILE = ".vgrepignore";

interface IgnoreRules {
  exactNames: Set<string>;
  globPatterns: Bun.Glob[];
}

export interface MerkleUpdateResult {
  changed: boolean;
  changes: ChangedFile[];
  root: MerkleNode;
}

export class MerkleTreeUpdater {
  private readonly leaves = new Map<string, MerkleNode>();
  private ignoreRules: IgnoreRules = {
    exactNames: new Set(),
    globPatterns: [],
  };
  private ignoreLoaded = false;

  constructor(
    private readonly rootDir: string,
    private root: MerkleNode,
    private readonly isIndexableFile: (relativePath: string) => boolean =
      isIndexableTextFile,
  ) {
    this.collectLeaves(root);
  }

  getRoot(): MerkleNode {
    return this.root;
  }

  serialize(): string {
    return JSON.stringify(this.root, null, 2);
  }

  async updateCandidates(
    candidates: Iterable<string>,
  ): Promise<MerkleUpdateResult> {
    await this.loadVgrepignore();

    const changes: ChangedFile[] = [];
    const normalized = new Set<string>();
    for (const candidate of candidates) {
      const path = normalizeCandidate(this.rootDir, candidate);
      if (path) normalized.add(path);
    }

    for (const path of normalized) {
      await this.updatePath(path, changes);
    }

    if (changes.length > 0) {
      this.root = buildRootFromLeaves(this.leaves);
    }

    return {
      changed: changes.length > 0,
      changes,
      root: this.root,
    };
  }

  private collectLeaves(node: MerkleNode): void {
    if (node.type === "file") {
      this.leaves.set(node.path, { ...node });
      return;
    }

    for (const child of node.children ?? []) {
      this.collectLeaves(child);
    }
  }

  private async updatePath(
    path: string,
    changes: ChangedFile[],
  ): Promise<void> {
    const absolutePath = joinPath(this.rootDir, path);
    const file = Bun.file(absolutePath);
    const exists = await file.exists();

    if (!exists) {
      this.deletePath(path, changes);
      return;
    }

    if (this.isIgnored(path) || !this.isIndexableFile(path)) {
      this.deletePath(path, changes);
      return;
    }

    await this.updateFile(path, changes);
  }

  private async updateDirectory(
    path: string,
    changes: ChangedFile[],
  ): Promise<void> {
    if (this.isIgnored(path)) {
      this.deletePath(path, changes);
      return;
    }

    const prefix = path === "." ? "" : `${path}/`;
    const seen = new Set<string>();
    const glob = new Bun.Glob("**/*");

    for await (const child of glob.scan({
      cwd: joinPath(this.rootDir, path),
      dot: true,
      onlyFiles: true,
    })) {
      const relativePath = normalizeRelativePath(`${prefix}${child}`);
      seen.add(relativePath);
      await this.updatePath(relativePath, changes);
    }

    for (const existing of [...this.leaves.keys()]) {
      if (existing.startsWith(prefix) && !seen.has(existing)) {
        this.deletePath(existing, changes);
      }
    }
  }

  private async updateFile(
    path: string,
    changes: ChangedFile[],
  ): Promise<void> {
    const previous = this.leaves.get(path);
    const node = await hashFile(this.rootDir, path);

    if (previous?.hash === node.hash) {
      this.leaves.set(path, node);
      return;
    }

    this.leaves.set(path, node);
    changes.push({
      path,
      type: previous ? "modified" : "added",
      hash: node.hash,
    });
  }

  private deletePath(path: string, changes: ChangedFile[]): void {
    const deleted = new Set<string>();

    if (this.leaves.has(path)) {
      deleted.add(path);
    }

    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const existing of this.leaves.keys()) {
      if (existing.startsWith(prefix)) {
        deleted.add(existing);
      }
    }

    for (const filePath of deleted) {
      this.leaves.delete(filePath);
      changes.push({ path: filePath, type: "deleted" });
    }
  }

  private async loadVgrepignore(): Promise<void> {
    if (this.ignoreLoaded) return;
    this.ignoreLoaded = true;

    const ignoreFile = Bun.file(joinPath(this.rootDir, VGREPIGNORE_FILE));
    if (!(await ignoreFile.exists())) return;

    const content = await ignoreFile.text();
    this.ignoreRules = parseIgnorePatterns(content.split("\n"));
  }

  private isIgnored(relativePath: string): boolean {
    const normalizedPath = normalizeRelativePath(relativePath);
    const name = basename(normalizedPath);
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
}

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

async function hashFile(
  rootDir: string,
  relativePath: string,
): Promise<MerkleNode> {
  const absolutePath = joinPath(rootDir, relativePath);
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

function buildRootFromLeaves(leaves: Map<string, MerkleNode>): MerkleNode {
  const directoryChildren = new Map<string, MerkleNode[]>();
  directoryChildren.set(".", []);

  for (const fileNode of leaves.values()) {
    const dirPath = dirname(fileNode.path);
    ensureDirectoryPath(directoryChildren, dirPath);
    directoryChildren.get(dirPath)!.push({ ...fileNode });
  }

  return buildDirectoryNode(".", directoryChildren);
}

function ensureDirectoryPath(
  directoryChildren: Map<string, MerkleNode[]>,
  dirPath: string,
): void {
  if (directoryChildren.has(dirPath)) return;

  const parentPath = dirname(dirPath);
  ensureDirectoryPath(directoryChildren, parentPath);

  const directoryNode: MerkleNode = {
    path: dirPath,
    type: "directory",
    hash: "",
    children: [],
  };

  directoryChildren.set(dirPath, directoryNode.children!);
  directoryChildren.get(parentPath)!.push(directoryNode);
}

function buildDirectoryNode(
  path: string,
  directoryChildren: Map<string, MerkleNode[]>,
): MerkleNode {
  const children = directoryChildren.get(path) ?? [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.type === "directory") {
      children[i] = buildDirectoryNode(child.path, directoryChildren);
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

function normalizeCandidate(rootDir: string, candidate: string): string | null {
  const relativePath = isAbsolutePath(candidate)
    ? relativePathFrom(rootDir, candidate)
    : candidate;
  const normalized = normalizeRelativePath(relativePath);

  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    return null;
  }

  return normalized;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeSystemPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function joinPath(base: string, relativePath: string): string {
  const normalizedBase = normalizeSystemPath(base);
  const normalizedRelative = normalizeRelativePath(relativePath);
  if (!normalizedRelative || normalizedRelative === ".") return normalizedBase;
  return `${normalizedBase}/${normalizedRelative}`;
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function relativePathFrom(rootDir: string, absolutePath: string): string {
  const root = normalizeSystemPath(rootDir).toLowerCase();
  const target = normalizeSystemPath(absolutePath);
  const lowerTarget = target.toLowerCase();
  if (lowerTarget === root) return ".";
  if (lowerTarget.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  return target;
}

function basename(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function dirname(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}
