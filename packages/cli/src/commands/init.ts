import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import pLimit from "p-limit";
import {
  MerkleTree,
  createIndexableFileMatcher,
  diffTrees,
  computeSimhash,
  chunkFile,
  LocalEngine,
} from "@vgrep/core";
import type { MerkleNode, VgrepConfig } from "@vgrep/core";
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

  console.log(
    chalk.bold.cyan("\n⚡ vgrep init"),
    chalk.dim(`— ${projectRoot}\n`),
  );

  // 1. Ensure .vgrep/config.json and .vgrepignore are scaffolded
  const config = await ensureConfig(projectRoot);
  const activeProfiles = resolveProfiles(config, options);
  console.log(chalk.dim("  Profiles:"), chalk.bold(activeProfiles.join(", ")));

  const createdIgnore = await ensureVgrepIgnore(projectRoot);
  if (createdIgnore) {
    console.log(
      chalk.dim("  -"),
      chalk.green("Scaffolded default .vgrepignore"),
    );
    if (!options.force) {
      console.log(
        chalk.yellow(
          "\n.vgrepignore and .vgrep/config.json are ready. Review them, add custom profiles if needed, then run:",
        ),
      );
      console.log(chalk.cyan("  vgrep init\n"));
      console.log(chalk.dim("  Tip: use vgrep init --force to scaffold and index in one command.\n"));
      return;
    }
  }

  // 2. Load previous Merkle tree (if any)
  const previousJson = await readMerkleJson(projectRoot);
  const previousTree: MerkleNode | null = previousJson
    ? MerkleTree.deserialize(previousJson)
    : null;

  // 3. Build the new Merkle tree
  const spinner = ora("Building Merkle tree...").start();
  const tree = new MerkleTree(
    projectRoot,
    [],
    createIndexableFileMatcher(activeProfiles, config.fileProfiles ?? {}),
  );

  const startTime = performance.now();
  await tree.build();
  const elapsed = (performance.now() - startTime).toFixed(0);

  spinner.succeed(
    chalk.green(`Merkle tree built in ${chalk.bold(elapsed + "ms")}`),
  );

  // 4. Get stats
  const stats = tree.getStats();
  console.log(chalk.dim("  ├─"), `Files: ${chalk.bold(stats.totalFiles)}`);
  console.log(
    chalk.dim("  ├─"),
    `Directories: ${chalk.bold(stats.totalDirectories)}`,
  );
  console.log(
    chalk.dim("  ├─"),
    `Total size: ${chalk.bold(formatBytes(stats.totalSizeBytes))}`,
  );
  console.log(
    chalk.dim("  └─"),
    `Root hash: ${chalk.yellow(stats.rootHash.slice(0, 16))}…`,
  );

  // 5. Compute simhash
  const fileHashes = tree.collectFileHashes();
  const simhash = computeSimhash(fileHashes);
  console.log(
    chalk.dim("\n  Simhash:"),
    chalk.magenta.bold(simhash),
    "\n",
  );

  // 6. Diff against previous tree
  const changes = diffTrees(previousTree, tree.getRoot());

  if (previousTree) {
    if (changes.length === 0) {
      console.log(chalk.green("✓ No files changed since last index.\n"));
    } else {
      console.log(
        chalk.yellow(`⚠ ${changes.length} file(s) changed since last index:\n`),
      );
      const maxShow = 20;
      for (const change of changes.slice(0, maxShow)) {
        const icon =
          change.type === "added"
            ? chalk.green("+")
            : change.type === "deleted"
              ? chalk.red("-")
              : chalk.yellow("~");
        console.log(`  ${icon} ${change.path}`);
      }
      if (changes.length > maxShow) {
        console.log(
          chalk.dim(`  ... and ${changes.length - maxShow} more\n`),
        );
      }
      console.log();
    }
  } else {
    console.log(
      chalk.green(`✓ First index: ${changes.length} file(s) indexed.\n`),
    );
  }

  // 7. Index changed files into LanceDB
  const indexSpinner = ora("Indexing changed chunks...").start();
  const indexStartTime = performance.now();
  const engine = new LocalEngine({
    dbPath: join(vgrepDir(projectRoot), FILES.lancedb),
    cacheDir: join(vgrepDir(projectRoot), FILES.cache),
  });

  const deleteStartTime = performance.now();
  const deletedFiles = changes
    .filter((change) => change.type === "deleted")
    .map((change) => change.path);
  await engine.deleteByFile(deletedFiles);
  const deleteElapsed = performance.now() - deleteStartTime;

  const filesToIndex = changes
    .filter((change) => change.type !== "deleted")
    .map((change) => change.path);

  const limit = pLimit(4);
  const chunkStartTime = performance.now();
  let chunkStartedFiles = 0;
  let chunkedFiles = 0;
  const chunkGroups = await Promise.all(
    filesToIndex.map((filePath) =>
      limit(async () => {
        chunkStartedFiles += 1;
        indexSpinner.text = formatIndexProgress(
          "Reading + chunking",
          chunkStartedFiles,
          filesToIndex.length,
          filePath,
        );
        const absolutePath = join(projectRoot, ...filePath.split("/"));
        const file = Bun.file(absolutePath);
        const content = await file.text();
        const chunks = chunkFile(filePath, content);
        chunkedFiles += 1;
        indexSpinner.text = formatIndexProgress(
          "Chunked",
          chunkedFiles,
          filesToIndex.length,
          filePath,
        );
        return chunks;
      }),
    ),
  );
  const chunkElapsed = performance.now() - chunkStartTime;

  const chunks = chunkGroups.flat();
  const embedStartTime = performance.now();
  let embedStartedChunks = 0;
  let embeddedChunks = 0;
  const entries = await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        embedStartedChunks += 1;
        indexSpinner.text = formatIndexProgress(
          "Embedding/cache",
          embedStartedChunks,
          chunks.length,
          chunk.filePath,
        );
        const entry = await engine.embedChunk(chunk);
        embeddedChunks += 1;
        indexSpinner.text = formatIndexProgress(
          "Embedded/cached",
          embeddedChunks,
          chunks.length,
          chunk.filePath,
        );
        return entry;
      }),
    ),
  );
  const embedElapsed = performance.now() - embedStartTime;

  const upsertStartTime = performance.now();
  indexSpinner.text = `Writing ${entries.length} chunk vector(s) to LanceDB...`;
  await engine.upsert(entries);
  const upsertElapsed = performance.now() - upsertStartTime;
  const indexElapsed = performance.now() - indexStartTime;

  indexSpinner.succeed(
    chalk.green(
      `Indexed ${chalk.bold(entries.length)} chunk(s) from ${chalk.bold(
        filesToIndex.length,
      )} changed file(s) in ${chalk.bold(formatDuration(indexElapsed))}`,
    ),
  );
  console.log(chalk.dim("  -"), `Delete stale vectors: ${chalk.bold(formatDuration(deleteElapsed))}`);
  console.log(chalk.dim("  -"), `Read + chunk files: ${chalk.bold(formatDuration(chunkElapsed))}`);
  console.log(chalk.dim("  -"), `Embed/cache chunks: ${chalk.bold(formatDuration(embedElapsed))}`);
  console.log(chalk.dim("  -"), `LanceDB upsert: ${chalk.bold(formatDuration(upsertElapsed))}`);

  // 8. Persist the new tree only after indexing succeeds
  await writeMerkleJson(projectRoot, tree.serialize());

  console.log(
    chalk.dim("  Index saved to"),
    chalk.underline(`.vgrep/merkle.json`),
    "\n",
  );
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

function formatIndexProgress(
  phase: string,
  current: number,
  total: number,
  filePath: string,
): string {
  const safeTotal = Math.max(total, 1);
  return `${phase} [${Math.min(current, safeTotal)}/${safeTotal}] ${filePath}`;
}
