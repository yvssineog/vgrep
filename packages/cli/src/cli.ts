#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { initCommand } from "./commands/init";
import { searchCommand } from "./commands/search";
import { statusCommand } from "./commands/status";

const VERSION = "0.1.0";

const HELP = `vgrep ${VERSION} — Vector Grep — Semantic search for your codebase, local-first.

Usage:
  vgrep <command> [options]

Commands:
  init              Build (or rebuild) the Merkle tree index for the current project
  search <query>    Semantic search over the local vector index
  status            Display current index status and tree statistics

Run "vgrep <command> --help" for command-specific options.`;

const COMMAND_HELP = {
  init: `Usage: vgrep init [options]

  -p, --path <dir>      Project root directory (defaults to cwd)
  -f, --force           Continue indexing after scaffolding .vgrepignore
      --include <names> Comma-separated file profiles to add to defaultProfiles
      --only <names>    Comma-separated file profiles to use instead of defaultProfiles`,
  search: `Usage: vgrep search [options] <query...>

  -p, --path <dir>      Project root directory (defaults to cwd)
  -k, --top-k <n>       Number of results to return (default: 10)`,
  status: `Usage: vgrep status [options]

  -p, --path <dir>      Project root directory (defaults to cwd)`,
} as const;

type CommandName = keyof typeof COMMAND_HELP;

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP);
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(VERSION);
    return;
  }

  const [command, ...rest] = argv as [string, ...string[]];

  if (rest.includes("--help") || rest.includes("-h")) {
    if (isCommand(command)) {
      console.log(COMMAND_HELP[command]);
      return;
    }
  }

  switch (command) {
    case "init": {
      const { values } = parseArgs({
        args: rest,
        options: {
          path: { type: "string", short: "p" },
          force: { type: "boolean", short: "f" },
          include: { type: "string" },
          only: { type: "string" },
        },
        strict: true,
      });
      await initCommand(values);
      return;
    }
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: {
          path: { type: "string", short: "p" },
        },
        strict: true,
      });
      await statusCommand(values);
      return;
    }
    case "search": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          path: { type: "string", short: "p" },
          "top-k": { type: "string", short: "k" },
        },
        strict: true,
        allowPositionals: true,
      });
      if (positionals.length === 0) {
        console.error("Error: search requires a query.\n");
        console.log(COMMAND_HELP.search);
        process.exit(1);
      }
      await searchCommand(positionals, {
        path: values.path,
        topK: values["top-k"],
      });
      return;
    }
    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
    }
  }
}

function isCommand(name: string): name is CommandName {
  return name in COMMAND_HELP;
}

try {
  await main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
}
