import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MerkleTree } from "./tree";
import {
  DEFAULT_FILE_PROFILES,
  createIndexableFileMatcher,
} from "../chunking/languages";

describe("MerkleTree", () => {
  let tempDir: string;

  beforeAll(async () => {
    // Create a temp directory with a deterministic file structure
    tempDir = await mkdtemp(join(tmpdir(), "vgrep-test-"));

    // Create files
    await writeFile(join(tempDir, "hello.ts"), 'console.log("hello");');
    await writeFile(join(tempDir, "world.ts"), 'console.log("world");');

    // Create a subdirectory with files
    await mkdir(join(tempDir, "src"));
    await writeFile(join(tempDir, "src", "index.ts"), "export {};");
    await writeFile(
      join(tempDir, "src", "utils.ts"),
      "export const add = (a: number, b: number) => a + b;",
    );

    // Create nested subdirectory
    await mkdir(join(tempDir, "src", "lib"));
    await writeFile(
      join(tempDir, "src", "lib", "helper.ts"),
      "export const identity = <T>(x: T): T => x;",
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("should build a tree with correct structure", async () => {
    const tree = new MerkleTree(tempDir);
    const root = await tree.build();

    expect(root.type).toBe("directory");
    expect(root.path).toBe(".");
    expect(root.hash).toBeTruthy();
    expect(root.children).toBeDefined();
    expect(root.children!.length).toBeGreaterThan(0);
  });

  test("should produce deterministic hashes", async () => {
    const tree1 = new MerkleTree(tempDir);
    const root1 = await tree1.build();

    const tree2 = new MerkleTree(tempDir);
    const root2 = await tree2.build();

    expect(root1.hash).toBe(root2.hash);
  });

  test("should have correct file count in stats", async () => {
    const tree = new MerkleTree(tempDir);
    await tree.build();
    const stats = tree.getStats();

    expect(stats.totalFiles).toBe(5); // hello.ts, world.ts, src/index.ts, src/utils.ts, src/lib/helper.ts
    expect(stats.totalDirectories).toBe(3); // root(.), src, src/lib
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
    expect(stats.rootHash).toBeTruthy();
  });

  test("should serialize and deserialize correctly", async () => {
    const tree = new MerkleTree(tempDir);
    const root = await tree.build();

    const json = tree.serialize();
    const deserialized = MerkleTree.deserialize(json);

    expect(deserialized.hash).toBe(root.hash);
    expect(deserialized.type).toBe("directory");
    expect(deserialized.children?.length).toBe(root.children?.length);
  });

  test("should collect all file hashes", async () => {
    const tree = new MerkleTree(tempDir);
    await tree.build();
    const hashes = tree.collectFileHashes();

    expect(hashes.length).toBe(5);
    // All hashes should be valid SHA-256 hex strings (64 chars)
    for (const h of hashes) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("should ignore directories listed in .vgrepignore", async () => {
    await writeFile(join(tempDir, ".vgrepignore"), "node_modules/\n");
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFile(
      join(tempDir, "node_modules", "dep"),
      "module.exports = {};",
    );

    const tree = new MerkleTree(tempDir);
    await tree.build();
    const root = tree.getRoot();

    const filePaths: string[] = [];
    const walk = (node: typeof root): void => {
      if (node.type === "file") {
        filePaths.push(node.path);
      } else {
        node.children?.forEach(walk);
      }
    };
    walk(root);

    expect(filePaths).not.toContain("node_modules/dep");
    expect(filePaths).not.toContain(".vgrepignore");

    // Clean up
    await rm(join(tempDir, "node_modules"), { recursive: true, force: true });
    await rm(join(tempDir, ".vgrepignore"), { force: true });
  });

  test("should skip binary and non-code files", async () => {
    await writeFile(
      join(tempDir, "image.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    await writeFile(join(tempDir, "data.json"), '{"not":"logic"}');
    await writeFile(join(tempDir, "styles.css"), ".button { color: red; }");

    const tree = new MerkleTree(tempDir);
    await tree.build();
    const root = tree.getRoot();

    const filePaths: string[] = [];
    const walk = (node: typeof root): void => {
      if (node.type === "file") {
        filePaths.push(node.path);
      } else {
        node.children?.forEach(walk);
      }
    };
    walk(root);

    expect(filePaths).not.toContain("image.png");
    expect(filePaths).not.toContain("data.json");
    expect(filePaths).not.toContain("styles.css");

    await rm(join(tempDir, "image.png"), { force: true });
    await rm(join(tempDir, "data.json"), { force: true });
    await rm(join(tempDir, "styles.css"), { force: true });
  });

  test("should include non-code files when their profiles are selected", async () => {
    await writeFile(join(tempDir, "notes.md"), "# useful docs");
    await writeFile(join(tempDir, "data.json"), '{"useful":"data"}');

    const tree = new MerkleTree(
      tempDir,
      [],
      createIndexableFileMatcher(["code", "docs", "data"], DEFAULT_FILE_PROFILES),
    );
    await tree.build();
    const root = tree.getRoot();

    const filePaths: string[] = [];
    const walk = (node: typeof root): void => {
      if (node.type === "file") {
        filePaths.push(node.path);
      } else {
        node.children?.forEach(walk);
      }
    };
    walk(root);

    expect(filePaths).toContain("notes.md");
    expect(filePaths).toContain("data.json");

    await rm(join(tempDir, "notes.md"), { force: true });
    await rm(join(tempDir, "data.json"), { force: true });
  });

  test("should change root hash when a file changes", async () => {
    const tree1 = new MerkleTree(tempDir);
    await tree1.build();
    const hash1 = tree1.getRoot().hash;

    // Modify a file
    await writeFile(join(tempDir, "hello.ts"), 'console.log("modified");');

    const tree2 = new MerkleTree(tempDir);
    await tree2.build();
    const hash2 = tree2.getRoot().hash;

    expect(hash1).not.toBe(hash2);

    // Restore original
    await writeFile(join(tempDir, "hello.ts"), 'console.log("hello");');
  });
});
