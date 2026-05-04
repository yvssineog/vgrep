import {
  Deferred,
  Duration,
  Effect,
  Queue,
  Ref,
  Schedule,
} from "effect";
import {
  createIndexableFileMatcher,
  deserializeTree,
  loadIgnore,
  matchesIgnore,
  paths,
  updateMerkleTree,
  type IgnoreRules,
  type MerkleNode,
  type VgrepConfig,
} from "@vgrep/core";
import { c, header, row } from "../style";
import {
  FILES,
  isInitialized,
  readConfig,
  readMerkleJson,
  vgrepDir,
} from "../config";
import { applyIndexDiffEffect } from "../indexing/index-project";

const DEBOUNCE_MS = 500;
const POLL_MS = 2000;
const LOG_TAIL_LINES = 80;

interface WatchEnv {
  projectRoot: string;
  config: VgrepConfig;
  isIndexableFile: (relativePath: string) => boolean;
  ignoreRules: IgnoreRules;
}

export async function watchCommand(options: {
  path?: string;
  start?: boolean;
  stop?: boolean;
  logs?: boolean;
  daemon?: boolean;
}): Promise<void> {
  const projectRoot = resolveProjectRoot(options.path);

  if (options.logs) return printLogs(projectRoot);
  if (options.stop) return stopDaemon(projectRoot);
  if (options.start) return startDaemon(projectRoot);

  if (options.daemon) {
    setupLogSink(paths.joinSystem(vgrepDir(projectRoot), FILES.watchLog));
  }

  console.log(header("watch", projectRoot));

  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('run "vgrep init"')}`);
    process.exit(1);
  }

  const config = await readConfig(projectRoot);
  const activeProfiles = resolveActiveProfiles(config);
  console.log(row("profiles", activeProfiles.join(", ")));
  if (options.daemon) {
    await Bun.write(
      paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid),
      String(process.pid),
    );
  }
  console.log(row("mode", options.daemon ? "daemon" : "foreground"));
  console.log(c.dim("watching for changes; press Ctrl+C to stop"));

  await Effect.runPromise(
    Effect.scoped(
      runWatcher({
        projectRoot,
        config,
        activeProfiles,
        cleanupPid: options.daemon === true,
      }),
    ),
  );
}

/**
 * The watcher is two cooperating fibers:
 *   - poller: ticks every POLL_MS, finds changed files, enqueues them
 *   - indexer: drains the candidates queue with a DEBOUNCE_MS settle window,
 *              then applies the index diff
 * A Deferred carries the SIGINT/SIGTERM signal; the program runs until it
 * is fulfilled, at which point both fibers are interrupted automatically by
 * the surrounding Scope.
 */
const runWatcher = (params: {
  projectRoot: string;
  config: VgrepConfig;
  activeProfiles: string[];
  cleanupPid: boolean;
}) =>
  Effect.gen(function* () {
    const { projectRoot, config, activeProfiles, cleanupPid } = params;

    const previousRoot = yield* Effect.tryPromise({
      try: async () => {
        const json = await readMerkleJson(projectRoot);
        if (!json) throw new Error('No merkle tree found. Run "vgrep init" first.');
        return deserializeTree(json);
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });

    const env: WatchEnv = {
      projectRoot,
      config,
      isIndexableFile: createIndexableFileMatcher(
        activeProfiles,
        config.fileProfiles ?? {},
      ),
      ignoreRules: yield* loadIgnore(projectRoot),
    };

    const root = yield* Ref.make<MerkleNode>(previousRoot);
    const metadata = yield* Ref.make<Map<string, string>>(
      collectMetadataFromTree(previousRoot),
    );
    const candidates = yield* Queue.unbounded<string>();
    const shutdown = yield* Deferred.make<void>();

    yield* Effect.fork(installShutdownHandler(shutdown, projectRoot, cleanupPid));
    yield* Effect.fork(forkLog(pollLoop(env, metadata, candidates), "poll"));
    yield* Effect.fork(forkLog(indexLoop(env, candidates, metadata, root), "update"));

    yield* Deferred.await(shutdown);
    console.log();
    console.log(row("watch", c.dim("stopped")));
  });

const forkLog = <A>(
  effect: Effect.Effect<A, Error>,
  label: string,
): Effect.Effect<void> =>
  effect.pipe(
    Effect.catchAll((err) =>
      Effect.sync(() =>
        console.log(row("watch", c.red(`${label} failed: ${err.message}`))),
      ),
    ),
    Effect.asVoid,
  );

const installShutdownHandler = (
  shutdown: Deferred.Deferred<void>,
  projectRoot: string,
  cleanupPid: boolean,
) =>
  Effect.async<void>((resume) => {
    const handler = (): void => {
      if (cleanupPid) {
        void removeFile(paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid));
      }
      Effect.runFork(Deferred.succeed(shutdown, undefined));
      resume(Effect.void);
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  });

const pollLoop = (
  env: WatchEnv,
  metadata: Ref.Ref<Map<string, string>>,
  candidates: Queue.Queue<string>,
) =>
  pollOnce(env, metadata, candidates).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(POLL_MS))),
    Effect.asVoid,
  );

const pollOnce = (
  env: WatchEnv,
  metadata: Ref.Ref<Map<string, string>>,
  candidates: Queue.Queue<string>,
) =>
  Effect.gen(function* () {
    const next = yield* scanMetadataEffect(env);
    const previous = yield* Ref.get(metadata);
    const changed: string[] = [];

    for (const [path, signature] of next) {
      if (previous.get(path) !== signature) changed.push(path);
    }
    for (const path of previous.keys()) {
      if (!next.has(path)) changed.push(path);
    }
    if (changed.length === 0) return;

    yield* Ref.set(metadata, next);
    for (const path of changed) {
      const normalized = paths.resolveCandidate(env.projectRoot, path);
      if (!normalized || isRuntimePath(normalized)) continue;
      yield* Queue.offer(candidates, normalized);
    }
  });

/**
 * Drains the candidates queue: take one (block), then debounce by sleeping
 * DEBOUNCE_MS and draining everything else that piled up. This collapses
 * bursts of file changes into a single index pass.
 */
const indexLoop = (
  env: WatchEnv,
  candidates: Queue.Queue<string>,
  metadata: Ref.Ref<Map<string, string>>,
  root: Ref.Ref<MerkleNode>,
) =>
  Effect.gen(function* () {
    const first = yield* Queue.take(candidates);
    yield* Effect.sleep(Duration.millis(DEBOUNCE_MS));
    const rest = yield* Queue.takeAll(candidates);
    const batch = new Set<string>([first, ...rest]);
    if (batch.size === 0) return;

    const previousRoot = yield* Ref.get(root);
    const result = yield* updateMerkleTree(
      env.projectRoot,
      previousRoot,
      batch,
      env.isIndexableFile,
    );

    yield* Ref.set(metadata, yield* scanMetadataEffect(env));
    if (!result.changed) return;

    console.log();
    console.log(row("detected", `${result.changes.length} file change(s)`));
    yield* applyIndexDiffEffect({
      projectRoot: env.projectRoot,
      treeJson: JSON.stringify(result.root, null, 2),
      changes: result.changes,
    });
    yield* Ref.set(root, result.root);
    console.log(row("watch", c.green("index updated")));
  }).pipe(Effect.forever);

const scanMetadataEffect = (
  env: WatchEnv,
): Effect.Effect<Map<string, string>, Error> =>
  Effect.tryPromise({
    try: async () => {
      const result = new Map<string, string>();
      for await (const path of new Bun.Glob("**/*").scan({
        cwd: env.projectRoot,
        dot: true,
        onlyFiles: true,
      })) {
        const relativePath = paths.toRelative(path);
        if (
          isRuntimePath(relativePath) ||
          matchesIgnore(env.ignoreRules, relativePath) ||
          !env.isIndexableFile(relativePath)
        ) {
          continue;
        }
        const file = Bun.file(paths.joinSystem(env.projectRoot, relativePath));
        if (!(await file.exists())) continue;
        result.set(relativePath, `${file.size}:${file.lastModified}`);
      }
      return result;
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

function collectMetadataFromTree(root: MerkleNode): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (n: MerkleNode): void => {
    if (n.type === "file") {
      result.set(n.path, `${n.size ?? 0}:${n.mtime ?? 0}`);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return result;
}

function resolveActiveProfiles(config: VgrepConfig): string[] {
  return config.defaultProfiles?.length ? config.defaultProfiles : ["code"];
}

function resolveProjectRoot(path?: string): string {
  if (!path) return paths.toSystem(process.cwd());
  const normalized = paths.toSystem(path);
  if (paths.isAbsolute(normalized)) return normalized;
  return paths.joinSystem(process.cwd(), normalized);
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
    await removeFile(paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid));
  }
  const logPath = paths.joinSystem(vgrepDir(projectRoot), FILES.watchLog);
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
  await Bun.write(
    paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid),
    String(proc.pid),
  );
  const earlyExit = await Promise.race([
    proc.exited.then((code) => code),
    new Promise<null>((r) => setTimeout(() => r(null), 750)),
  ]);
  if (earlyExit !== null) {
    await removeFile(paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid));
    console.log(row("watch", c.red(`failed to start (exit ${earlyExit})`)));
    console.log(row("logs", c.dim(logPath)));
    process.exit(1);
  }
  console.log(row("watch", c.green(`started pid ${proc.pid}`)));
  console.log(row("logs", c.dim(logPath)));
}

async function stopDaemon(projectRoot: string): Promise<void> {
  const pidPath = paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid);
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
  const logPath = paths.joinSystem(vgrepDir(projectRoot), FILES.watchLog);
  const file = Bun.file(logPath);
  if (!(await file.exists())) {
    console.log(row("logs", c.dim("no watch log found")));
    return;
  }
  const lines = (await file.text()).replace(/\n+$/, "").split("\n");
  console.log(lines.slice(-LOG_TAIL_LINES).join("\n"));
}

async function readPid(projectRoot: string): Promise<number | null> {
  const file = Bun.file(paths.joinSystem(vgrepDir(projectRoot), FILES.watchPid));
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
  const cliSourcePath = paths.joinSystem(import.meta.dir, "../cli.ts");
  const bunExecutable = Bun.argv[0] ?? "bun";
  if (import.meta.path.endsWith(".ts")) {
    return [bunExecutable, cliSourcePath, "watch", "--daemon", "--path", projectRoot];
  }
  return [bunExecutable, "watch", "--daemon", "--path", projectRoot];
}

/**
 * Redirect console.log/error into the daemon log file. Each line is appended
 * via `node:fs/promises.appendFile` (atomic for line-sized writes), so we no
 * longer need the prior write-chain Promise serialization.
 */
function setupLogSink(logPath: string): void {
  const { appendFile } = require("node:fs/promises") as typeof import("node:fs/promises");
  const write = (level: "log" | "error", values: unknown[]): void => {
    const line = `${new Date().toISOString()} ${values.map(formatLogValue).join(" ")}\n`;
    void appendFile(logPath, line);
    if (level === "error") process.stderr.write(line);
  };
  console.log = (...v: unknown[]) => write("log", v);
  console.error = (...v: unknown[]) => write("error", v);
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return JSON.stringify(value);
}

async function removeFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  await file.delete();
}
