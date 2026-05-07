import { resolve } from "node:path";
import { c, clearStatus, header, status } from "../style";
import { isInitialized } from "../config";
import { searchViaDaemon } from "../daemon/client";

const DEFAULT_TOP_K = 3;

/**
 * `vgrep search` — semantic kNN search over the local index.
 *
 * Search always goes through the watch daemon's Unix socket: the daemon
 * already holds a hot model + SQLite handle, so the round-trip is dominated
 * by the embedding of the query itself rather than process startup. If no
 * daemon is running, we auto-spawn `vgrep watch --daemon` and wait for it
 * to come up before issuing the request.
 */
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

  status("searching...");
  let results;
  try {
    results = await searchViaDaemon(
      projectRoot,
      { query: queryText, topK },
      { onSpawn: () => status("starting daemon...") },
    );
  } catch (err) {
    clearStatus();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`${c.red("search failed")} ${c.dim(msg)}`);
    process.exit(1);
  }
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
