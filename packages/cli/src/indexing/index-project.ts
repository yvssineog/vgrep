import { join } from "node:path";
import { Effect, Ref, Stream } from "effect";
import {
  MerkleTree,
  buildMerkleTree,
  chunkFile,
  computeSimhash,
  createIndexableFileMatcher,
  diffTrees,
  localEngine,
} from "@vgrep/core";
import type {
  ChangedFile,
  CodeChunk,
  MerkleNode,
  VgrepConfig,
} from "@vgrep/core";
import {
  c,
  clearStatus,
  formatBytes,
  formatDuration,
  row,
  status,
} from "../style";
import { FILES, readMerkleJson, vgrepDir, writeMerkleJson } from "../config";

export type IndexProjectResult = {
  changes: ChangedFile[];
  deletedFiles: string[];
  filesToIndex: string[];
  failedFiles: { path: string; reason: string }[];
  indexedChunks: number;
  previousTree: MerkleNode | null;
  simhash: string;
  tree: MerkleNode;
};

export type ApplyIndexDiffResult = {
  deletedFiles: string[];
  filesToIndex: string[];
  failedFiles: { path: string; reason: string }[];
  indexedChunks: number;
};

/** CPU-bound tree-sitter parsing: 8 ≈ saturates a typical core count. */
const CHUNK_CONCURRENCY = 8;
/** Aligned to ≈ 8 × the embedder's max-per-call so doEmbed isn't fragmented. */
const EMBED_BATCH_SIZE = 256;

interface Counters {
  chunkedFiles: number;
  producedChunks: number;
  embeddedChunks: number;
  entriesWritten: number;
  embedMs: number;
  upsertMs: number;
}

const initialCounters = (): Counters => ({
  chunkedFiles: 0,
  producedChunks: 0,
  embeddedChunks: 0,
  entriesWritten: 0,
  embedMs: 0,
  upsertMs: 0,
});

/**
 * Apply an index diff. Built as a single Effect program: the Engine resource
 * is acquired/released in one scope, and the chunk → embed → upsert pipeline
 * is a single `Stream` with explicit bounded concurrency at each stage.
 */
export const applyIndexDiffEffect = (options: {
  projectRoot: string;
  treeJson: string;
  changes: ChangedFile[];
}): Effect.Effect<ApplyIndexDiffResult, Error> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { projectRoot, treeJson, changes } = options;
      const indexStart = performance.now();

      const engine = yield* localEngine({
        dbPath: join(vgrepDir(projectRoot), FILES.index),
        cacheDir: join(vgrepDir(projectRoot), FILES.cache),
      });

      const deletedFiles = changes
        .filter((ch) => ch.type === "deleted")
        .map((ch) => ch.path);
      const filesToIndex = changes
        .filter((ch) => ch.type !== "deleted")
        .map((ch) => ch.path);

      const deleteStart = performance.now();
      yield* engine.deleteByFile(deletedFiles);
      const deleteMs = performance.now() - deleteStart;

      console.log();

      const failed = yield* Ref.make<{ path: string; reason: string }[]>([]);
      const counters = yield* Ref.make<Counters>(initialCounters());

      const chunkOne = (filePath: string) =>
        Effect.tryPromise({
          try: async () => {
            const absolutePath = join(projectRoot, ...filePath.split("/"));
            const content = await Bun.file(absolutePath).text();
            return await chunkFile(filePath, content);
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }).pipe(
          // Failure of one file must not abort the whole pipeline.
          Effect.catchAll((err) =>
            Ref.update(failed, (xs) => [
              ...xs,
              { path: filePath, reason: err.message },
            ]).pipe(Effect.as<CodeChunk[]>([])),
          ),
        );

      const printProgress = Effect.gen(function* () {
        const c = yield* Ref.get(counters);
        status(
          `chunk ${c.chunkedFiles}/${filesToIndex.length}  embed ${c.embeddedChunks}/${c.producedChunks}`,
        );
      });

      status("chunking...");
      const chunkPhaseStart = performance.now();

      yield* Stream.fromIterable(filesToIndex).pipe(
        Stream.mapEffect(chunkOne, {
          concurrency: CHUNK_CONCURRENCY,
          unordered: true,
        }),
        Stream.tap((chunks) =>
          Ref.update(counters, (s) => ({
            ...s,
            chunkedFiles: s.chunkedFiles + 1,
            producedChunks: s.producedChunks + chunks.length,
          })).pipe(Effect.zipRight(printProgress)),
        ),
        Stream.flattenIterables,
        Stream.grouped(EMBED_BATCH_SIZE),
        // concurrency: 2 lets one batch upsert while the next batch embeds
        // (the prior pipeline's overlap, expressed declaratively).
        Stream.mapEffect(
          (batch) =>
            Effect.gen(function* () {
              const arr = Array.from(batch);
              const t0 = performance.now();
              const entries = yield* engine.embedChunks(arr);
              const embedMs = performance.now() - t0;
              const t1 = performance.now();
              yield* engine.upsert(entries);
              const upsertMs = performance.now() - t1;
              yield* Ref.update(counters, (s) => ({
                ...s,
                embeddedChunks: s.embeddedChunks + arr.length,
                entriesWritten: s.entriesWritten + entries.length,
                embedMs: s.embedMs + embedMs,
                upsertMs: s.upsertMs + upsertMs,
              }));
              yield* printProgress;
            }),
          { concurrency: 2 },
        ),
        Stream.runDrain,
      );

      const finalCounters = yield* Ref.get(counters);
      const failedFiles = yield* Ref.get(failed);
      const chunkMs = performance.now() - chunkPhaseStart;
      const indexMs = performance.now() - indexStart;
      clearStatus();

      console.log(
        row(
          "indexed",
          `${c.bold(finalCounters.entriesWritten)} chunks from ${c.bold(filesToIndex.length)} files  ${formatDuration(indexMs)}`,
        ),
      );
      if (deletedFiles.length > 0) {
        console.log(row("delete", c.dim(formatDuration(deleteMs))));
      }
      console.log(row("chunk", c.dim(formatDuration(chunkMs))));
      console.log(row("embed", c.dim(formatDuration(finalCounters.embedMs))));
      console.log(row("upsert", c.dim(formatDuration(finalCounters.upsertMs))));
      if (failedFiles.length > 0) {
        console.log(
          row(
            "skipped",
            c.yellow(`${failedFiles.length} file(s) failed to chunk`),
          ),
        );
        for (const { path, reason } of failedFiles.slice(0, 3)) {
          console.log(`  ${c.dim(path)} - ${c.dim(reason.slice(0, 80))}`);
        }
        if (failedFiles.length > 3) {
          console.log(`  ${c.dim(`... ${failedFiles.length - 3} more`)}`);
        }
      }

      yield* Effect.tryPromise({
        try: () => writeMerkleJson(projectRoot, treeJson),
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      });

      return {
        deletedFiles,
        filesToIndex,
        failedFiles,
        indexedChunks: finalCounters.entriesWritten,
      } satisfies ApplyIndexDiffResult;
    }),
  );

/** Promise-flavoured wrapper for legacy call sites. */
export const applyIndexDiff = (options: {
  projectRoot: string;
  treeJson: string;
  changes: ChangedFile[];
}): Promise<ApplyIndexDiffResult> => Effect.runPromise(applyIndexDiffEffect(options));

export const indexProjectEffect = (options: {
  projectRoot: string;
  config: VgrepConfig;
  activeProfiles: string[];
}): Effect.Effect<IndexProjectResult, Error> =>
  Effect.gen(function* () {
    const { projectRoot, config, activeProfiles } = options;

    const previousJson = yield* Effect.tryPromise({
      try: () => readMerkleJson(projectRoot),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });
    const previousTree: MerkleNode | null = previousJson
      ? MerkleTree.deserialize(previousJson)
      : null;

    status("building merkle tree...");
    const matcher = createIndexableFileMatcher(
      activeProfiles,
      config.fileProfiles ?? {},
    );
    const start = performance.now();
    const tree = yield* buildMerkleTree(projectRoot, matcher);
    const treeMs = performance.now() - start;

    const fileHashes = collectHashes(tree);
    const sim = computeSimhash(fileHashes);
    const sizeBytes = collectTotalSize(tree);

    clearStatus();
    console.log(
      row(
        "tree",
        `${fileHashes.length} files  ${formatBytes(sizeBytes)}  ${formatDuration(treeMs)}`,
      ),
    );
    console.log(row("hash", c.dim(tree.hash.slice(0, 16))));
    console.log(row("simhash", c.dim(sim)));

    const changes = diffTrees(previousTree, tree);
    logChanges(previousTree, changes);

    const applied = yield* applyIndexDiffEffect({
      projectRoot,
      treeJson: JSON.stringify(tree, null, 2),
      changes,
    });

    return {
      changes,
      deletedFiles: applied.deletedFiles,
      filesToIndex: applied.filesToIndex,
      failedFiles: applied.failedFiles,
      indexedChunks: applied.indexedChunks,
      previousTree,
      simhash: sim,
      tree,
    } satisfies IndexProjectResult;
  });

export const indexProject = (options: {
  projectRoot: string;
  config: VgrepConfig;
  activeProfiles: string[];
}): Promise<IndexProjectResult> => Effect.runPromise(indexProjectEffect(options));

function collectHashes(node: MerkleNode): string[] {
  const out: string[] = [];
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") out.push(n.hash);
    else n.children?.forEach(walk);
  };
  walk(node);
  return out;
}

function collectTotalSize(node: MerkleNode): number {
  let s = 0;
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") s += n.size ?? 0;
    else n.children?.forEach(walk);
  };
  walk(node);
  return s;
}

function logChanges(
  previousTree: MerkleNode | null,
  changes: ChangedFile[],
): void {
  if (!previousTree) {
    console.log(row("changes", `first index, ${changes.length} files`));
    return;
  }
  if (changes.length === 0) {
    console.log(row("changes", c.green("none")));
    return;
  }

  const counts = changes.reduce(
    (acc, ch) => {
      acc[ch.type]++;
      return acc;
    },
    { added: 0, deleted: 0, modified: 0 },
  );
  const summary = [
    counts.modified && c.yellow(`${counts.modified} modified`),
    counts.added && c.green(`${counts.added} added`),
    counts.deleted && c.red(`${counts.deleted} deleted`),
  ]
    .filter(Boolean)
    .join(c.dim(", "));
  console.log(row("changes", summary));

  const maxShow = 10;
  console.log();
  for (const change of changes.slice(0, maxShow)) {
    const marker =
      change.type === "added"
        ? c.green("A")
        : change.type === "deleted"
          ? c.red("D")
          : c.yellow("M");
    console.log(`${marker} ${c.dim(change.path)}`);
  }
  if (changes.length > maxShow) {
    console.log(c.dim(`... ${changes.length - maxShow} more`));
  }
}

