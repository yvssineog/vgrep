import { resolve } from "node:path";
import type { MerkleNode } from "@vgrep/core";
import { c, formatBytes, header, row } from "../style";
import { isInitialized, readMerkleJson, readConfig } from "../config";

/**
 * `vgrep status` — Display the current index summary.
 *
 * Reads `.vgrep/merkle.json` directly; doesn't need the sidecar — this
 * command is fast metadata-only and runs even when the daemon is down.
 */
export async function statusCommand(options: {
  path?: string;
}): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(header("status", projectRoot));

  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('— run "vgrep init"')}`);
    process.exit(1);
  }

  const config = await readConfig(projectRoot);
  console.log(
    row("mode", config.mode === "cloud" ? c.blue("cloud") : c.green("local")),
  );

  if (config.mode === "cloud" && config.backendUrl) {
    console.log(row("backend", c.underline(config.backendUrl)));
  }

  const merkleJson = await readMerkleJson(projectRoot);
  if (!merkleJson) {
    console.log(c.red("no merkle tree found"));
    process.exit(1);
  }

  const root = JSON.parse(merkleJson) as MerkleNode;

  let totalFiles = 0;
  let totalDirs = 0;
  let totalSize = 0;

  const walk = (node: MerkleNode): void => {
    if (node.type === "file") {
      totalFiles++;
      totalSize += node.size ?? 0;
    } else {
      totalDirs++;
      node.children?.forEach(walk);
    }
  };
  walk(root);

  console.log(row("files", totalFiles));
  console.log(row("dirs", totalDirs));
  console.log(row("size", formatBytes(totalSize)));
  console.log(row("hash", c.dim(root.hash.slice(0, 16))));
}
