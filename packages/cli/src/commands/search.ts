import { join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { LocalEngine } from "@vgrep/core";
import { FILES, isInitialized, vgrepDir } from "../config";

export async function searchCommand(
  query: string | string[],
  options: { path?: string; topK?: string },
): Promise<void> {
  const queryText = Array.isArray(query) ? query.join(" ") : query;
  const projectRoot = resolve(options.path ?? process.cwd());
  const topK = parseTopK(options.topK);

  console.log(
    chalk.bold.cyan("\n🔎 vgrep search"),
    chalk.dim(`— ${projectRoot}\n`),
  );

  if (!isInitialized(projectRoot)) {
    console.log(
      chalk.red("✗ Not initialized."),
      chalk.dim('Run "vgrep init" first.\n'),
    );
    process.exit(1);
  }

  const engine = new LocalEngine({
    dbPath: join(vgrepDir(projectRoot), FILES.lancedb),
    cacheDir: join(vgrepDir(projectRoot), FILES.cache),
  });

  const spinner = ora("Searching local vector index...").start();

  try {
    const results = await engine.search(queryText, topK);
    spinner.stop();

    if (results.length === 0) {
      console.log(chalk.yellow("No results found.\n"));
      return;
    }

    for (const [index, result] of results.entries()) {
      const location = `${result.filePath}:${result.startLine}-${result.endLine}`;
      const score = result.score.toFixed(3);

      console.log(
        chalk.dim(`${index + 1}.`),
        chalk.cyan(location),
        chalk.dim(`score ${score}`),
      );
      console.log(chalk.dim(`   ${preview(result.content)}\n`));
    }
  } catch (error) {
    spinner.fail("Search failed");
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(message), "\n");
    process.exit(1);
  }
}

function parseTopK(value?: string): number {
  if (!value) return 10;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--top-k must be a positive integer");
  }

  return parsed;
}

function preview(content: string): string {
  const compact = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");

  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
