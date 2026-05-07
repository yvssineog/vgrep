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
  clearStatus,
  formatBytes,
  formatDuration,
  row,
  status,
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
}): Promise<IndexRunResult> {
  const { sidecar, projectRoot, previous, verbose = true } = opts;
  const t0 = performance.now();

  status("walking + diffing...");
  const update = await sidecar.updateTree({ previous });
  const treeMs = performance.now() - t0;

  const fileCount = countFiles(update.tree);
  const totalBytes = totalSize(update.tree);

  clearStatus();
  if (verbose) {
    console.log(
      row(
        "tree",
        `${fileCount} files  ${formatBytes(totalBytes)}  ${formatDuration(treeMs)}`,
      ),
    );
    console.log(row("hash", c.dim(update.tree.hash.slice(0, 16))));
    logChanges(previous, update.changes);
  }

  const t1 = performance.now();
  const stats = await sidecar.applyDiff(
    { changes: update.changes },
    (frame: ProgressFrame) => {
      status(`${frame.stage} ${frame.done}/${frame.total}`);
    },
  );
  const indexMs = performance.now() - t1;
  clearStatus();

  if (verbose) {
    console.log(
      row(
        "indexed",
        `${c.bold(stats.indexedChunks)} chunks  ${formatDuration(indexMs)}`,
      ),
    );
    if (stats.deletedFiles > 0) {
      console.log(row("delete", c.dim(`${stats.deletedFiles} file(s)`)));
    }
    if (stats.failedFiles > 0) {
      console.log(
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
  previous: MerkleNode | null,
  changes: ChangedFile[],
): void {
  if (!previous) {
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

// Re-export for the watch loop, which wants direct access to paths.
export { paths };
