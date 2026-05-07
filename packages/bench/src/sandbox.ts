import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ALLOWED_COMMANDS = [
  "vgrep",
  "cat",
  "head",
  "tail",
  "ls",
  "rg",
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

export type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  ns: bigint;
  truncated: boolean;
};

export type SandboxOptions = {
  vgrepCommand: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
};

export class LocalSandbox {
  readonly dir: string;
  private readonly vgrepCommand: string[];
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;

  private constructor(dir: string, opts: SandboxOptions) {
    this.dir = dir;
    if (opts.vgrepCommand.length === 0) {
      throw new Error("vgrepCommand must have at least one entry");
    }
    this.vgrepCommand = opts.vgrepCommand;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxStdoutBytes = opts.maxStdoutBytes ?? 1_000_000;
  }

  static async create(opts: SandboxOptions): Promise<LocalSandbox> {
    const dir = await mkdtemp(join(tmpdir(), "vgrep-bench-"));
    return new LocalSandbox(dir, opts);
  }

  async clone(repoUrl: string, revision?: string): Promise<RunResult> {
    const args = ["clone", "--depth", "1"];
    if (revision) args.push("--branch", revision);
    args.push(repoUrl, ".");
    return this.spawn(["git", ...args], { cwd: this.dir, timeoutMs: 600_000 });
  }

  async vgrepInit(): Promise<RunResult> {
    return this.run("vgrep", ["init", "--force"], {
      timeoutMs: 600_000,
    });
  }

  /**
   * Start the watch daemon in the sandbox and block until it's serving the
   * `/health` endpoint — i.e. the embedding model is loaded and the SQLite
   * handle is open. Subsequent `vgrep search` calls hit a hot process.
   */
  async vgrepWatchStart(): Promise<RunResult> {
    return this.run("vgrep", ["watch", "--start"], { timeoutMs: 60_000 });
  }

  async vgrepWatchStop(): Promise<RunResult> {
    return this.run("vgrep", ["watch", "--stop"], { timeoutMs: 10_000 });
  }

  async run(
    cmd: AllowedCommand,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<RunResult> {
    if (!ALLOWED_COMMANDS.includes(cmd)) {
      throw new Error(`Command not allowed: ${cmd}`);
    }
    this.assertSafeArgs(args);
    const argv =
      cmd === "vgrep" ? [...this.vgrepCommand, ...args] : [cmd, ...args];
    return this.spawn(argv, {
      cwd: this.dir,
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
    });
  }

  private assertSafeArgs(args: string[]): void {
    for (const arg of args) {
      if (typeof arg !== "string") throw new Error("argument must be a string");
      if (arg.includes("\0")) throw new Error("null byte in argument");
      if (arg.startsWith("/")) {
        if (!resolve(arg).startsWith(this.dir)) {
          throw new Error(`absolute path escapes sandbox: ${arg}`);
        }
      }
      if (arg.includes("..")) {
        const resolved = resolve(this.dir, arg);
        if (!resolved.startsWith(this.dir)) {
          throw new Error(`relative path escapes sandbox: ${arg}`);
        }
      }
    }
  }

  private async spawn(
    argv: string[],
    opts: { cwd: string; timeoutMs: number },
  ): Promise<RunResult> {
    const start = Bun.nanoseconds();
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);

    const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const ns = BigInt(Bun.nanoseconds() - start);
    const truncated = stdoutRaw.length > this.maxStdoutBytes;
    const stdout = truncated
      ? stdoutRaw.slice(0, this.maxStdoutBytes) + "\n... [truncated]"
      : stdoutRaw;

    return { exitCode, stdout, stderr: stderrRaw, ns, truncated };
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
