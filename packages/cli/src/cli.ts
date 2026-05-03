#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
import { searchCommand } from "./commands/search";
import { statusCommand } from "./commands/status";

const program = new Command();

program
  .name("vgrep")
  .description(
    "⚡ Vector Grep — Semantic search for your codebase, local-first.",
  )
  .version("0.1.0");

// ─── vgrep init ────────────────────────────────────────────────
program
  .command("init")
  .description("Build (or rebuild) the Merkle tree index for the current project")
  .option("-p, --path <dir>", "Project root directory (defaults to cwd)")
  .option("-f, --force", "Continue indexing after scaffolding .vgrepignore")
  .option(
    "--include <profiles>",
    "Comma-separated file profiles to add to defaultProfiles",
  )
  .option(
    "--only <profiles>",
    "Comma-separated file profiles to use instead of defaultProfiles",
  )
  .action(async (opts) => {
    await initCommand(opts);
  });

// ─── vgrep status ──────────────────────────────────────────────
program
  .command("status")
  .description("Display current index status and tree statistics")
  .option("-p, --path <dir>", "Project root directory (defaults to cwd)")
  .action(async (opts) => {
    await statusCommand(opts);
  });

// --- vgrep search ----------------------------------------------------------
program
  .command("search")
  .description("Semantic search over the local vector index")
  .argument("<query...>", "Search query")
  .option("-p, --path <dir>", "Project root directory (defaults to cwd)")
  .option("-k, --top-k <n>", "Number of results to return", "10")
  .action(async (query, opts) => {
    await searchCommand(query, opts);
  });

program.parse();
