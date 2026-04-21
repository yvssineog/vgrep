import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { MerkleTree, diffTrees, computeSimhash } from "@vgrep/core";
import type { MerkleNode } from "@vgrep/core";
import { formatBytes } from "./util";

import {
  ensureVgrepDir,
  ensureVgrepIgnore,
  readMerkleJson,
  writeMerkleJson,
  writeConfig,
} from "../config";

/**
 * `vgrep init` — Build (or rebuild) the Merkle tree for the current project.
 *
 * - First run: builds entire tree, persists to .vgrep/merkle.json
 * - Subsequent runs: rebuilds tree, diffs against previous, reports changes
 */
export async function initCommand(options: { path?: string }): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(
    chalk.bold.cyan("\n⚡ vgrep init"),
    chalk.dim(`— ${projectRoot}\n`),
  );

  // 1. Ensure .vgrep/ directory exists and .vgrepignore is scaffolded
  await ensureVgrepDir(projectRoot);
  await writeConfig(projectRoot, { mode: "local" });

  const createdIgnore = await ensureVgrepIgnore(projectRoot);
  if (createdIgnore) {
    console.log(chalk.dim("  ├─"), chalk.green("Scaffolded default .vgrepignore"));
  }

  // 2. Load previous Merkle tree (if any)
  const previousJson = await readMerkleJson(projectRoot);
  const previousTree: MerkleNode | null = previousJson
    ? MerkleTree.deserialize(previousJson)
    : null;

  // 3. Build the new Merkle tree
  const spinner = ora("Building Merkle tree...").start();
  const tree = new MerkleTree(projectRoot);

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
              ? chalk.red("−")
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

  // 7. Persist the new tree
  await writeMerkleJson(projectRoot, tree.serialize());

  console.log(
    chalk.dim("  Index saved to"),
    chalk.underline(`.vgrep/merkle.json`),
    "\n",
  );
}

