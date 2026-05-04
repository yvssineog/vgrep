import { resolve } from "node:path";
import { MerkleTree, computeSimhash } from "@vgrep/core";
import { c } from "../style";
import { isInitialized, readMerkleJson, readConfig } from "../config";
import { formatBytes } from "./util";

/**
 * `vgrep status` — Display the current index status and tree statistics.
 */
export async function statusCommand(options: {
  path?: string;
}): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(c.boldCyan("\n📊 vgrep status"), c.dim(`— ${projectRoot}\n`));

  if (!isInitialized(projectRoot)) {
    console.log(
      c.red("✗ Not initialized."),
      c.dim('Run "vgrep init" first.\n'),
    );
    process.exit(1);
  }

  const config = await readConfig(projectRoot);
  console.log(
    c.dim("  Mode:"),
    config.mode === "cloud" ? c.boldBlue("☁ Cloud") : c.boldGreen("💻 Local"),
  );

  if (config.mode === "cloud" && config.backendUrl) {
    console.log(c.dim("  Backend:"), c.underline(config.backendUrl));
  }

  const merkleJson = await readMerkleJson(projectRoot);
  if (!merkleJson) {
    console.log(c.red("\n✗ No Merkle tree found.\n"));
    process.exit(1);
  }

  const root = MerkleTree.deserialize(merkleJson);

  let totalFiles = 0;
  let totalDirs = 0;
  let totalSize = 0;
  const fileHashes: string[] = [];

  const walk = (node: typeof root): void => {
    if (node.type === "file") {
      totalFiles++;
      totalSize += node.size ?? 0;
      fileHashes.push(node.hash);
    } else {
      totalDirs++;
      node.children?.forEach(walk);
    }
  };
  walk(root);

  console.log(c.dim("\n  ├─"), `Files: ${c.bold(totalFiles)}`);
  console.log(c.dim("  ├─"), `Directories: ${c.bold(totalDirs)}`);
  console.log(c.dim("  ├─"), `Total size: ${c.bold(formatBytes(totalSize))}`);
  console.log(c.dim("  └─"), `Root hash: ${c.yellow(root.hash.slice(0, 16))}…`);

  const simhash = computeSimhash(fileHashes);
  console.log(c.dim("\n  Simhash:"), c.boldMagenta(simhash), "\n");
}
