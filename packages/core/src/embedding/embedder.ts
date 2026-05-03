import type { CodeChunk, IndexEntry } from "../types";
import { EmbeddingCache } from "./cache";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class TransformersEmbedder implements Embedder {
  private extractorPromise: Promise<any> | null = null;

  async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    return Array.from(output.data as Float32Array);
  }

  private async getExtractor(): Promise<any> {
    if (!this.extractorPromise) {
      this.extractorPromise = import("@huggingface/transformers").then(
        ({ pipeline }) =>
          pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2"),
      );
    }

    return this.extractorPromise;
  }
}

export class CachedEmbedder {
  private readonly cache: EmbeddingCache;

  constructor(
    cacheDir: string,
    private readonly embedder: Embedder = new TransformersEmbedder(),
  ) {
    this.cache = new EmbeddingCache(cacheDir);
  }

  async embedText(text: string): Promise<number[]> {
    return this.embedder.embed(text);
  }

  async embedChunk(chunk: CodeChunk): Promise<IndexEntry> {
    let vector = await this.cache.get(chunk.chunkHash);

    if (!vector) {
      vector = await this.embedder.embed(chunk.content);
      await this.cache.set(chunk.chunkHash, vector);
    }

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
}
