import { resolve } from "node:path";
import chalk from "chalk";
import { MerkleTree, computeSimhash } from "@vgrep/core";
import { isInitialized, readMerkleJson, readConfig } from "../config";
import { formatBytes } from "./util";

/**
 * `vgrep status` — Display the current index status and tree statistics.
 */
export async function statusCommand(options: {
  path?: string;
}): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(
    chalk.bold.cyan("\n📊 vgrep status"),
    chalk.dim(`— ${projectRoot}\n`),
  );

  // Check if initialized
  if (!isInitialized(projectRoot)) {
    console.log(
      chalk.red("✗ Not initialized."),
      chalk.dim('Run "vgrep init" first.\n'),
    );
    process.exit(1);
  }

  // Load config
  const config = await readConfig(projectRoot);
  console.log(
    chalk.dim("  Mode:"),
    config.mode === "cloud"
      ? chalk.blue.bold("☁ Cloud")
      : chalk.green.bold("💻 Local"),
  );

  if (config.mode === "cloud" && config.backendUrl) {
    console.log(chalk.dim("  Backend:"), chalk.underline(config.backendUrl));
  }

  // Load and analyze Merkle tree
  const merkleJson = await readMerkleJson(projectRoot);
  if (!merkleJson) {
    console.log(chalk.red("\n✗ No Merkle tree found.\n"));
    process.exit(1);
  }

  const root = MerkleTree.deserialize(merkleJson);

  // Compute stats by walking the deserialized tree
  let totalFiles = 0;
  let totalDirs = 0;
  let totalSize = 0;

  const walk = (node: typeof root): void => {
    if (node.type === "file") {
      totalFiles++;
      totalSize += node.size ?? 0;
    } else {
      totalDirs++;
      node.children?.forEach(walk);
    }
  };
  walk(root);

  console.log(chalk.dim("\n  ├─"), `Files: ${chalk.bold(totalFiles)}`);
  console.log(chalk.dim("  ├─"), `Directories: ${chalk.bold(totalDirs)}`);
  console.log(
    chalk.dim("  ├─"),
    `Total size: ${chalk.bold(formatBytes(totalSize))}`,
  );
  console.log(
    chalk.dim("  └─"),
    `Root hash: ${chalk.yellow(root.hash.slice(0, 16))}…`,
  );

  // Compute simhash from file hashes
  const fileHashes: string[] = [];
  const collectHashes = (node: typeof root): void => {
    if (node.type === "file") {
      fileHashes.push(node.hash);
    } else {
      node.children?.forEach(collectHashes);
    }
  };
  collectHashes(root);

  const simhash = computeSimhash(fileHashes);
  console.log(
    chalk.dim("\n  Simhash:"),
    chalk.magenta.bold(simhash),
    "\n",
  );
}


