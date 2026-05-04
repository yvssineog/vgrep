import { join, resolve } from "node:path";
import {
  MerkleTree,
  createIndexableFileMatcher,
  diffTrees,
  computeSimhash,
  chunkFile,
  LocalEngine,
} from "@vgrep/core";
import type { MerkleNode, VgrepConfig } from "@vgrep/core";
import { c, clearStatus, header, row, status } from "../style";
import { formatBytes } from "./util";

import {
  FILES,
  ensureConfig,
  ensureVgrepIgnore,
  readMerkleJson,
  vgrepDir,
  writeMerkleJson,
} from "../config";

/**
 * `vgrep init` — Build (or rebuild) the Merkle tree for the current project.
 *
 * - First run: builds entire tree, persists to .vgrep/merkle.json
 * - Subsequent runs: rebuilds tree, diffs against previous, reports changes
 */
export async function initCommand(options: {
  path?: string;
  force?: boolean;
  include?: string;
  only?: string;
}): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(header("init", projectRoot));

  const config = await ensureConfig(projectRoot);
  const activeProfiles = resolveProfiles(config, options);
  console.log(row("profiles", activeProfiles.join(", ")));

  const createdIgnore = await ensureVgrepIgnore(projectRoot);
  if (createdIgnore) {
    console.log(row("scaffold", c.green(".vgrepignore created")));
    if (!options.force) {
      console.log();
      console.log(
        `${c.dim("review .vgrepignore + .vgrep/config.json, then run")} ${c.bold("vgrep init")}`,
      );
      console.log(
        `${c.dim("or skip with")} ${c.bold("vgrep init --force")}`,
      );
      return;
    }
  }

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

  if (!previousTree) {
    console.log(row("changes", `first index, ${changes.length} files`));
  } else if (changes.length === 0) {
    console.log(row("changes", c.green("none")));
  } else {
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
      console.log(c.dim(`… ${changes.length - maxShow} more`));
    }
  }

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
  const chunkGroups = await mapWithConcurrency(
    filesToIndex,
    8,
    async (filePath) => {
      const absolutePath = join(projectRoot, ...filePath.split("/"));
      const content = await Bun.file(absolutePath).text();
      const chunks = await chunkFile(filePath, content);
      chunkedFiles += 1;
      status(`chunking ${chunkedFiles}/${filesToIndex.length} ${filePath}`);
      return chunks;
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

  await writeMerkleJson(projectRoot, tree.serialize());
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

function resolveProfiles(
  config: VgrepConfig,
  options: { include?: string; only?: string },
): string[] {
  if (options.include && options.only) {
    throw new Error("Use either --include or --only, not both.");
  }

  const availableProfiles = config.fileProfiles ?? {};
  const defaultProfiles = config.defaultProfiles?.length
    ? config.defaultProfiles
    : ["code"];

  const selected = options.only
    ? parseProfileList(options.only)
    : [...defaultProfiles, ...parseProfileList(options.include)];

  const unique = [...new Set(selected)];
  const unknown = unique.filter((profile) => !availableProfiles[profile]);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown file profile(s): ${unknown.join(", ")}. Add them to .vgrep/config.json or choose one of: ${Object.keys(availableProfiles).join(", ")}`,
    );
  }

  return unique;
}

function parseProfileList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((profile) => profile.trim())
    .filter(Boolean);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
