import { join } from "node:path";
import {
  MerkleTree,
  createIndexableFileMatcher,
  diffTrees,
  computeSimhash,
  chunkFile,
  LocalEngine,
} from "@vgrep/core";
import type { ChangedFile, MerkleNode, VgrepConfig } from "@vgrep/core";
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

  const indexStartTime = performance.now();
  const engine = new LocalEngine({
    dbPath: join(vgrepDir(projectRoot), FILES.lancedb),
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
  status("chunking...");
  const chunkStart = performance.now();
  let chunkedFiles = 0;
  const failedFiles: { path: string; reason: string }[] = [];
  const chunkGroups = await mapWithConcurrency(
    filesToIndex,
    8,
    async (filePath) => {
      const absolutePath = join(projectRoot, ...filePath.split("/"));
      try {
        const content = await Bun.file(absolutePath).text();
        const chunks = await chunkFile(filePath, content);
        chunkedFiles += 1;
        status(`chunking ${chunkedFiles}/${filesToIndex.length} ${filePath}`);
        return chunks;
      } catch (err) {
        chunkedFiles += 1;
        const reason = err instanceof Error ? err.message : String(err);
        failedFiles.push({ path: filePath, reason });
        return [];
      }
    },
  );
  const chunkMs = performance.now() - chunkStart;

  const chunks = chunkGroups.flat();

  status(`embedding ${chunks.length} chunks...`);
  const embedStart = performance.now();
  const entries = await engine.embedChunks(chunks);
  const embedMs = performance.now() - embedStart;

  status(`writing ${entries.length} vectors...`);
  const upsertStart = performance.now();
  await engine.upsert(entries);
  const upsertMs = performance.now() - upsertStart;
  const indexMs = performance.now() - indexStartTime;
  clearStatus();

  console.log(
    row(
      "indexed",
      `${c.bold(entries.length)} chunks from ${c.bold(filesToIndex.length)} files  ${formatDuration(indexMs)}`,
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

  await writeMerkleJson(projectRoot, tree.serialize());

  return {
    changes,
    deletedFiles,
    filesToIndex,
    failedFiles,
    indexedChunks: entries.length,
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    run,
  );
  await Promise.all(workers);
  return results;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
