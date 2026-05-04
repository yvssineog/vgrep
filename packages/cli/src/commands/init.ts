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
import ora from "ora";
import { c } from "../style";
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

  console.log(c.boldCyan("\n⚡ vgrep init"), c.dim(`— ${projectRoot}\n`));

  // 1. Ensure .vgrep/config.json and .vgrepignore are scaffolded
  const config = await ensureConfig(projectRoot);
  const activeProfiles = resolveProfiles(config, options);
  console.log(c.dim("  Profiles:"), c.bold(activeProfiles.join(", ")));

  const createdIgnore = await ensureVgrepIgnore(projectRoot);
  if (createdIgnore) {
    console.log(c.dim("  -"), c.green("Scaffolded default .vgrepignore"));
    if (!options.force) {
      console.log(
        c.yellow(
          "\n.vgrepignore and .vgrep/config.json are ready. Review them, add custom profiles if needed, then run:",
        ),
      );
      console.log(c.cyan("  vgrep init\n"));
      console.log(
        c.dim(
          "  Tip: use vgrep init --force to scaffold and index in one command.\n",
        ),
      );
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

  spinner.succeed(c.green(`Merkle tree built in ${c.bold(elapsed + "ms")}`));

  // 4. Get stats
  const stats = tree.getStats();
  console.log(c.dim("  ├─"), `Files: ${c.bold(stats.totalFiles)}`);
  console.log(c.dim("  ├─"), `Directories: ${c.bold(stats.totalDirectories)}`);
  console.log(
    c.dim("  ├─"),
    `Total size: ${c.bold(formatBytes(stats.totalSizeBytes))}`,
  );
  console.log(
    c.dim("  └─"),
    `Root hash: ${c.yellow(stats.rootHash.slice(0, 16))}…`,
  );

  // 5. Compute simhash
  const fileHashes = tree.collectFileHashes();
  const simhash = computeSimhash(fileHashes);
  console.log(c.dim("\n  Simhash:"), c.boldMagenta(simhash), "\n");

  // 6. Diff against previous tree
  const changes = diffTrees(previousTree, tree.getRoot());

  if (previousTree) {
    if (changes.length === 0) {
      console.log(c.green("✓ No files changed since last index.\n"));
    } else {
      console.log(
        c.yellow(`⚠ ${changes.length} file(s) changed since last index:\n`),
      );
      const maxShow = 20;
      for (const change of changes.slice(0, maxShow)) {
        const icon =
          change.type === "added"
            ? c.green("+")
            : change.type === "deleted"
              ? c.red("-")
              : c.yellow("~");
        console.log(`  ${icon} ${change.path}`);
      }
      if (changes.length > maxShow) {
        console.log(c.dim(`  ... and ${changes.length - maxShow} more\n`));
      }
      console.log();
    }
  } else {
    console.log(c.green(`✓ First index: ${changes.length} file(s) indexed.\n`));
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

  const chunkStartTime = performance.now();
  let chunkedFiles = 0;
  const chunkGroups = await mapWithConcurrency(
    filesToIndex,
    8,
    async (filePath) => {
      const absolutePath = join(projectRoot, ...filePath.split("/"));
      const content = await Bun.file(absolutePath).text();
      const chunks = await chunkFile(filePath, content);
      chunkedFiles += 1;
      indexSpinner.text = formatIndexProgress(
        "Chunked",
        chunkedFiles,
        filesToIndex.length,
        filePath,
      );
      return chunks;
    },
  );
  const chunkElapsed = performance.now() - chunkStartTime;

  const chunks = chunkGroups.flat();
  const embedStartTime = performance.now();
  indexSpinner.text = `Embedding ${chunks.length} chunk(s) locally...`;
  const entries = await engine.embedChunks(chunks);
  const embedElapsed = performance.now() - embedStartTime;

  const upsertStartTime = performance.now();
  indexSpinner.text = `Writing ${entries.length} chunk vector(s) to LanceDB...`;
  await engine.upsert(entries);
  const upsertElapsed = performance.now() - upsertStartTime;
  const indexElapsed = performance.now() - indexStartTime;

  indexSpinner.succeed(
    c.green(
      `Indexed ${c.bold(entries.length)} chunk(s) from ${c.bold(
        filesToIndex.length,
      )} changed file(s) in ${c.bold(formatDuration(indexElapsed))}`,
    ),
  );
  console.log(
    c.dim("  -"),
    `Delete stale vectors: ${c.bold(formatDuration(deleteElapsed))}`,
  );
  console.log(
    c.dim("  -"),
    `Read + chunk files: ${c.bold(formatDuration(chunkElapsed))}`,
  );
  console.log(
    c.dim("  -"),
    `Embed/cache chunks: ${c.bold(formatDuration(embedElapsed))}`,
  );
  console.log(
    c.dim("  -"),
    `LanceDB upsert: ${c.bold(formatDuration(upsertElapsed))}`,
  );

  // 8. Persist the new tree only after indexing succeeds
  await writeMerkleJson(projectRoot, tree.serialize());

  console.log(
    c.dim("  Index saved to"),
    c.underline(`.vgrep/merkle.json`),
    "\n",
  );
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

function formatIndexProgress(
  phase: string,
  current: number,
  total: number,
  filePath: string,
): string {
  const safeTotal = Math.max(total, 1);
  return `${phase} [${Math.min(current, safeTotal)}/${safeTotal}] ${filePath}`;
}
