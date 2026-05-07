import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { SearchResult } from "@vgrep/core";
import { paths as p } from "@vgrep/core";
import {
  daemonPaths,
  SPAWN_TIMEOUT_MS,
  type SearchRequest,
  type SearchResponse,
} from "./protocol";

const HEALTH_POLL_MS = 50;

/**
 * Send a search query to the project's daemon, auto-spawning it if it isn't
 * running. Returns the result list, or throws on connection / server error.
 */
export async function searchViaDaemon(
  projectRoot: string,
  request: SearchRequest,
  options: { onSpawn?: () => void } = {},
): Promise<SearchResult[]> {
  await ensureDaemon(projectRoot, options);
  return sendSearch(projectRoot, request);
}

/**
 * Block until a daemon is reachable for `projectRoot` — connect to an
 * existing one, or spawn a fresh detached process.
 */
export async function ensureDaemon(
  projectRoot: string,
  options: { onSpawn?: () => void } = {},
): Promise<void> {
  const sock = daemonPaths(projectRoot).sock;

  if (await ping(sock)) return;

  // Either no daemon, or a stale socket. Clear the socket so the new
  // process can bind, then spawn detached.
  await safeUnlink(sock);
  options.onSpawn?.();
  spawnDaemon(projectRoot);

  await waitForReady(sock, SPAWN_TIMEOUT_MS);
}

async function sendSearch(
  projectRoot: string,
  request: SearchRequest,
): Promise<SearchResult[]> {
  const sock = daemonPaths(projectRoot).sock;
  const res = await unixFetch(sock, "/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload = (await res.json()) as SearchResponse;
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.results;
}

async function ping(sock: string): Promise<boolean> {
  if (!existsSync(sock)) return false;
  try {
    const res = await unixFetch(sock, "/health");
    return res.ok;
  } catch {
    return false;
  }
}

function unixFetch(
  sock: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://daemon${path}`, { ...init, unix: sock } as RequestInit);
}

function spawnDaemon(projectRoot: string): void {
  const cmd = buildDaemonCommand(projectRoot);
  const proc = Bun.spawn(cmd, {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  proc.unref();
}

function buildDaemonCommand(projectRoot: string): string[] {
  const cliSourcePath = p.joinSystem(import.meta.dir, "../cli.ts");
  const bunExecutable = Bun.argv[0] ?? "bun";
  if (import.meta.path.endsWith(".ts")) {
    return [bunExecutable, cliSourcePath, "watch", "--daemon", "--path", projectRoot];
  }
  return [bunExecutable, "watch", "--daemon", "--path", projectRoot];
}

async function waitForReady(sock: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping(sock)) return;
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`daemon did not start within ${timeoutMs}ms`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
}
