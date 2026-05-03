import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_FILE_PROFILES } from "@vgrep/core";
import type { VgrepConfig } from "@vgrep/core";

/** Name of the hidden vgrep directory */
export const VGREP_DIR = ".vgrep";

/** Filenames inside .vgrep/ */
export const FILES = {
  config: "config.json",
  merkle: "merkle.json",
  lancedb: "lancedb",
  cache: "cache",
} as const;

/**
 * Resolve the .vgrep directory path for a given project root.
 */
export function vgrepDir(projectRoot: string): string {
  return join(projectRoot, VGREP_DIR);
}

/**
 * Ensure the .vgrep directory and subdirectories exist.
 */
export async function ensureVgrepDir(projectRoot: string): Promise<string> {
  const dir = vgrepDir(projectRoot);
  await mkdir(join(dir, FILES.cache), { recursive: true });
  await mkdir(join(dir, FILES.lancedb), { recursive: true });
  return dir;
}

/**
 * Check if a project has been initialized with vgrep.
 */
export function isInitialized(projectRoot: string): boolean {
  return existsSync(join(vgrepDir(projectRoot), FILES.merkle));
}

/**
 * Read the vgrep config. Returns default local config if not found.
 */
export async function readConfig(projectRoot: string): Promise<VgrepConfig> {
  const configPath = join(vgrepDir(projectRoot), FILES.config);
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return { mode: "local" };
  }

  return file.json() as Promise<VgrepConfig>;
}

export async function ensureConfig(projectRoot: string): Promise<VgrepConfig> {
  const existing = await readConfig(projectRoot);
  const config: VgrepConfig = {
    ...existing,
    mode: existing.mode ?? "local",
    defaultProfiles: existing.defaultProfiles ?? ["code"],
    fileProfiles: {
      ...DEFAULT_FILE_PROFILES,
      ...(existing.fileProfiles ?? {}),
    },
  };

  await writeConfig(projectRoot, config);
  return config;
}

/**
 * Write the vgrep config to disk.
 */
export async function writeConfig(
  projectRoot: string,
  config: VgrepConfig,
): Promise<void> {
  const dir = await ensureVgrepDir(projectRoot);
  await Bun.write(
    join(dir, FILES.config),
    JSON.stringify(config, null, 2),
  );
}

/**
 * Read the persisted Merkle tree JSON, or null if it doesn't exist.
 */
export async function readMerkleJson(
  projectRoot: string,
): Promise<string | null> {
  const merklePath = join(vgrepDir(projectRoot), FILES.merkle);
  const file = Bun.file(merklePath);

  if (!(await file.exists())) {
    return null;
  }

  return file.text();
}

/**
 * Write the Merkle tree JSON to disk.
 */
export async function writeMerkleJson(
  projectRoot: string,
  json: string,
): Promise<void> {
  const dir = await ensureVgrepDir(projectRoot);
  await Bun.write(join(dir, FILES.merkle), json);
}

/**
 * Ensure a .vgrepignore file exists in the project root.
 * If not, create one with default patterns.
 */
export async function ensureVgrepIgnore(projectRoot: string): Promise<boolean> {
  const ignorePath = join(projectRoot, ".vgrepignore");
  const file = Bun.file(ignorePath);

  if (await file.exists()) {
    return false; // Already exists
  }

  const defaultContent = `# vgrep ignore file
# Same syntax as .gitignore

# Common large or irrelevant directories
node_modules/
.git/
.vgrep/
dist/
build/
.next/
.turbo/
coverage/

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# System files
.DS_Store
Thumbs.db
`;

  await Bun.write(ignorePath, defaultContent);
  return true; // Newly created
}
