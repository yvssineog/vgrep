import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingModelV2 } from "@ai-sdk/provider";
import { LocalEngine } from "./local-engine";

const staticModel: EmbeddingModelV2<string> = {
  specificationVersion: "v2",
  provider: "test",
  modelId: "static",
  maxEmbeddingsPerCall: 100,
  supportsParallelCalls: true,
  async doEmbed({ values }) {
    return { embeddings: values.map(() => [1, 0, 0]) };
  },
};

describe("LocalEngine", () => {
  test("upsert inserts searchable rows", async () => {
    const dir = await makeTempDir();
    const engine = new LocalEngine({
      dbPath: join(dir, "lancedb"),
      cacheDir: join(dir, "cache"),
      embeddingModel: staticModel,
    });

    try {
      await engine.upsert([
        {
          filePath: "src/auth.ts",
          chunkHash: "auth",
          content: "function authenticateUser() {}",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          vector: [1, 0, 0],
        },
        {
          filePath: "src/log.ts",
          chunkHash: "log",
          content: "function writeLog() {}",
          startLine: 3,
          endLine: 3,
          language: "typescript",
          vector: [0, 1, 0],
        },
      ]);

      const results = await engine.search("auth", 1);

      expect(results).toHaveLength(1);
      expect(results[0]!.filePath).toBe("src/auth.ts");
      expect(results[0]!.score).toBeGreaterThan(0.9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deleteByFile removes all chunks for a file", async () => {
    const dir = await makeTempDir();
    const engine = new LocalEngine({
      dbPath: join(dir, "lancedb"),
      cacheDir: join(dir, "cache"),
      embeddingModel: staticModel,
    });

    try {
      await engine.upsert([
        {
          filePath: "src/auth.ts",
          chunkHash: "auth-a",
          content: "function authenticateUser() {}",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          vector: [1, 0, 0],
        },
        {
          filePath: "src/auth.ts",
          chunkHash: "auth-b",
          content: "function verifyToken() {}",
          startLine: 3,
          endLine: 3,
          language: "typescript",
          vector: [1, 0, 0],
        },
      ]);

      await engine.deleteByFile(["src/auth.ts"]);

      const results = await engine.search("auth", 5);
      expect(results).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("upsert skips non-finite vectors", async () => {
    const dir = await makeTempDir();
    const engine = new LocalEngine({
      dbPath: join(dir, "lancedb"),
      cacheDir: join(dir, "cache"),
      embeddingModel: staticModel,
    });

    try {
      await engine.upsert([
        {
          filePath: "src/bad.ts",
          chunkHash: "bad",
          content: "bad vector",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          vector: [Number.NaN, 0, 0],
        },
      ]);

      expect(await engine.hasIndex("ignored")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function makeTempDir(): Promise<string> {
  const root = join(process.cwd(), ".tmp-tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "vgrep-lancedb-test-"));
}
