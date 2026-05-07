import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  readIgnoreText,
  resolveProfileFilters,
  SidecarClient,
  type MerkleNode,
  type VgrepConfig,
} from "@vgrep/core";
import { c, header, row } from "../style";
import {
  FILES,
  ensureConfig,
  ensureVgrepIgnore,
  readMerkleJson,
  vgrepDir,
} from "../config";
import { runIndex } from "../indexing/index-project";

const HOME_VGREP_DIR = join(homedir(), ".vgrep");
const MODEL_DIR = join(HOME_VGREP_DIR, "models");
const FIRST_RUN_MARKER = join(HOME_VGREP_DIR, ".initialized");

/**
 * `vgrep init` — Build (or rebuild) the local index for the current project.
 *
 * - First run: scaffolds config + ignore, walks the tree, embeds every chunk
 * - Subsequent runs: walks again, diffs against `.vgrep/merkle.json`,
 *   embeds only the changed files
 *
 * All heavy work happens in the Mojo sidecar; we spawn a one-shot instance
 * here (the long-lived sidecar belongs to `vgrep watch --daemon`).
 */
export async function initCommand(options: {
  path?: string;
  force?: boolean;
  include?: string;
  only?: string;
  installSkill?: boolean;
}): Promise<void> {
  const projectRoot = resolve(options.path ?? process.cwd());

  console.log(header("init", projectRoot));

  const firstEverRun = !existsSync(FIRST_RUN_MARKER);
  await mkdir(MODEL_DIR, { recursive: true });
  if (firstEverRun) {
    console.log(row("model", `downloading to ${c.dim(MODEL_DIR)}`));
  }

  const config = await ensureConfig(projectRoot);
  const activeProfiles = resolveProfiles(config, options);
  console.log(row("profiles", activeProfiles.join(", ")));

  const createdIgnore = await ensureVgrepIgnore(projectRoot);
  if (createdIgnore) {
    console.log(row("scaffold", c.green(".vgrepignore created")));
    if (!options.force) {
      console.log();
      console.log(
        `${c.dim("review .vgrepignore + .vgrep/config.json, then run")} ${c.bold("vgrep init")}`,
      );
      console.log(
        `${c.dim("or skip with")} ${c.bold("vgrep init --force")}`,
      );
      return;
    }
  }

  const previous = await loadPreviousTree(projectRoot);
  const ignoreText = await readIgnoreText(projectRoot);
  const { extensions, filenames } = resolveProfileFilters(
    activeProfiles,
    config.fileProfiles ?? {},
  );

  const sidecar = new SidecarClient({
    projectRoot,
    env: sidecarEnv(firstEverRun),
  });
  await sidecar.start();
  try {
    await sidecar.open({
      projectRoot,
      dbPath: join(vgrepDir(projectRoot), FILES.index),
      cacheDir: join(vgrepDir(projectRoot), FILES.cache),
      extensions,
      filenames,
      ignoreText,
    });
    await runIndex({ sidecar, projectRoot, previous });
  } finally {
    await sidecar.close();
  }

  if (firstEverRun) {
    await writeFile(FIRST_RUN_MARKER, new Date().toISOString());
  }

  if (options.installSkill === true) {
    await installVgrepSkill(projectRoot);
  }
}

function sidecarEnv(firstRun: boolean): Record<string, string> {
  // Pin HF + transformers cache under ~/.vgrep so the model is downloaded
  // once globally (not per-project) and quiet the noisy progress bars on
  // every spawn — first-run downloads still get rendered.
  const env: Record<string, string> = {
    HF_HOME: MODEL_DIR,
    HF_HUB_CACHE: MODEL_DIR,
    TRANSFORMERS_CACHE: MODEL_DIR,
    SENTENCE_TRANSFORMERS_HOME: MODEL_DIR,
    TRANSFORMERS_VERBOSITY: "error",
    TRANSFORMERS_NO_ADVISORY_WARNINGS: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
  if (!firstRun) {
    env.HF_HUB_DISABLE_PROGRESS_BARS = "1";
    env.HF_HUB_DISABLE_TELEMETRY = "1";
  }
  return env;
}

async function loadPreviousTree(projectRoot: string): Promise<MerkleNode | null> {
  const json = await readMerkleJson(projectRoot);
  if (!json) return null;
  return JSON.parse(json) as MerkleNode;
}

const SKILL_SOURCE = "github:yvssineog/vgrep";

async function installVgrepSkill(projectRoot: string): Promise<void> {
  // Non-interactive install: we pin every prompt the installer asks
  // (target agent, scope, method) so it never blocks the terminal and
  // never paints its 80-column box-drawing UI over our log lines.
  const proc = Bun.spawn(
    [
      "npx", "--yes", "skills", "add", SKILL_SOURCE,
      "--skill", "vgrep",
      "--agent", "claude-code",
      "--scope", "project",
      "--method", "symlink",
      "--yes",
    ],
    {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    console.log(row("skill", c.green("installed")));
  } else {
    const hint = stderr.trim().split("\n").pop() ?? "";
    console.log(
      row("skill", c.yellow(`skipped (exit ${exitCode}) ${c.dim(hint)}`)),
    );
  }
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
