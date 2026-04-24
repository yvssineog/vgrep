import { describe, test, expect, beforeAll } from "bun:test";
import { chunkFile, initTreeSitter } from "./chunker";

beforeAll(async () => {
  // Initialize Tree-sitter WASM runtime once
  await initTreeSitter();
});

describe("chunkFile", () => {
  test("should return empty array for empty file", async () => {
    const chunks = await chunkFile("empty.ts", "");
    expect(chunks.length).toBe(0);
  });

  test("should return empty array for whitespace-only file", async () => {
    const chunks = await chunkFile("blank.ts", "   \n  \n  ");
    expect(chunks.length).toBe(0);
  });

  test("should return a single chunk for a small file", async () => {
    const content = 'const x = 1;\nconst y = 2;\nconsole.log(x + y);';
    const chunks = await chunkFile("small.ts", content);

    expect(chunks.length).toBe(1);
    expect(chunks[0].filePath).toBe("small.ts");
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
    expect(chunks[0].language).toBe("typescript");
    expect(chunks[0].chunkHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("should split TypeScript file at function boundaries", async () => {
    const lines: string[] = [];

    // Function 1 (10 lines)
    lines.push("export function hello() {");
    for (let i = 0; i < 8; i++) lines.push(`  console.log("line ${i}");`);
    lines.push("}");

    // Gap
    lines.push("");

    // Function 2 (10 lines)
    lines.push("export function world() {");
    for (let i = 0; i < 8; i++) lines.push(`  console.log("line ${i}");`);
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await chunkFile("funcs.ts", content);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk should contain "hello"
    expect(chunks[0].content).toContain("hello");
    // Last chunk should contain "world"
    expect(chunks[chunks.length - 1].content).toContain("world");
  });

  test("should not duplicate leading comments across chunks", async () => {
    const content = [
      "import x from 'x';",
      "// docs",
      "export function foo() {",
      "  return 1;",
      "}",
      "",
      "// docs two",
      "export function bar() {",
      "  return 2;",
      "}",
    ].join("\n");

    const chunks = await chunkFile("comments.ts", content);
    const lineOccurrences = new Map<number, number>();

    for (const chunk of chunks) {
      for (let line = chunk.startLine; line <= chunk.endLine; line++) {
        lineOccurrences.set(line, (lineOccurrences.get(line) ?? 0) + 1);
      }
    }

    expect(lineOccurrences.get(2)).toBe(1);
    expect(lineOccurrences.get(7)).toBe(1);
  });

  test("should split Python file at def/class boundaries", async () => {
    const content = [
      "import os",
      "",
      "class MyClass:",
      "    def __init__(self):",
      "        self.x = 1",
      "        self.y = 2",
      "        self.z = 3",
      "        self.w = 4",
      "",
      "def standalone_function():",
      "    pass",
      "    # more code",
      "    # more code",
      "    # more code",
      "    # more code",
    ].join("\n");

    const chunks = await chunkFile("module.py", content);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].language).toBe("python");
  });

  test("should use sliding window for unknown extensions", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    const chunks = await chunkFile("mystery.xyz", content);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].language).toBeUndefined();
  });

  test("should subdivide oversized functions into sub-chunks", async () => {
    const lines: string[] = [];
    lines.push("export function bigFunction() {");
    for (let i = 0; i < 100; i++) {
      lines.push(`  const line${i} = ${i};`);
    }
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await chunkFile("big.ts", content);

    // 102 lines total > MAX_CHUNK_LINES, so should be subdivided
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // All lines should be covered
    const firstLine = Math.min(...chunks.map((c) => c.startLine));
    const lastLine = Math.max(...chunks.map((c) => c.endLine));
    expect(firstLine).toBe(1);
    expect(lastLine).toBeGreaterThanOrEqual(100);
  });

  test("should produce deterministic chunk hashes", async () => {
    const content = "export function test() {\n  return 42;\n}";
    const chunks1 = await chunkFile("det.ts", content);
    const chunks2 = await chunkFile("det.ts", content);

    expect(chunks1.length).toBe(chunks2.length);
    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i].chunkHash).toBe(chunks2[i].chunkHash);
    }
  });

  test("should use sliding window for JSON files", async () => {
    const lines = Array.from(
      { length: 120 },
      (_, i) => `  "key${i}": "value${i}",`,
    );
    lines.unshift("{");
    lines.push("}");

    const content = lines.join("\n");
    const chunks = await chunkFile("data.json", content);

    // With 122 lines, should produce multiple chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
