import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const FLOAT_BYTES = 4;

export class EmbeddingCache {
  constructor(private readonly cacheDir: string) {}

  async get(chunkHash: string): Promise<number[] | null> {
    const file = Bun.file(this.cachePath(chunkHash));
    if (!(await file.exists())) return null;

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength % FLOAT_BYTES !== 0) return null;

    return Array.from(new Float32Array(bytes));
  }

  async set(chunkHash: string, vector: number[]): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });

    const floats = new Float32Array(vector);
    await Bun.write(this.cachePath(chunkHash), floats);
  }

  private cachePath(chunkHash: string): string {
    return join(this.cacheDir, `${chunkHash}.bin`);
  }
}
