#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { initCommand } from "./commands/init";
import { searchCommand } from "./commands/search";
import { statusCommand } from "./commands/status";
import { watchCommand } from "./commands/watch";

const VERSION = "0.1.0";

const HELP = `vgrep ${VERSION} semantic search for your codebase, local-first

usage
vgrep <command> [options]

commands
init            build or update the local index
search <query>  semantic search over the index
status          show index stats
watch           keep the index updated while files change

run "vgrep <command> --help" for command options`;

const COMMAND_HELP = {
  init: `usage: vgrep init [options]

-p, --path <dir>       project root (defaults to cwd)
-f, --force            continue indexing after scaffolding .vgrepignore
    --include <names>  comma-separated profiles to add to defaultProfiles
    --only <names>     comma-separated profiles to use instead of defaultProfiles
    --no-skill         skip installing the vgrep agent skill (default: install)`,
  search: `usage: vgrep search [options] <query...>

-p, --path <dir>  project root (defaults to cwd)
-k, --top-k <n>   number of results (default: 3)`,
  status: `usage: vgrep status [options]

-p, --path <dir>  project root (defaults to cwd)`,
  watch: `usage: vgrep watch [options]

-p, --path <dir>  project root (defaults to cwd)
    --start       start the watchdog in the background
    --logs        show the last watchdog logs
    --stop        stop the background watchdog`,
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
          "no-skill": { type: "boolean" },
        },
        strict: true,
      });
      await initCommand({
        path: values.path,
        force: values.force,
        include: values.include,
        only: values.only,
        installSkill: !values["no-skill"],
      });
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
    case "watch": {
      const { values } = parseArgs({
        args: rest,
        options: {
          path: { type: "string", short: "p" },
          start: { type: "boolean" },
          logs: { type: "boolean" },
          stop: { type: "boolean" },
          daemon: { type: "boolean" },
        },
        strict: true,
      });
      const modes = [
        values.start,
        values.logs,
        values.stop,
        values.daemon,
      ].filter(Boolean);
      if (modes.length > 1) {
        console.error("Error: use only one of --start, --logs, --stop.\n");
        console.log(COMMAND_HELP.watch);
        process.exit(1);
      }
      await watchCommand(values);
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

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
  process.exit(1);
});
