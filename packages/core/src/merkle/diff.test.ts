import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MerkleTree } from "./tree";
import { diffTrees } from "./diff";

describe("diffTrees", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "vgrep-diff-test-"));

    await writeFile(join(tempDir, "a.ts"), "const a = 1;");
    await writeFile(join(tempDir, "b.ts"), "const b = 2;");
    await mkdir(join(tempDir, "sub"));
    await writeFile(join(tempDir, "sub", "c.ts"), "const c = 3;");
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("should report all files as added when oldTree is null", async () => {
    const tree = new MerkleTree(tempDir);
    const root = await tree.build();

    const changes = diffTrees(null, root);

    expect(changes.length).toBe(3); // a.ts, b.ts, sub/c.ts
    expect(changes.every((c) => c.type === "added")).toBe(true);
  });

  test("should report no changes when trees are identical", async () => {
    const tree = new MerkleTree(tempDir);
    const root = await tree.build();

    const changes = diffTrees(root, root);

    expect(changes.length).toBe(0);
  });

  test("should detect a modified file", async () => {
    const tree1 = new MerkleTree(tempDir);
    const root1 = await tree1.build();

    // Modify a file
    await writeFile(join(tempDir, "a.ts"), "const a = 999;");

    const tree2 = new MerkleTree(tempDir);
    const root2 = await tree2.build();

    const changes = diffTrees(root1, root2);

    expect(changes.length).toBe(1);
    expect(changes[0].path).toBe("a.ts");
    expect(changes[0].type).toBe("modified");

    // Restore
    await writeFile(join(tempDir, "a.ts"), "const a = 1;");
  });

  test("should detect an added file", async () => {
    const tree1 = new MerkleTree(tempDir);
    const root1 = await tree1.build();

    // Add a new file
    await writeFile(join(tempDir, "d.ts"), "const d = 4;");

    const tree2 = new MerkleTree(tempDir);
    const root2 = await tree2.build();

    const changes = diffTrees(root1, root2);

    expect(changes.length).toBe(1);
    expect(changes[0].path).toBe("d.ts");
    expect(changes[0].type).toBe("added");

    // Clean up
    const { unlink } = await import("node:fs/promises");
    await unlink(join(tempDir, "d.ts"));
  });

  test("should detect a deleted file", async () => {
    // Add a file first
    await writeFile(join(tempDir, "temp.ts"), "const temp = 0;");
    const tree1 = new MerkleTree(tempDir);
    const root1 = await tree1.build();

    // Delete the file
    const { unlink } = await import("node:fs/promises");
    await unlink(join(tempDir, "temp.ts"));

    const tree2 = new MerkleTree(tempDir);
    const root2 = await tree2.build();

    const changes = diffTrees(root1, root2);

    expect(changes.length).toBe(1);
    expect(changes[0].path).toBe("temp.ts");
    expect(changes[0].type).toBe("deleted");
  });

  test("should only descend into changed directories", async () => {
    const tree1 = new MerkleTree(tempDir);
    const root1 = await tree1.build();

    // Modify only a file in the subdirectory
    await writeFile(join(tempDir, "sub", "c.ts"), "const c = 300;");

    const tree2 = new MerkleTree(tempDir);
    const root2 = await tree2.build();

    const changes = diffTrees(root1, root2);

    // Only sub/c.ts should be reported as changed
    expect(changes.length).toBe(1);
    expect(changes[0].path).toContain("c.ts");
    expect(changes[0].type).toBe("modified");

    // Restore
    await writeFile(join(tempDir, "sub", "c.ts"), "const c = 3;");
  });
});
