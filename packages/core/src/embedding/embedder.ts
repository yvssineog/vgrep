import { embed, embedMany } from "ai";
import type { EmbeddingModelV2 } from "@ai-sdk/provider";
import type { CodeChunk, IndexEntry } from "../types";
import { EmbeddingCache } from "./cache";

export type EmbeddingModel = EmbeddingModelV2<string>;

/**
 * Embeds chunks via the AI SDK, persisting vectors keyed by chunk hash so
 * unchanged code skips the model entirely on subsequent runs.
 */
export class CachedEmbedder {
  private readonly cache: EmbeddingCache;

  constructor(
    cacheDir: string,
    private readonly model: EmbeddingModel,
  ) {
    this.cache = new EmbeddingCache(cacheDir);
  }

  async embedText(text: string): Promise<number[]> {
    const { embedding } = await embed({ model: this.model, value: text });
    return embedding;
  }

  async embedChunks(chunks: CodeChunk[]): Promise<IndexEntry[]> {
    const entries = new Array<IndexEntry | null>(chunks.length).fill(null);
    const missing: { index: number; chunk: CodeChunk }[] = [];

    await Promise.all(
      chunks.map(async (chunk, index) => {
        const cached = await this.cache.get(chunk.chunkHash);
        if (cached) {
          entries[index] = toEntry(chunk, cached);
        } else {
          missing.push({ index, chunk });
        }
      }),
    );

    if (missing.length > 0) {
      const { embeddings } = await embedMany({
        model: this.model,
        values: missing.map(({ chunk }) => chunk.content),
      });

      await Promise.all(
        missing.map(async ({ index, chunk }, i) => {
          const vector = embeddings[i]!;
          await this.cache.set(chunk.chunkHash, vector);
          entries[index] = toEntry(chunk, vector);
        }),
      );
    }

    return entries as IndexEntry[];
  }
}

function toEntry(chunk: CodeChunk, vector: number[]): IndexEntry {
  return {
    filePath: chunk.filePath,
    chunkHash: chunk.chunkHash,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    vector,
  };
}
