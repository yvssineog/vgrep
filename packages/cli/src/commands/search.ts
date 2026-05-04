import { join, resolve } from "node:path";
import { LocalEngine } from "@vgrep/core";
import { c, clearStatus, header, status } from "../style";
import { FILES, isInitialized, vgrepDir } from "../config";

const DEFAULT_TOP_K = 3;

export async function searchCommand(
  query: string | string[],
  options: { path?: string; topK?: string },
): Promise<void> {
  const queryText = Array.isArray(query) ? query.join(" ") : query;
  const projectRoot = resolve(options.path ?? process.cwd());
  const topK = parseTopK(options.topK);

  console.log(header("search", `"${queryText}"`));

  if (!isInitialized(projectRoot)) {
    console.log(`${c.red("not initialized")} ${c.dim('— run "vgrep init"')}`);
    process.exit(1);
  }

  const engine = new LocalEngine({
    dbPath: join(vgrepDir(projectRoot), FILES.index),
    cacheDir: join(vgrepDir(projectRoot), FILES.cache),
  });

  status("searching...");

  try {
    const results = await engine.search(queryText, topK);
    clearStatus();

    if (results.length === 0) {
      console.log(c.dim("no results"));
      return;
    }

    for (const [i, result] of results.entries()) {
      if (i > 0) console.log();
      const location = `${c.cyan(result.filePath)}${c.dim(`:${result.startLine}-${result.endLine}`)}`;
      const score = c.dim(result.score.toFixed(3));
      console.log(`${location} ${score}`);
      console.log(formatChunk(result.content, result.startLine));
    }
  } catch (error) {
    clearStatus();
    const message = error instanceof Error ? error.message : String(error);
    console.log(`${c.red("search failed")} ${c.dim(message)}`);
    process.exit(1);
  }
}

function parseTopK(value?: string): number {
  if (!value) return DEFAULT_TOP_K;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--top-k must be a positive integer");
  }

  return parsed;
}

const MAX_LINES = 8;
const MAX_LINE_LENGTH = 200;

function formatChunk(content: string, startLine: number): string {
  const lines = content.replace(/\n+$/, "").split("\n");
  const shown = lines.slice(0, MAX_LINES);
  const lastLineNo = startLine + shown.length - 1;
  const width = String(lastLineNo).length;

  const formatted = shown.map((line, i) => {
    const lno = String(startLine + i).padStart(width);
    const text =
      line.length > MAX_LINE_LENGTH
        ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…`
        : line;
    return `${c.dim(`${lno} │`)} ${text}`;
  });

  if (lines.length > MAX_LINES) {
    const pad = " ".repeat(width);
    formatted.push(
      `${c.dim(`${pad} │`)} ${c.dim(`… ${lines.length - MAX_LINES} more`)}`,
    );
  }

  return formatted.join("\n");
}
