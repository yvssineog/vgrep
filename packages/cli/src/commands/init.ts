import { resolve } from "node:path";
import type { VgrepConfig } from "@vgrep/core";
import { c, header, row } from "../style";
import { ensureConfig, ensureVgrepIgnore } from "../config";
import { indexProject } from "../indexing/index-project";

/**
 * `vgrep init` - Build (or rebuild) the local index for the current project.
 *
 * - First run: scaffolds config/ignore files, builds the tree, persists it
 * - Subsequent runs: rebuilds, diffs against previous state, indexes changes
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

  await indexProject({ projectRoot, config, activeProfiles });

  if (options.installSkill !== false) {
    await installVgrepSkill(projectRoot);
  }
}

const SKILL_SOURCE = "github:yvssineog/vgrep";

async function installVgrepSkill(projectRoot: string): Promise<void> {
  console.log();
  console.log(c.dim("running: npx skills add (interactive)"));
  const proc = Bun.spawn(
    ["npx", "--yes", "skills", "add", SKILL_SOURCE, "--skill", "vgrep"],
    {
      cwd: projectRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;
  console.log();

  if (exitCode === 0) {
    console.log(row("skill", c.green("installed")));
  } else {
    console.log(
      row(
        "skill",
        c.yellow(
          `skipped (exit ${exitCode}) - re-run with: npx skills add ${SKILL_SOURCE} --skill vgrep`,
        ),
      ),
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
