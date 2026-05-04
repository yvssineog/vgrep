import {
  MerkleTree,
  MerkleTreeUpdater,
  createIndexableFileMatcher,
} from "@vgrep/core";
import type { MerkleNode, VgrepConfig } from "@vgrep/core";
import { c, header, row } from "../style";
import {
  FILES,
  isInitialized,
  readConfig,
  readMerkleJson,
  vgrepDir,
} from "../config";
import { applyIndexDiff } from "../indexing/index-project";

const DEBOUNCE_MS = 500;
const POLL_MS = 2000;
const LOG_TAIL_LINES = 80;

interface WatchRuntime {
  projectRoot: string;
  config: VgrepConfig;
  activeProfiles: string[];
  isIndexableFile: (relativePath: string) => boolean;
  ignoreRules: IgnoreRules;
  updater: MerkleTreeUpdater;
  metadata: Map<string, string>;
  candidates: Set<string>;
  running: boolean;
  pending: boolean;
  debounceTimer: Timer | null;
  pollTimer: Timer | null;
}

interface IgnoreRules {
  exactNames: Set<string>;
  globPatterns: Bun.Glob[];
}

export async function watchCommand(options: {
  path?: string;
  start?: boolean;
  stop?: boolean;
  logs?: boolean;
  daemon?: boolean;
}): Promise<void> {
  const projectRoot = resolveProjectRoot(options.path);

  if (options.logs) {
    await printLogs(projectRoot);
    return;
  }

  if (options.stop) {
    await stopDaemon(projectRoot);
    return;
  }

  if (options.start) {
    await startDaemon(projectRoot);
    return;
  }

  if (options.daemon) {
    setupLogSink(joinPath(vgrepDir(projectRoot), FILES.watchLog));
  }

  console.log(header("watch", projectRoot));

  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('run "vgrep init"')}`);
    process.exit(1);
  }

  const config = await readConfig(projectRoot);
  const activeProfiles = resolveActiveProfiles(config);
  const previousRoot = await readPersistedRoot(projectRoot);
  const matcher = createIndexableFileMatcher(
    activeProfiles,
    config.fileProfiles ?? {},
  );
  const ignoreRules = await readIgnoreRules(projectRoot);
  const runtime: WatchRuntime = {
    projectRoot,
    config,
    activeProfiles,
    isIndexableFile: matcher,
    ignoreRules,
    updater: new MerkleTreeUpdater(projectRoot, previousRoot, matcher),
    metadata: collectMetadataFromTree(previousRoot),
    candidates: new Set(),
    running: false,
    pending: false,
    debounceTimer: null,
    pollTimer: null,
  };

  console.log(row("profiles", activeProfiles.join(", ")));
  if (options.daemon) {
    await Bun.write(
      joinPath(vgrepDir(projectRoot), FILES.watchPid),
      String(process.pid),
    );
  }

  console.log(row("mode", options.daemon ? "daemon" : "foreground"));
  console.log(c.dim("watching for changes; press Ctrl+C to stop"));

  runtime.pollTimer = setInterval(() => {
    void pollMetadata(runtime);
  }, POLL_MS);

  await waitForShutdown(runtime, options.daemon === true);
}

async function readPersistedRoot(projectRoot: string): Promise<MerkleNode> {
  const merkleJson = await readMerkleJson(projectRoot);
  if (!merkleJson) {
    throw new Error('No merkle tree found. Run "vgrep init" first.');
  }

  return MerkleTree.deserialize(merkleJson);
}

async function pollMetadata(runtime: WatchRuntime): Promise<void> {
  const next = await scanMetadata(runtime);
  const candidates = new Set<string>();

  for (const [path, signature] of next) {
    if (runtime.metadata.get(path) !== signature) {
      candidates.add(path);
    }
  }

  for (const path of runtime.metadata.keys()) {
    if (!next.has(path)) {
      candidates.add(path);
    }
  }

  if (candidates.size === 0) return;

  runtime.metadata = next;
  for (const path of candidates) {
    queueCandidate(runtime, path);
  }
}

function queueCandidate(runtime: WatchRuntime, path: string): void {
  const normalized = normalizeCandidate(runtime.projectRoot, path);
  if (!normalized || isRuntimePath(normalized)) return;

  runtime.candidates.add(normalized);
  if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
  runtime.debounceTimer = setTimeout(() => {
    void flushCandidates(runtime);
  }, DEBOUNCE_MS);
}

async function flushCandidates(runtime: WatchRuntime): Promise<void> {
  if (runtime.running) {
    runtime.pending = true;
    return;
  }

  const candidates = [...runtime.candidates];
  runtime.candidates.clear();
  if (candidates.length === 0) return;

  runtime.running = true;
  runtime.pending = false;

  try {
    const result = await runtime.updater.updateCandidates(candidates);
    runtime.metadata = await scanMetadata(runtime);

    if (!result.changed) {
      return;
    }

    console.log();
    console.log(row("detected", `${result.changes.length} file change(s)`));
    await applyIndexDiff({
      projectRoot: runtime.projectRoot,
      treeJson: runtime.updater.serialize(),
      changes: result.changes,
    });
    console.log(row("watch", c.green("index updated")));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(row("watch", c.red(`update failed: ${message}`)));
  } finally {
    runtime.running = false;
  }

  if (runtime.pending || runtime.candidates.size > 0) {
    runtime.pending = false;
    void flushCandidates(runtime);
  }
}

async function waitForShutdown(
  runtime: WatchRuntime,
  cleanupPid: boolean,
): Promise<void> {
  let stop!: () => void;
  const stopped = new Promise<void>((resolveStop) => {
    stop = resolveStop;
  });

  const shutdown = (): void => {
    if (runtime.debounceTimer) clearTimeout(runtime.debounceTimer);
    if (runtime.pollTimer) clearInterval(runtime.pollTimer);
    if (cleanupPid) {
      void removeFile(joinPath(vgrepDir(runtime.projectRoot), FILES.watchPid));
    }
    console.log();
    console.log(row("watch", c.dim("stopped")));
    stop();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await stopped;
}

async function scanMetadata(runtime: WatchRuntime): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const glob = new Bun.Glob("**/*");

  for await (const path of glob.scan({
    cwd: runtime.projectRoot,
    dot: true,
    onlyFiles: true,
  })) {
    const relativePath = normalizeRelativePath(path);
    if (
      isRuntimePath(relativePath) ||
      isIgnored(relativePath, runtime.ignoreRules) ||
      !runtime.isIndexableFile(relativePath)
    ) {
      continue;
    }

    const file = Bun.file(joinPath(runtime.projectRoot, relativePath));
    if (!(await file.exists())) continue;
    result.set(relativePath, `${file.size}:${file.lastModified}`);
  }
  return result;
}

function collectMetadataFromTree(root: MerkleNode): Map<string, string> {
  const result = new Map<string, string>();

  const walk = (node: MerkleNode): void => {
    if (node.type === "file") {
      result.set(node.path, `${node.size ?? 0}:${node.mtime ?? 0}`);
      return;
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  walk(root);
  return result;
}

function resolveActiveProfiles(config: VgrepConfig): string[] {
  return config.defaultProfiles?.length ? config.defaultProfiles : ["code"];
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeSystemPath(path: string): string {
  return normalizeRelativePath(path).replace(/\/+$/, "");
}

function resolveProjectRoot(path?: string): string {
  if (!path) return normalizeSystemPath(process.cwd());
  const normalized = normalizeSystemPath(path);
  if (isAbsolutePath(normalized)) return normalized;
  return joinPath(process.cwd(), normalized);
}

function joinPath(base: string, relativePath: string): string {
  const normalizedBase = normalizeSystemPath(base);
  const normalizedRelative = normalizeRelativePath(relativePath);
  if (!normalizedRelative || normalizedRelative === ".") return normalizedBase;
  return `${normalizedBase}/${normalizedRelative}`;
}

function normalizeCandidate(projectRoot: string, path: string): string {
  const relativePath = isAbsolutePath(path)
    ? relativePathFrom(projectRoot, path)
    : path;
  return normalizeRelativePath(relativePath);
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(normalizeRelativePath(path)) || path.startsWith("/");
}

function relativePathFrom(rootDir: string, absolutePath: string): string {
  const root = normalizeSystemPath(rootDir).toLowerCase();
  const target = normalizeSystemPath(absolutePath);
  const lowerTarget = target.toLowerCase();
  if (lowerTarget === root) return ".";
  if (lowerTarget.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  return target;
}

function isRuntimePath(path: string): boolean {
  return (
    path === ".vgrep" ||
    path.startsWith(".vgrep/") ||
    path === ".git" ||
    path.startsWith(".git/")
  );
}

async function startDaemon(projectRoot: string): Promise<void> {
  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('run "vgrep init"')}`);
    process.exit(1);
  }

  const existingPid = await readPid(projectRoot);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(row("watch", c.yellow(`already running pid ${existingPid}`)));
    return;
  }
  if (existingPid) {
    await removeFile(joinPath(vgrepDir(projectRoot), FILES.watchPid));
  }

  const logPath = joinPath(vgrepDir(projectRoot), FILES.watchLog);
  await Bun.write(logPath, "");

  const cmd = buildDaemonCommand(projectRoot);
  const proc = Bun.spawn(cmd, {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  proc.unref();

  await Bun.write(joinPath(vgrepDir(projectRoot), FILES.watchPid), String(proc.pid));
  const earlyExit = await Promise.race([
    proc.exited.then((code) => code),
    sleep(750).then(() => null),
  ]);
  if (earlyExit !== null) {
    await removeFile(joinPath(vgrepDir(projectRoot), FILES.watchPid));
    console.log(row("watch", c.red(`failed to start (exit ${earlyExit})`)));
    console.log(row("logs", c.dim(logPath)));
    process.exit(1);
  }

  console.log(row("watch", c.green(`started pid ${proc.pid}`)));
  console.log(row("logs", c.dim(logPath)));
}

async function stopDaemon(projectRoot: string): Promise<void> {
  const pidPath = joinPath(vgrepDir(projectRoot), FILES.watchPid);
  const pid = await readPid(projectRoot);
  if (!pid) {
    console.log(row("watch", c.dim("not running")));
    return;
  }

  if (!isProcessAlive(pid)) {
    await removeFile(pidPath);
    console.log(row("watch", c.dim("stale pid removed")));
    return;
  }

  process.kill(pid, "SIGTERM");
  await removeFile(pidPath);
  console.log(row("watch", c.green(`stopped pid ${pid}`)));
}

async function printLogs(projectRoot: string): Promise<void> {
  const logPath = joinPath(vgrepDir(projectRoot), FILES.watchLog);
  const file = Bun.file(logPath);
  if (!(await file.exists())) {
    console.log(row("logs", c.dim("no watch log found")));
    return;
  }

  const lines = (await file.text()).replace(/\n+$/, "").split("\n");
  console.log(lines.slice(-LOG_TAIL_LINES).join("\n"));
}

async function readPid(projectRoot: string): Promise<number | null> {
  const file = Bun.file(joinPath(vgrepDir(projectRoot), FILES.watchPid));
  if (!(await file.exists())) return null;

  const pid = Number.parseInt((await file.text()).trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildDaemonCommand(projectRoot: string): string[] {
  const cliSourcePath = joinPath(import.meta.dir, "../cli.ts");
  const bunExecutable = Bun.argv[0] ?? "bun";

  if (import.meta.path.endsWith(".ts")) {
    return [
      bunExecutable,
      cliSourcePath,
      "watch",
      "--daemon",
      "--path",
      projectRoot,
    ];
  }

  return [bunExecutable, "watch", "--daemon", "--path", projectRoot];
}

function setupLogSink(logPath: string): void {
  let writeChain = Promise.resolve();
  const write = (level: "log" | "error", values: unknown[]): void => {
    const line = values.map(formatLogValue).join(" ");
    writeChain = writeChain.then(async () => {
      const file = Bun.file(logPath);
      const previous = (await file.exists()) ? await file.text() : "";
      await Bun.write(logPath, `${previous}${new Date().toISOString()} ${line}\n`);
    });
    if (level === "error") {
      process.stderr.write(`${line}\n`);
    }
  };

  console.log = (...values: unknown[]) => write("log", values);
  console.error = (...values: unknown[]) => write("error", values);
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return JSON.stringify(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readIgnoreRules(projectRoot: string): Promise<IgnoreRules> {
  const ignoreFile = Bun.file(joinPath(projectRoot, ".vgrepignore"));
  if (!(await ignoreFile.exists())) {
    return { exactNames: new Set(), globPatterns: [] };
  }

  const content = await ignoreFile.text();
  return parseIgnorePatterns(content.split("\n"));
}

function parseIgnorePatterns(patterns: Iterable<string>): IgnoreRules {
  const exactNames = new Set<string>();
  const globPatterns: Bun.Glob[] = [];

  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const pattern = line.endsWith("/") ? line.slice(0, -1) : line;

    if (/[*?{}\[\]]/.test(pattern)) {
      globPatterns.push(new Bun.Glob(pattern));
    } else {
      exactNames.add(normalizeRelativePath(pattern));
    }
  }

  return { exactNames, globPatterns };
}

function isIgnored(relativePath: string, ignoreRules: IgnoreRules): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const name = basename(normalizedPath);
  const segments = normalizedPath.split("/");

  if (
    ignoreRules.exactNames.has(name) ||
    ignoreRules.exactNames.has(normalizedPath) ||
    segments.some((segment) => ignoreRules.exactNames.has(segment))
  ) {
    return true;
  }

  for (const glob of ignoreRules.globPatterns) {
    if (glob.match(name) || glob.match(normalizedPath)) return true;
  }

  return false;
}

function basename(path: string): string {
  const normalized = normalizeRelativePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

async function removeFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  await file.delete();
}
