import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CachedEmbedder, type Embedder } from "./embedder";

class CountingEmbedder implements Embedder {
  calls = 0;

  async embed(): Promise<number[]> {
    this.calls++;
    return [0.1, 0.2, 0.3];
  }
}

describe("CachedEmbedder", () => {
  test("cache miss writes a reusable vector and later hits avoid the model", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "vgrep-cache-test-"));
    const embedder = new CountingEmbedder();
    const cached = new CachedEmbedder(cacheDir, embedder);
    const chunk = {
      filePath: "src/example.ts",
      chunkHash: "abc123",
      content: "export const value = 1;",
      startLine: 1,
      endLine: 1,
      language: "typescript",
    };

    try {
      const first = await cached.embedChunk(chunk);
      const second = await cached.embedChunk(chunk);

      expect(first.vector).toEqual([0.1, 0.2, 0.3]);
      expect(second.vector[0]).toBeCloseTo(0.1);
      expect(second.vector[1]).toBeCloseTo(0.2);
      expect(second.vector[2]).toBeCloseTo(0.3);
      expect(embedder.calls).toBe(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
