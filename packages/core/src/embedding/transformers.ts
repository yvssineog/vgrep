import type { EmbeddingModelV2 } from "@ai-sdk/provider";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_MAX_PER_CALL = 32;

export interface TransformersEmbeddingOptions {
  /** Hub model id served by @huggingface/transformers (Xenova-converted ONNX). */
  modelId?: string;
  /** Cap on how many strings the AI SDK passes to a single doEmbed call. */
  maxEmbeddingsPerCall?: number;
}

/**
 * Local embedding provider for the AI SDK, backed by @huggingface/transformers.
 *
 * Implements EmbeddingModelV2<string> so it composes with `embed` / `embedMany`
 * from `ai`. Inference runs in-process — no network, no API key.
 *
 * To swap to a hosted provider (OpenAI, Cohere, Voyage, …), pass that
 * provider's EmbeddingModel into the consumer instead of this one — the rest
 * of the pipeline is untouched.
 */
export function transformersEmbedding(
  options: TransformersEmbeddingOptions = {},
): EmbeddingModelV2<string> {
  const modelId = options.modelId ?? DEFAULT_MODEL;
  const maxEmbeddingsPerCall =
    options.maxEmbeddingsPerCall ?? DEFAULT_MAX_PER_CALL;

  let extractorPromise: Promise<unknown> | null = null;
  const getExtractor = async (): Promise<
    (input: string | string[], opts: unknown) => Promise<{
      data: Float32Array;
      dims: number[];
    }>
  > => {
    if (!extractorPromise) {
      extractorPromise = import("@huggingface/transformers").then(
        ({ pipeline }) =>
          pipeline("feature-extraction", modelId, { dtype: "fp32" }),
      );
    }
    return extractorPromise as Promise<
      (input: string | string[], opts: unknown) => Promise<{
        data: Float32Array;
        dims: number[];
      }>
    >;
  };

  return {
    specificationVersion: "v2",
    provider: "transformers",
    modelId,
    maxEmbeddingsPerCall,
    // In-process inference — concurrent calls would just contend for the same model.
    supportsParallelCalls: false,

    async doEmbed({ values }) {
      const extractor = await getExtractor();
      const output = await extractor(values, {
        pooling: "mean",
        normalize: true,
      });

      const dim = output.dims[output.dims.length - 1] ?? 0;
      const embeddings: number[][] = [];
      for (let i = 0; i < values.length; i++) {
        embeddings.push(
          Array.from(output.data.subarray(i * dim, (i + 1) * dim)),
        );
      }
      return { embeddings };
    },
  };
}
