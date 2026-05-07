import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  Deferred,
  Duration,
  Effect,
  Queue,
  Ref,
  Schedule,
} from "effect";
import {
  paths,
  readIgnoreText,
  resolveProfileFilters,
  SidecarClient,
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
import { runIndex } from "../indexing/index-project";
import { ensureDaemon } from "../daemon/client";
import { daemonPaths, type SearchRequest, type SearchResponse } from "../daemon/protocol";

const DEBOUNCE_MS = 500;
const POLL_MS = 2000;
const LOG_TAIL_LINES = 80;

/** Runtime directories the poller never traverses, even without a `.vgrepignore`. */
const HARD_SKIP_DIRS = new Set([
  ".git",
  ".vgrep",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
]);

interface WatchEnv {
  projectRoot: string;
  config: VgrepConfig;
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

  const dPaths = daemonPaths(projectRoot);

  if (options.daemon) setupLogSink(dPaths.log);

  console.log(header("watch", projectRoot));

  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('run "vgrep init"')}`);
    process.exit(1);
  }

  const existingPid = await readPid(dPaths.pid);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(
      row("watch", c.yellow(`already running pid ${existingPid}`)),
    );
    process.exit(1);
  }
  if (existingPid) await removeFile(dPaths.pid);
  await Bun.write(dPaths.pid, String(process.pid));

  const config = await readConfig(projectRoot);
  const activeProfiles = resolveActiveProfiles(config);
  console.log(row("profiles", activeProfiles.join(", ")));
  console.log(row("mode", options.daemon ? "daemon" : "foreground"));
  console.log(row("socket", c.dim(dPaths.sock)));
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
 * Long-running daemon: spawns one Mojo sidecar, holds it for the whole
 * lifetime, and forks three fibers under one scope:
 *
 *   - poller : every POLL_MS, scans `size:mtime` and enqueues changed files
 *   - indexer: drains the queue with DEBOUNCE_MS, then asks the sidecar to
 *              diff + apply (the sidecar owns the actual chunking + embedding)
 *   - server : Bun.serve over Unix socket, routing /search to the sidecar
 *
 * SIGINT/SIGTERM fulfills `shutdown`, which interrupts the fibers and runs
 * the scope finalizers — including `sidecar.close()`, which gracefully
 * terminates the Mojo process.
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
        return JSON.parse(json) as MerkleNode;
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });

    const sidecar = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new SidecarClient({ projectRoot });
          await client.start();
          const ignoreText = await readIgnoreText(projectRoot);
          const { extensions, filenames } = resolveProfileFilters(
            activeProfiles,
            config.fileProfiles ?? {},
          );
          await client.open({
            projectRoot,
            dbPath: join(vgrepDir(projectRoot), FILES.index),
            cacheDir: join(vgrepDir(projectRoot), FILES.cache),
            extensions,
            filenames,
            ignoreText,
          });
          return client;
        },
        catch: (e) => (e instanceof Error ? e : new Error(String(e))),
      }),
      (client) => Effect.promise(() => client.close()),
    );

    // Warmup: a no-op `health` request guarantees the model is loaded and
    // the SQLite WAL is paged in before the first user-facing request hits.
    yield* Effect.tryPromise({
      try: () => sidecar.health(),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(Effect.catchAll(() => Effect.void));
    console.log(row("warmup", c.green("ready")));

    const env: WatchEnv = { projectRoot, config };
    const root = yield* Ref.make<MerkleNode>(previousRoot);
    const metadata = yield* Ref.make<Map<string, string>>(
      collectMetadataFromTree(previousRoot),
    );
    const candidates = yield* Queue.unbounded<string>();
    const shutdown = yield* Deferred.make<void>();

    const dPaths = daemonPaths(projectRoot);
    yield* ensureFreshSocket(dPaths.sock);

    yield* Effect.fork(installShutdownHandler(shutdown, projectRoot, cleanupPid));
    yield* Effect.fork(forkLog(pollLoop(env, metadata, candidates), "poll"));
    yield* Effect.fork(
      forkLog(indexLoop(env, candidates, root, sidecar), "update"),
    );

    const server = Bun.serve({
      unix: dPaths.sock,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/search") {
          return handleSearch(req, sidecar);
        }
        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
      error(err) {
        console.error("server error", err);
        return new Response("internal error", { status: 500 });
      },
    });

    yield* Deferred.await(shutdown);
    server.stop(true);
    yield* Effect.promise(() => safeUnlink(dPaths.sock));
    console.log();
    console.log(row("watch", c.dim("stopped")));
  });

async function handleSearch(
  req: Request,
  sidecar: SidecarClient,
): Promise<Response> {
  let body: SearchRequest;
  try {
    body = (await req.json()) as SearchRequest;
  } catch {
    return jsonResponse({ ok: false, error: "invalid json body" }, 400);
  }
  if (typeof body.query !== "string" || !body.query) {
    return jsonResponse({ ok: false, error: "missing query" }, 400);
  }
  const topK =
    Number.isFinite(body.topK) && body.topK > 0 ? Math.floor(body.topK) : 3;

  try {
    const { results } = await sidecar.search({ query: body.query, topK });
    return jsonResponse({ ok: true, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: msg }, 500);
  }
}

function jsonResponse(payload: SearchResponse, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ensureFreshSocket = (sockPath: string): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (existsSync(sockPath)) await safeUnlink(sockPath);
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
        void removeFile(paths.joinSystem(vgrepDir(projectRoot), FILES.daemonPid));
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
 * Drain the candidates queue, debouncing bursts into a single index pass.
 * The sidecar does its own walk + diff (we don't ship the candidate list
 * yet — that's a follow-up optimization for very large repos).
 */
const indexLoop = (
  env: WatchEnv,
  candidates: Queue.Queue<string>,
  root: Ref.Ref<MerkleNode>,
  sidecar: SidecarClient,
) =>
  Effect.gen(function* () {
    const first = yield* Queue.take(candidates);
    yield* Effect.sleep(Duration.millis(DEBOUNCE_MS));
    const rest = yield* Queue.takeAll(candidates);
    const batch = new Set<string>([first, ...rest]);
    if (batch.size === 0) return;

    const previousRoot = yield* Ref.get(root);
    console.log();
    console.log(row("detected", `${batch.size} file change(s)`));

    const result = yield* Effect.tryPromise({
      try: () =>
        runIndex({
          sidecar,
          projectRoot: env.projectRoot,
          previous: previousRoot,
          verbose: false,
        }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    });

    yield* Ref.set(root, result.tree);
    if (result.changes.length > 0) {
      console.log(
        row(
          "watch",
          c.green(
            `index updated (${result.stats.indexedChunks} chunks, ${result.changes.length} files)`,
          ),
        ),
      );
    }
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
        if (isRuntimePath(relativePath)) continue;
        if (hasSkippedSegment(relativePath)) continue;
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

function hasSkippedSegment(path: string): boolean {
  for (const seg of path.split("/")) {
    if (HARD_SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

async function startDaemon(projectRoot: string): Promise<void> {
  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('run "vgrep init"')}`);
    process.exit(1);
  }
  const dPaths = daemonPaths(projectRoot);
  const existingPid = await readPid(dPaths.pid);
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(row("watch", c.yellow(`already running pid ${existingPid}`)));
    return;
  }
  if (existingPid) await removeFile(dPaths.pid);

  await Bun.write(dPaths.log, "");

  console.log(header("watch", projectRoot));
  try {
    await ensureDaemon(projectRoot, {
      onSpawn: () => console.log(row("starting", c.dim("loading model..."))),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(row("watch", c.red(`failed to start (${msg})`)));
    console.log(row("logs", c.dim(dPaths.log)));
    process.exit(1);
  }

  const pid = await readPid(dPaths.pid);
  console.log(row("watch", c.green(`started pid ${pid ?? "?"}`)));
  console.log(row("socket", c.dim(dPaths.sock)));
  console.log(row("logs", c.dim(dPaths.log)));
}

async function stopDaemon(projectRoot: string): Promise<void> {
  const dPaths = daemonPaths(projectRoot);
  const pid = await readPid(dPaths.pid);
  if (!pid) {
    console.log(row("watch", c.dim("not running")));
    return;
  }
  if (!isProcessAlive(pid)) {
    await removeFile(dPaths.pid);
    await removeFile(dPaths.sock);
    console.log(row("watch", c.dim("stale pid removed")));
    return;
  }
  process.kill(pid, "SIGTERM");
  await removeFile(dPaths.pid);
  console.log(row("watch", c.green(`stopped pid ${pid}`)));
}

async function printLogs(projectRoot: string): Promise<void> {
  const logPath = daemonPaths(projectRoot).log;
  const file = Bun.file(logPath);
  if (!(await file.exists())) {
    console.log(row("logs", c.dim("no daemon log found")));
    return;
  }
  const lines = (await file.text()).replace(/\n+$/, "").split("\n");
  console.log(lines.slice(-LOG_TAIL_LINES).join("\n"));
}

async function readPid(pidPath: string): Promise<number | null> {
  const file = Bun.file(pidPath);
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

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}

async function removeFile(path: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  await file.delete();
}
