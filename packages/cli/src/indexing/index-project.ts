import {
  paths,
  type ApplyDiffResult,
  type ChangedFile,
  type MerkleNode,
  type ProgressFrame,
  type SidecarClient,
} from "@vgrep/core";
import {
  c,
  Chronometer,
  formatBytes,
  formatDuration,
  row,
} from "../style";
import { writeMerkleJson } from "../config";

export type IndexRunResult = {
  tree: MerkleNode;
  changes: ChangedFile[];
  stats: ApplyDiffResult;
};

/**
 * Walk → diff → chunk → embed → upsert against the Mojo sidecar, then
 * persist the merkle tree to `.vgrep/merkle.json`.
 *
 * The TS side is now just orchestration: every meaningful unit of work
 * (file walk, hashing, parsing, embedding, vector upsert) happens inside
 * the sidecar. Progress frames stream back so we can render the same
 * status bar the previous Effect-streamed pipeline did.
 */
export async function runIndex(opts: {
  sidecar: SidecarClient;
  projectRoot: string;
  previous: MerkleNode | null;
  verbose?: boolean;
  chrono?: Chronometer;
}): Promise<IndexRunResult> {
  const { sidecar, projectRoot, previous, verbose = true } = opts;
  const chrono = opts.chrono ?? new Chronometer();
  const t0 = performance.now();

  chrono.setStage("walking + diffing...");
  const update = await sidecar.updateTree({ previous });
  const treeMs = performance.now() - t0;

  const fileCount = countFiles(update.tree);
  const totalBytes = totalSize(update.tree);

  if (verbose) {
    chrono.log(
      row(
        "tree",
        `${fileCount} files  ${formatBytes(totalBytes)}  ${formatDuration(treeMs)}`,
      ),
    );
    chrono.log(row("hash", c.dim(update.tree.hash.slice(0, 16))));
    logChanges(chrono, previous, update.changes);
  }

  const t1 = performance.now();
  const stats = await sidecar.applyDiff(
    { changes: update.changes },
    (frame: ProgressFrame) => {
      chrono.setStage(`${frame.stage} ${frame.done}/${frame.total}`);
    },
  );
  const indexMs = performance.now() - t1;

  if (verbose) {
    chrono.log(
      row(
        "indexed",
        `${c.bold(stats.indexedChunks)} chunks  ${formatDuration(indexMs)}`,
      ),
    );
    if (stats.deletedFiles > 0) {
      chrono.log(row("delete", c.dim(`${stats.deletedFiles} file(s)`)));
    }
    if (stats.failedFiles > 0) {
      chrono.log(
        row("skipped", c.yellow(`${stats.failedFiles} file(s) failed`)),
      );
    }
  }

  await writeMerkleJson(projectRoot, JSON.stringify(update.tree, null, 2));
  return { tree: update.tree, changes: update.changes, stats };
}

function countFiles(node: MerkleNode): number {
  if (node.type === "file") return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countFiles(c), 0);
}

function totalSize(node: MerkleNode): number {
  if (node.type === "file") return node.size ?? 0;
  return (node.children ?? []).reduce((sum, c) => sum + totalSize(c), 0);
}

function logChanges(
  chrono: Chronometer,
  previous: MerkleNode | null,
  changes: ChangedFile[],
): void {
  if (!previous) {
    chrono.log(row("changes", `first index, ${changes.length} files`));
    return;
  }
  if (changes.length === 0) {
    chrono.log(row("changes", c.green("none")));
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
  chrono.log(row("changes", summary));

  const maxShow = 10;
  chrono.log("");
  for (const change of changes.slice(0, maxShow)) {
    const marker =
      change.type === "added"
        ? c.green("A")
        : change.type === "deleted"
          ? c.red("D")
          : c.yellow("M");
    chrono.log(`${marker} ${c.dim(change.path)}`);
  }
  if (changes.length > maxShow) {
    chrono.log(c.dim(`... ${changes.length - maxShow} more`));
  }
}

// Re-export for the watch loop, which wants direct access to paths.
export { paths };
