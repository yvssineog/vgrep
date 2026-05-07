import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ApplyDiffParams,
  ApplyDiffResult,
  BuildTreeResult,
  ErrorFrame,
  Frame,
  Method,
  OpenParams,
  ProgressFrame,
  ResultFrame,
  SearchOk,
  SearchParams,
  UpdateTreeParams,
  UpdateTreeResult,
} from "./protocol";

/**
 * Spawn the Mojo sidecar (`vgrep-core`) and talk to it over stdio.
 *
 * One client per project — we hold the process for the daemon's full
 * lifetime so the model and SQLite handle stay warm. Each request
 * gets a UUID; replies are multiplexed back through `pending` keyed
 * by that UUID, with an optional `onProgress` for streaming stages.
 *
 * If the binary isn't on disk yet we fall back to `pixi run -- mojo
 * run …` against the source tree, which keeps `bun packages/cli/src/cli.ts`
 * working in development without a pre-built binary.
 */

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (frame: ProgressFrame) => void;
};

export interface SidecarClientOptions {
  /** Where to look for the Mojo binary. Defaults to `.vgrep/bin/vgrep-core`. */
  binaryPath?: string;
  /** Project root used as `cwd` for the sidecar. */
  projectRoot: string;
  /** Repo root that contains the `packages/core-mojo` source tree (dev fallback). */
  repoRoot?: string;
  /**
   * Override the entire spawn command. Bypasses `binaryPath` resolution
   * entirely — useful when the binary needs to run inside a pixi env
   * (`["pixi", "run", "--", "vgrep-core"]`) to find its Python deps.
   */
  command?: string[];
  /**
   * Extra env vars to merge into the sidecar's environment. Used to point
   * HuggingFace caches at a global directory and silence progress bars.
   */
  env?: Record<string, string>;
}

export class SidecarClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: SidecarClientOptions) {}

  async start(): Promise<void> {
    if (this.proc) return;
    const cmd = resolveSidecarCommand(this.options);
    this.proc = Bun.spawn(cmd, {
      cwd: this.options.projectRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(this.options.env ?? {}) } as Record<string, string>,
    });
    void this.consumeStdout();
    void this.consumeStderr();
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("health", {});
  }

  async open(params: OpenParams): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("open", params);
  }

  async buildTree(): Promise<BuildTreeResult> {
    return this.request<BuildTreeResult>("merkle.build", {});
  }

  async updateTree(params: UpdateTreeParams): Promise<UpdateTreeResult> {
    return this.request<UpdateTreeResult>("merkle.update", params);
  }

  async applyDiff(
    params: ApplyDiffParams,
    onProgress?: (frame: ProgressFrame) => void,
  ): Promise<ApplyDiffResult> {
    return this.request<ApplyDiffResult>("index.applyDiff", params, onProgress);
  }

  async search(params: SearchParams): Promise<SearchOk> {
    return this.request<SearchOk>("search", params);
  }

  async close(): Promise<void> {
    if (this.closed || !this.proc) return;
    this.closed = true;
    try {
      // Send a close frame so the sidecar can flush + free resources.
      await this.request("close", {}).catch(() => undefined);
    } finally {
      this.proc.kill();
      await this.proc.exited;
    }
  }

  // ── internals ────────────────────────────────────────────────────

  private request<T>(
    method: Method,
    params: unknown,
    onProgress?: (frame: ProgressFrame) => void,
  ): Promise<T> {
    if (!this.proc) throw new Error("sidecar not started");
    const id = `r${this.nextId++}`;
    const frame = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
      });
      try {
        // Bun.Subprocess.stdin is a FileSink — write returns a number, not a
        // promise. flush() returns a promise; we await it so backpressure
        // is honored when the sidecar is slow to drain.
        const sink = this.proc!.stdin;
        sink.write(frame);
        void sink.flush();
      } catch (err: unknown) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async consumeStdout(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.dispatchFrame(line);
        nl = this.buffer.indexOf("\n");
      }
    }
    this.failAllPending(new Error("sidecar exited"));
  }

  private async consumeStderr(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stderr.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (!isNoiseLine(line)) process.stderr.write(`${line}\n`);
        nl = pending.indexOf("\n");
      }
    }
    if (pending && !isNoiseLine(pending)) process.stderr.write(pending);
  }

  private dispatchFrame(line: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch (err) {
      console.error("sidecar: malformed frame", line);
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) return;

    if (frame.type === "progress") {
      entry.onProgress?.(frame);
      return;
    }
    this.pending.delete(frame.id);
    if (frame.type === "error") {
      entry.reject(new Error((frame as ErrorFrame).error));
      return;
    }
    entry.resolve((frame as ResultFrame).result);
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}

function resolveSidecarCommand(opts: SidecarClientOptions): string[] {
  if (opts.command && opts.command.length > 0) return opts.command;

  const candidate =
    opts.binaryPath ?? join(opts.projectRoot, ".vgrep", "bin", "vgrep-core");
  if (existsSync(candidate)) return [candidate];

  // Global install: `scripts/install.sh` writes `~/.vgrep/install.json`
  // pointing at the sidecar binary + the pixi env it needs to run inside.
  // Lets the compiled `vgrep` CLI work from any cwd.
  const globalCmd = resolveGlobalInstall();
  if (globalCmd) return globalCmd;

  // Dev fallback: prefer a pre-built `dist/vgrep-core` from the repo,
  // running it through `pixi run` so it sees the libpython env. Falls
  // back to `mojo run` against the source if no binary exists yet.
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.projectRoot);
  if (repoRoot && existsSync(join(repoRoot, "packages/core-mojo/pixi.toml"))) {
    const pixi = resolvePixi();
    const manifest = join(repoRoot, "packages/core-mojo/pixi.toml");
    const builtBinary = join(
      repoRoot,
      "packages/core-mojo/dist/vgrep-core",
    );
    if (existsSync(builtBinary)) {
      return [pixi, "run", "--manifest-path", manifest, "--", builtBinary];
    }
    return [
      pixi,
      "run",
      "--manifest-path",
      manifest,
      "mojo",
      "run",
      join(repoRoot, "packages/core-mojo/src/main.mojo"),
    ];
  }
  throw new Error(
    `vgrep-core sidecar not found. Build with \`pixi run build\` inside packages/core-mojo, or place the binary at ${candidate}.`,
  );
}

function resolvePixi(): string {
  // `pixi` may not be on PATH when Bun spawns; prefer the absolute
  // path from the standard installer location.
  const home = process.env.HOME ?? "";
  const candidate = join(home, ".pixi", "bin", "pixi");
  return existsSync(candidate) ? candidate : "pixi";
}

interface InstallManifest {
  sidecarBinary?: string;
  pixi?: string;
  pixiManifest?: string;
}

function resolveGlobalInstall(): string[] | null {
  const installPath = join(homedir(), ".vgrep", "install.json");
  if (!existsSync(installPath)) return null;
  let data: InstallManifest;
  try {
    data = JSON.parse(readFileSync(installPath, "utf8")) as InstallManifest;
  } catch {
    return null;
  }
  const binary = data.sidecarBinary;
  if (!binary || !existsSync(binary)) return null;
  // The Mojo sidecar links libpython from the pixi env, so it must run
  // with `pixi run` even when the binary itself is global.
  if (data.pixi && data.pixiManifest && existsSync(data.pixi)) {
    return [data.pixi, "run", "--manifest-path", data.pixiManifest, "--", binary];
  }
  return [binary];
}

// HuggingFace + Python warmup chatter that's noise on every spawn. We let
// the model's actual download progress through (no match) and only filter
// the steady-state warmup lines.
const NOISE_PATTERNS: RegExp[] = [
  /You are sending unauthenticated requests/,
  /^Loading weights:/,
  /resource_tracker:/,
  /UserWarning: resource_tracker/,
  /^\s*warnings\.warn/,
  /Downloading shards:/,
  /Fetching \d+ files:/,
  /^TF_CPP_/,
];

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  for (const re of NOISE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages/core-mojo/pixi.toml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
