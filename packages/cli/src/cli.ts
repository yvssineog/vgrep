#!/usr/bin/env bun

import { Command } from "commander";
import { initCommand } from "./commands/init";
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
