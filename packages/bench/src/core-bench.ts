#!/usr/bin/env bun
/**
 * Sidecar microbench: drive the Mojo `vgrep-core` sidecar directly,
 * skipping the agent loop. Measures the cost of each phase that the
 * CLI/watch daemon would normally pay:
 *
 *   spawn   → process up + first stderr fully drained
 *   open    → model + SQLite + ignore rules ready
 *   tree    → walk + merkle build (sees `previous=null`, so this also
 *             becomes the initial diff)
 *   index   → chunk + embed + upsert for every file
 *   search  → 5 queries (1 warmup, 4 timed); report p50/p90/mean
 *
 * Run:    bun run packages/bench/src/core-bench.ts <scenario|all>
 * Output: console phase report + JSON dump under
 *         `packages/bench/results/<timestamp>/<scenario>.core.json`
 *
 * No OPENAI_API_KEY required — this bench never touches the network or LLM.
 */
import { mkdir, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  DEFAULT_FILE_PROFILES,
  resolveProfileFilters,
  SidecarClient,
  readIgnoreText,
  type ProgressFrame,
  type SearchResult,
} from "@vgrep/core";
import {
  PhaseTimer,
  formatDuration,
  recordsToJson,
  renderReport,
} from "./timing";

type Scenario = {
  name: string;
  repo: string;
  revision?: string;
  query: string;
  expectations?: {
    pathSubstring?: string;
    answerMustInclude?: string[];
  };
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SCENARIOS_DIR = resolve(import.meta.dir, "scenarios");
const RESULTS_DIR = join(REPO_ROOT, "packages", "bench", "results");
const CORE_MOJO_DIR = join(REPO_ROOT, "packages", "core-mojo");
const SIDECAR_BINARY = join(CORE_MOJO_DIR, "dist", "vgrep-core");
// The binary links libpython from the pixi env — we have to launch it
// through `pixi run` so PYTHONHOME / sentence_transformers / sqlite3 etc.
// resolve. Direct invocation fails with "No module named 'sentence_transformers'".
const PIXI = resolvePixi();
const SIDECAR_COMMAND = [
  PIXI,
  "run",
  "--manifest-path",
  join(CORE_MOJO_DIR, "pixi.toml"),
  "--",
  SIDECAR_BINARY,
];

function resolvePixi(): string {
  // Pixi installs to ~/.pixi/bin, which Bun's spawn won't see unless the
  // user has it on PATH. Prefer the absolute path when it exists.
  const home = Bun.env.HOME ?? process.env.HOME ?? "";
  const candidate = join(home, ".pixi", "bin", "pixi");
  return existsSync(candidate) ? candidate : "pixi";
}
const SEARCH_RUNS = 5; // 1 warmup + 4 timed

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`usage: bun run packages/bench/src/core-bench.ts <scenario|all> [--top-k N] [--keep]

scenarios live in packages/bench/src/scenarios/*.json
results land in packages/bench/results/<timestamp>/<scenario>.core.json

flags
  --top-k N    number of search hits per query  (default 5)
  --keep       leave the cloned repo + .vgrep dir on disk for inspection`);
    return;
  }

  const target = args[0]!;
  const topK = Number(flagValue(args, "--top-k") ?? 5);
  const keep = args.includes("--keep");

  if (!existsSync(SIDECAR_BINARY)) {
    console.error(
      `error: sidecar binary not found at ${SIDECAR_BINARY}\n` +
        `       build it first: (cd packages/core-mojo && pixi run build)`,
    );
    process.exit(1);
  }

  const scenarios = await loadScenarios(target);
  if (scenarios.length === 0) {
    console.error(`error: no scenario matched "${target}"`);
    process.exit(1);
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RESULTS_DIR, runStamp);
  await mkdir(runDir, { recursive: true });

  for (const scenario of scenarios) {
    console.log(`\n━━━ ${scenario.name} ━━━`);
    console.log(`repo:  ${scenario.repo}${scenario.revision ? `@${scenario.revision}` : ""}`);
    console.log(`query: ${scenario.query}`);
    console.log();
    try {
      await runScenario(scenario, runDir, { topK, keep });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`scenario failed: ${msg}`);
    }
  }
}

async function runScenario(
  scenario: Scenario,
  runDir: string,
  opts: { topK: number; keep: boolean },
): Promise<void> {
  const timer = new PhaseTimer();
  const sandbox = await mkdtemp(join(tmpdir(), "vgrep-corebench-"));
  // Holder so TS can see assignments inside the spawn closure.
  const ref: { sidecar: SidecarClient | null } = { sidecar: null };

  try {
    // ── clone ──────────────────────────────────────────────────────
    await timer.time(
      "clone",
      async () => {
        const args = ["clone", "--depth", "1"];
        if (scenario.revision) args.push("--branch", scenario.revision);
        args.push(scenario.repo, ".");
        const proc = Bun.spawn(["git", ...args], {
          cwd: sandbox,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stderr, code] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`git clone failed:\n${stderr}`);
      },
      { notes: `depth=1${scenario.revision ? `, ${scenario.revision}` : ""}` },
    );

    // ── scaffold ──────────────────────────────────────────────────
    await mkdir(join(sandbox, ".vgrep", "cache"), { recursive: true });

    // ── spawn ─────────────────────────────────────────────────────
    await timer.time(
      "spawn",
      async () => {
        const s = new SidecarClient({
          projectRoot: sandbox,
          repoRoot: REPO_ROOT,
          command: SIDECAR_COMMAND,
        });
        await s.start();
        // Round-trip a health frame so we know the model is loaded
        // and the dispatch loop is live before any timed work runs.
        await s.health();
        ref.sidecar = s;
      },
      { notes: "model loaded, stdio drained" },
    );

    // ── open ─────────────────────────────────────────────────────
    const ignoreText = await readIgnoreText(sandbox);
    const { extensions, filenames } = resolveProfileFilters(
      ["code"],
      DEFAULT_FILE_PROFILES,
    );
    await timer.time(
      "open",
      async () => {
        await ref.sidecar!.open({
          projectRoot: sandbox,
          dbPath: join(sandbox, ".vgrep", "index.db"),
          cacheDir: join(sandbox, ".vgrep", "cache"),
          extensions,
          filenames,
          ignoreText,
        });
      },
      { notes: `profiles=code, ignore=${ignoreText.length}B` },
    );

    // ── tree ─────────────────────────────────────────────────────
    let fileCount = 0;
    let totalBytes = 0;
    const update = await timer.time(
      "tree",
      () => ref.sidecar!.updateTree({ previous: null }),
    );
    fileCount = countFiles(update.tree);
    totalBytes = totalSize(update.tree);
    const lastTree = timer.all().at(-1);
    if (lastTree) lastTree.notes = `${fileCount} files, ${formatBytes(totalBytes)}`;

    // ── index (chunk + embed + upsert) ───────────────────────────
    const progress = { chunk: 0, embed: 0, chunkTotal: 0, embedTotal: 0 };
    const stats = await timer.time(
      "index",
      () =>
        ref.sidecar!.applyDiff(
          { changes: update.changes },
          (frame: ProgressFrame) => {
            progress[frame.stage] = frame.done;
            const totalKey = `${frame.stage}Total` as const;
            progress[totalKey] = frame.total;
            // Inline status line so we can see the embed progress
            // tick by without spamming the report.
            const tag = `${frame.stage} ${frame.done}/${frame.total}`;
            process.stdout.write(`\r  ${tag.padEnd(40)}`);
          },
        ),
    );
    process.stdout.write("\r" + " ".repeat(48) + "\r");
    const lastIndex = timer.all().at(-1);
    if (lastIndex) {
      lastIndex.notes = `${stats.indexedChunks} chunks, ${stats.failedFiles} failed`;
    }

    // ── search ───────────────────────────────────────────────────
    // Warmup — first call materializes the query embedding pipeline
    // and any lazy SIMD codegen. We measure runs 2..N.
    let lastResults: SearchResult[] = [];
    const searchNs: bigint[] = [];
    for (let i = 0; i < SEARCH_RUNS; i++) {
      const start = Bun.nanoseconds();
      const r = await ref.sidecar!.search({ query: scenario.query, topK: opts.topK });
      const ns = BigInt(Bun.nanoseconds() - start);
      if (i > 0) searchNs.push(ns);
      lastResults = r.results;
    }
    const searchSummary = summarizeSearch(searchNs);
    timer.attach(
      "search",
      meanNs(searchNs),
      `mean of ${searchNs.length} runs (1 warmup discarded)`,
      [
        { name: "p50", ns: percentile(searchNs, 0.5) },
        { name: "p90", ns: percentile(searchNs, 0.9) },
        { name: "max", ns: searchNs.reduce((a, b) => (b > a ? b : a), 0n) },
      ],
    );

    // ── report ───────────────────────────────────────────────────
    const records = timer.all();
    console.log(renderReport(records));
    console.log();
    console.log(`hits     ${lastResults.length}`);
    if (lastResults[0]) {
      const top = lastResults[0];
      console.log(
        `top      ${top.filePath}:${top.startLine}  score=${top.score.toFixed(3)}`,
      );
    }
    if (scenario.expectations?.pathSubstring) {
      const needle = scenario.expectations.pathSubstring.toLowerCase();
      const ok = lastResults.some((r) =>
        r.filePath.toLowerCase().includes(needle),
      );
      console.log(`verify   ${ok ? "✓" : "✗"} pathSubstring="${needle}"`);
    }
    console.log(`total    ${formatDuration(timer.total())}`);

    // ── persist ──────────────────────────────────────────────────
    const reportPath = join(runDir, `${scenario.name}.core.json`);
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          scenario,
          phases: recordsToJson(records),
          tree: { files: fileCount, bytes: totalBytes },
          index: stats,
          search: {
            topK: opts.topK,
            runs: SEARCH_RUNS,
            warmupDiscarded: 1,
            ...searchSummary,
            results: lastResults,
          },
          totalMs: Number(timer.total() / 1_000_000n),
        },
        null,
        2,
      ),
    );
    console.log(`report   ${reportPath}`);
  } finally {
    if (ref.sidecar) await ref.sidecar.close().catch(() => undefined);
    if (!opts.keep) {
      await rm(sandbox, { recursive: true, force: true });
    } else {
      console.log(`keep     ${sandbox}`);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

async function loadScenarios(target: string): Promise<Scenario[]> {
  if (target === "all") {
    const out: Scenario[] = [];
    const glob = new Bun.Glob("*.json");
    for await (const file of glob.scan({ cwd: SCENARIOS_DIR })) {
      out.push(await readScenario(join(SCENARIOS_DIR, file)));
    }
    return out;
  }
  const path = join(SCENARIOS_DIR, target.endsWith(".json") ? target : `${target}.json`);
  if (!existsSync(path)) return [];
  return [await readScenario(path)];
}

async function readScenario(path: string): Promise<Scenario> {
  return Bun.file(path).json() as Promise<Scenario>;
}

function countFiles(node: { type: string; children?: unknown[] }): number {
  if (node.type === "file") return 1;
  return ((node.children as { type: string; children?: unknown[] }[]) ?? [])
    .reduce((s, c) => s + countFiles(c), 0);
}

function totalSize(node: {
  type: string;
  size?: number;
  children?: unknown[];
}): number {
  if (node.type === "file") return node.size ?? 0;
  return ((node.children as Parameters<typeof totalSize>[0][]) ?? []).reduce(
    (s, c) => s + totalSize(c),
    0,
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function meanNs(xs: bigint[]): bigint {
  if (xs.length === 0) return 0n;
  return xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length);
}

function percentile(xs: bigint[], p: number): bigint {
  if (xs.length === 0) return 0n;
  const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

function summarizeSearch(xs: bigint[]): {
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
} {
  const toMs = (n: bigint): number => Number(n) / 1_000_000;
  return {
    meanMs: toMs(meanNs(xs)),
    p50Ms: toMs(percentile(xs, 0.5)),
    p90Ms: toMs(percentile(xs, 0.9)),
    maxMs: toMs(xs.reduce((a, b) => (b > a ? b : a), 0n)),
  };
}

await main();
