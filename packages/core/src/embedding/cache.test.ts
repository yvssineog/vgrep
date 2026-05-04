import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import type { EmbeddingModelV2 } from "@ai-sdk/provider";
import { embedChunksEffect } from "./embedder";

function countingModel(): {
  model: EmbeddingModelV2<string>;
  calls: () => number;
} {
  let calls = 0;
  const model: EmbeddingModelV2<string> = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "counting",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    async doEmbed({ values }) {
      calls += 1;
      return { embeddings: values.map(() => [0.1, 0.2, 0.3]) };
    },
  };
  return { model, calls: () => calls };
}

describe("embedChunksEffect", () => {
  test("cache miss writes a reusable vector and later hits avoid the model", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "vgrep-cache-test-"));
    const { model, calls } = countingModel();
    const chunk = {
      filePath: "src/example.ts",
      chunkHash: "abc123",
      content: "export const value = 1;",
      startLine: 1,
      endLine: 1,
      language: "typescript",
    };

    try {
      const [first] = await Effect.runPromise(
        embedChunksEffect(cacheDir, model, [chunk]),
      );
      const [second] = await Effect.runPromise(
        embedChunksEffect(cacheDir, model, [chunk]),
      );

      expect(first!.vector).toEqual([0.1, 0.2, 0.3]);
      expect(second!.vector[0]).toBeCloseTo(0.1);
      expect(second!.vector[1]).toBeCloseTo(0.2);
      expect(second!.vector[2]).toBeCloseTo(0.3);
      expect(calls()).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  test("batches uncached chunks into a single embedMany call", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "vgrep-cache-test-"));
    const { model, calls } = countingModel();
    const chunks = [
      { filePath: "a.ts", chunkHash: "h1", content: "a", startLine: 1, endLine: 1 },
      { filePath: "b.ts", chunkHash: "h2", content: "b", startLine: 1, endLine: 1 },
      { filePath: "c.ts", chunkHash: "h3", content: "c", startLine: 1, endLine: 1 },
    ];

    try {
      const entries = await Effect.runPromise(
        embedChunksEffect(cacheDir, model, chunks),
      );
      expect(entries).toHaveLength(3);
      expect(calls()).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
