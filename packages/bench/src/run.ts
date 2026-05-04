#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { runAgent } from "./agent";
import { LocalSandbox } from "./sandbox";
import {
  PhaseTimer,
  formatDuration,
  recordsToJson,
  renderReport,
  type PhaseRecord,
} from "./timing";

type Scenario = {
  name: string;
  repo: string;
  revision?: string;
  query: string;
  expectations: {
    pathSubstring?: string;
    answerMustInclude?: string[];
  };
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SKILL_PATH = join(REPO_ROOT, "skills", "vgrep", "SKILL.md");
const VGREP_CLI = join(REPO_ROOT, "packages", "cli", "src", "cli.ts");
const VGREP_COMMAND = ["bun", VGREP_CLI];
const SCENARIOS_DIR = resolve(import.meta.dir, "scenarios");
const RESULTS_DIR = join(REPO_ROOT, "packages", "bench", "results");

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`usage: bun run packages/bench/src/run.ts <scenario-name|all>

scenarios live in packages/bench/src/scenarios/*.json
results land in packages/bench/results/<timestamp>/`);
    return;
  }

  if (!Bun.env.OPENAI_API_KEY) {
    console.error("error: OPENAI_API_KEY is not set");
    process.exit(1);
  }

  const skillMd = await Bun.file(SKILL_PATH).text();
  const target = args[0]!;
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
    console.log(`query: ${scenario.query}\n`);
    try {
      await runScenario(scenario, skillMd, runDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`scenario failed: ${msg}`);
    }
  }
}

async function runScenario(
  scenario: Scenario,
  skillMd: string,
  runDir: string,
): Promise<void> {
  const timer = new PhaseTimer();
  const sandbox = await LocalSandbox.create({ vgrepCommand: VGREP_COMMAND });

  try {
    await timer.time(
      "clone",
      async () => {
        const r = await sandbox.clone(scenario.repo, scenario.revision);
        if (r.exitCode !== 0) throw new Error(`git clone failed:\n${r.stderr}`);
      },
      {
        notes: `depth=1${scenario.revision ? `, ${scenario.revision}` : ""}`,
      },
    );

    let initStdout = "";
    await timer.time(
      "vgrep_init",
      async () => {
        const r = await sandbox.vgrepInit();
        initStdout = r.stdout;
        if (r.exitCode !== 0) {
          throw new Error(`vgrep init failed:\n${r.stderr}`);
        }
      },
      { children: parseInitSubphases(""), notes: summarizeInit("") },
    );
    const lastInit = timer.all().at(-1);
    if (lastInit) {
      lastInit.children = parseInitSubphases(initStdout);
      lastInit.notes = summarizeInit(initStdout);
    }

    const agentResult = await timer.time(
      "agent_total",
      () =>
        runAgent({
          sandbox,
          skillMd,
          query: scenario.query,
        }),
      { notes: "" },
    );

    const verdict = verifyAnswer(agentResult.answer, scenario);
    const lastAgent = timer.all().at(-1);
    if (lastAgent) {
      const tools = agentResult.toolCalls;
      const toolsNs = tools.reduce((acc, t) => acc + t.ns, 0n);
      lastAgent.notes = `${tools.length} tool calls, ${verdict.ok ? "verify ✓" : "verify ✗"}`;
      lastAgent.children = [
        { name: "ttft", ns: agentResult.ttftNs },
        { name: "tool_calls", ns: toolsNs, notes: summarizeTools(tools) },
      ];
    }

    const records = timer.all();
    console.log(renderReport(records));
    console.log(
      `\ntokens   in ${agentResult.inputTokens ?? "?"} / out ${agentResult.outputTokens ?? "?"}`,
    );
    console.log(`verify   ${verdict.ok ? "✓" : "✗"} ${verdict.reason}`);
    console.log(`total    ${formatDuration(timer.total())}`);
    console.log(`\n--- agent answer ---\n${agentResult.answer.trim()}`);

    const reportPath = join(runDir, `${scenario.name}.json`);
    await Bun.write(
      reportPath,
      JSON.stringify(
        {
          scenario,
          phases: recordsToJson(records),
          answer: agentResult.answer,
          toolCalls: agentResult.toolCalls.map((t) => ({
            cmd: t.cmd,
            args: t.args,
            exitCode: t.exitCode,
            ms: Number(t.ns / 1_000_000n),
          })),
          tokens: {
            input: agentResult.inputTokens,
            output: agentResult.outputTokens,
          },
          verify: verdict,
          totalMs: Number(timer.total() / 1_000_000n),
        },
        null,
        2,
      ),
    );
    console.log(`report   ${reportPath}`);
  } finally {
    await sandbox.destroy();
  }
}

function summarizeInit(stdout: string): string {
  const files = /(\d+)\s+files/.exec(stdout)?.[1];
  const indexed = /indexed\s+(\d+)\s+chunks/.exec(stdout)?.[1];
  if (files && indexed) return `${files} files, ${indexed} chunks`;
  if (files) return `${files} files`;
  return "";
}

function parseInitSubphases(stdout: string): PhaseRecord[] {
  const phases: PhaseRecord[] = [];
  for (const [label, key] of [
    ["chunk", "chunk"],
    ["embed", "embed"],
    ["upsert", "upsert"],
  ] as const) {
    const m = new RegExp(
      `^${key}\\s+(\\d+(?:\\.\\d+)?)(ms|s)`,
      "m",
    ).exec(stdout);
    if (!m) continue;
    const value = Number(m[1]);
    const unit = m[2];
    const ns = unit === "ms"
      ? BigInt(Math.round(value * 1_000_000))
      : BigInt(Math.round(value * 1_000_000_000));
    phases.push({ name: label, ns });
  }
  return phases;
}

function summarizeTools(tools: { cmd: string }[]): string {
  const counts = tools.reduce<Record<string, number>>((acc, t) => {
    acc[t.cmd] = (acc[t.cmd] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}

function verifyAnswer(
  answer: string,
  scenario: Scenario,
): { ok: boolean; reason: string } {
  const a = answer.toLowerCase();
  const ex = scenario.expectations;
  if (ex.pathSubstring && !a.includes(ex.pathSubstring.toLowerCase())) {
    return { ok: false, reason: `missing path "${ex.pathSubstring}"` };
  }
  if (ex.answerMustInclude) {
    for (const term of ex.answerMustInclude) {
      if (!a.includes(term.toLowerCase())) {
        return { ok: false, reason: `missing term "${term}"` };
      }
    }
  }
  return { ok: true, reason: "matched expectations" };
}

async function loadScenarios(target: string): Promise<Scenario[]> {
  if (target === "all") {
    const glob = new Bun.Glob("*.json");
    const out: Scenario[] = [];
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

await main();
