import { join } from "node:path";
import {
  MerkleTree,
  createIndexableFileMatcher,
  diffTrees,
  computeSimhash,
  chunkFile,
  LocalEngine,
} from "@vgrep/core";
import type {
  ChangedFile,
  CodeChunk,
  MerkleNode,
  VgrepConfig,
} from "@vgrep/core";
import { c, clearStatus, row, status } from "../style";
import {
  FILES,
  readMerkleJson,
  vgrepDir,
  writeMerkleJson,
} from "../config";
import { formatBytes } from "../commands/util";

export type IndexProjectResult = {
  changes: ChangedFile[];
  deletedFiles: string[];
  filesToIndex: string[];
  failedFiles: { path: string; reason: string }[];
  indexedChunks: number;
  previousTree: MerkleNode | null;
  simhash: string;
  tree: MerkleTree;
};

export type ApplyIndexDiffResult = {
  deletedFiles: string[];
  filesToIndex: string[];
  failedFiles: { path: string; reason: string }[];
  indexedChunks: number;
};

export async function applyIndexDiff(options: {
  projectRoot: string;
  treeJson: string;
  changes: ChangedFile[];
}): Promise<ApplyIndexDiffResult> {
  const { projectRoot, treeJson, changes } = options;

  const indexStartTime = performance.now();
  const engine = new LocalEngine({
    dbPath: join(vgrepDir(projectRoot), FILES.index),
    cacheDir: join(vgrepDir(projectRoot), FILES.cache),
  });

  const deleteStart = performance.now();
  const deletedFiles = changes
    .filter((ch) => ch.type === "deleted")
    .map((ch) => ch.path);
  await engine.deleteByFile(deletedFiles);
  const deleteMs = performance.now() - deleteStart;

  const filesToIndex = changes
    .filter((ch) => ch.type !== "deleted")
    .map((ch) => ch.path);

  console.log();
  const failedFiles: { path: string; reason: string }[] = [];

  const chunkOne = async (filePath: string): Promise<CodeChunk[]> => {
    const absolutePath = join(projectRoot, ...filePath.split("/"));
    try {
      const content = await Bun.file(absolutePath).text();
      return await chunkFile(filePath, content);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failedFiles.push({ path: filePath, reason });
      return [];
    }
  };

  // Pipeline: chunking workers feed a bounded buffer; embed+upsert drains
  // it in batches. While we await embedding, chunking workers keep producing,
  // and the previous batch's upsert overlaps with the next batch's embed.
  let chunkedFiles = 0;
  let producedChunks = 0;
  let embeddedChunks = 0;
  let entriesWritten = 0;
  let chunkMs = 0;
  let embedMs = 0;
  let upsertMs = 0;
  const chunkPhaseStart = performance.now();

  const buffer: CodeChunk[] = [];
  let pendingUpsert: Promise<void> = Promise.resolve();

  const flushBatch = async (batch: CodeChunk[]): Promise<void> => {
    const embedStart = performance.now();
    const entries = await engine.embedChunks(batch);
    embedMs += performance.now() - embedStart;
    embeddedChunks += batch.length;

    // Backpressure: don't pile up upsert work; one batch in flight at a time.
    await pendingUpsert;
    pendingUpsert = (async () => {
      const upsertStart = performance.now();
      await engine.upsert(entries);
      upsertMs += performance.now() - upsertStart;
      entriesWritten += entries.length;
    })();
  };

  status("chunking...");
  for await (const chunks of streamWithConcurrency(
    filesToIndex,
    CHUNK_CONCURRENCY,
    chunkOne,
  )) {
    chunkedFiles += 1;
    if (chunks.length > 0) {
      buffer.push(...chunks);
      producedChunks += chunks.length;
    }
    status(
      `chunk ${chunkedFiles}/${filesToIndex.length}  embed ${embeddedChunks}/${producedChunks}`,
    );

    while (buffer.length >= EMBED_BATCH_SIZE) {
      const batch = buffer.splice(0, EMBED_BATCH_SIZE);
      await flushBatch(batch);
      status(
        `chunk ${chunkedFiles}/${filesToIndex.length}  embed ${embeddedChunks}/${producedChunks}`,
      );
    }
  }
  chunkMs = performance.now() - chunkPhaseStart;

  if (buffer.length > 0) {
    await flushBatch(buffer.splice(0));
  }
  await pendingUpsert;

  const indexMs = performance.now() - indexStartTime;
  clearStatus();

  console.log(
    row(
      "indexed",
      `${c.bold(entriesWritten)} chunks from ${c.bold(filesToIndex.length)} files  ${formatDuration(indexMs)}`,
    ),
  );
  if (deletedFiles.length > 0) {
    console.log(row("delete", c.dim(formatDuration(deleteMs))));
  }
  console.log(row("chunk", c.dim(formatDuration(chunkMs))));
  console.log(row("embed", c.dim(formatDuration(embedMs))));
  console.log(row("upsert", c.dim(formatDuration(upsertMs))));
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

  await writeMerkleJson(projectRoot, treeJson);

  return {
    deletedFiles,
    filesToIndex,
    failedFiles,
    indexedChunks: entriesWritten,
  };
}

export async function indexProject(options: {
  projectRoot: string;
  config: VgrepConfig;
  activeProfiles: string[];
}): Promise<IndexProjectResult> {
  const { projectRoot, config, activeProfiles } = options;

  const previousJson = await readMerkleJson(projectRoot);
  const previousTree: MerkleNode | null = previousJson
    ? MerkleTree.deserialize(previousJson)
    : null;

  status("building merkle tree...");
  const tree = new MerkleTree(
    projectRoot,
    [],
    createIndexableFileMatcher(activeProfiles, config.fileProfiles ?? {}),
  );

  const startTime = performance.now();
  await tree.build();
  const treeMs = performance.now() - startTime;

  const stats = tree.getStats();
  const fileHashes = tree.collectFileHashes();
  const simhash = computeSimhash(fileHashes);

  clearStatus();
  console.log(
    row(
      "tree",
      `${stats.totalFiles} files  ${formatBytes(stats.totalSizeBytes)}  ${formatDuration(treeMs)}`,
    ),
  );
  console.log(row("hash", c.dim(stats.rootHash.slice(0, 16))));
  console.log(row("simhash", c.dim(simhash)));

  const changes = diffTrees(previousTree, tree.getRoot());
  logChanges(previousTree, changes);

  const applied = await applyIndexDiff({
    projectRoot,
    treeJson: tree.serialize(),
    changes,
  });

  return {
    changes,
    deletedFiles: applied.deletedFiles,
    filesToIndex: applied.filesToIndex,
    failedFiles: applied.failedFiles,
    indexedChunks: applied.indexedChunks,
    previousTree,
    simhash,
    tree,
  };
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

/** Worker fan-out for file chunking. Tree-sitter is CPU-bound; 8 ≈ saturates. */
const CHUNK_CONCURRENCY = 8;

/** Chunks per embed call. Aligned to roughly 8 × transformersEmbedding's
 *  internal maxEmbeddingsPerCall (32) so we don't fragment doEmbed batches,
 *  while still bounding peak memory and surfacing progress frequently. */
const EMBED_BATCH_SIZE = 256;

/**
 * Run `worker` over `items` with bounded concurrency, yielding each result
 * as soon as it completes. Order is completion order, not input order.
 */
async function* streamWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): AsyncGenerator<R> {
  const limit = Math.min(concurrency, items.length);
  if (limit === 0) return;

  type Settled = { key: number; result: R };
  const inflight = new Map<number, Promise<Settled>>();
  let cursor = 0;
  let nextKey = 0;

  const launch = (): void => {
    while (inflight.size < limit && cursor < items.length) {
      const i = cursor++;
      const key = nextKey++;
      inflight.set(
        key,
        worker(items[i]!, i).then((result) => ({ key, result })),
      );
    }
  };

  launch();
  while (inflight.size > 0) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.key);
    yield settled.result;
    launch();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
