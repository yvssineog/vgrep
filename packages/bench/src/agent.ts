import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { LocalSandbox, AllowedCommand, RunResult } from "./sandbox";

const SHELL_INPUT = z.object({
  cmd: z.enum(["vgrep", "cat", "head", "tail", "ls", "rg"]),
  args: z.array(z.string()).max(20).default([]),
});

export type ToolCallRecord = {
  cmd: AllowedCommand;
  args: string[];
  exitCode: number;
  ns: bigint;
  truncated: boolean;
};

export type AgentResult = {
  answer: string;
  toolCalls: ToolCallRecord[];
  ttftNs: bigint;
  totalNs: bigint;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
};

const TASK_PROMPT = `You are a code-investigation agent. Use the shell tool with the vgrep CLI (and read-only utilities cat/head/tail/ls/rg) to find the answer.

Workflow:
1. Run \`vgrep status\` to confirm the index is ready.
2. Use \`vgrep search "<intent>" -k 5\` for semantic queries — try multiple short phrasings.
3. Use \`cat\`/\`head\`/\`tail\` to expand context around hits.
4. When confident, return a concise answer naming the exact file path(s) and line range(s) that resolve the question.

Constraints:
- Each tool call has a 30s timeout and 1MB stdout cap.
- Read-only commands only.
- Stop after at most 15 tool calls.

Final answer format:
\`\`\`
<file>:<startLine>-<endLine>
<one-paragraph explanation>
\`\`\``;

export async function runAgent(opts: {
  sandbox: LocalSandbox;
  skillMd: string;
  query: string;
  maxSteps?: number;
}): Promise<AgentResult> {
  const toolCalls: ToolCallRecord[] = [];
  let firstChunkAt: number | null = null;
  const startedAt = Bun.nanoseconds();

  const shell = tool({
    description:
      "Run an allowlisted read-only shell command in the repo. Allowed: vgrep, cat, head, tail, ls, rg.",
    inputSchema: SHELL_INPUT,
    execute: async ({ cmd, args }) => {
      const result: RunResult = await opts.sandbox.run(cmd, args);
      toolCalls.push({
        cmd,
        args,
        exitCode: result.exitCode,
        ns: result.ns,
        truncated: result.truncated,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr.slice(0, 4_000),
        truncated: result.truncated,
      };
    },
  });

  const result = await generateText({
    model: openai("gpt-5-mini"),
    system: `${TASK_PROMPT}\n\n--- vgrep skill ---\n${opts.skillMd}`,
    prompt: opts.query,
    tools: { shell },
    stopWhen: stepCountIs(opts.maxSteps ?? 15),
    onStepFinish: () => {
      if (firstChunkAt === null) firstChunkAt = Bun.nanoseconds();
    },
  });

  const totalNs = BigInt(Bun.nanoseconds() - startedAt);
  const ttftNs = BigInt(
    (firstChunkAt ?? Bun.nanoseconds()) - startedAt,
  );

  return {
    answer: result.text,
    toolCalls,
    ttftNs,
    totalNs,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  };
}
