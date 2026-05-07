import { join } from "node:path";
import type { SearchResult } from "@vgrep/core";
import { FILES, vgrepDir } from "../config";

/**
 * Shared protocol between `vgrep search` (client) and the long-running
 * `vgrep watch` daemon.
 *
 * IPC is a Unix domain socket living inside `.vgrep/`. The wire format is
 * plain HTTP/JSON over the UDS — Bun's `fetch` and `Bun.serve` both speak
 * unix transports, so we don't ship a hand-rolled framing layer.
 */

export const PROTOCOL_VERSION = 1;

/** Time the client will wait for a freshly spawned daemon to start serving. */
export const SPAWN_TIMEOUT_MS = 30_000;

export interface SearchRequest {
  query: string;
  topK: number;
}

export interface SearchOk {
  ok: true;
  results: SearchResult[];
}

export interface SearchErr {
  ok: false;
  error: string;
}

export type SearchResponse = SearchOk | SearchErr;

export interface DaemonPaths {
  sock: string;
  pid: string;
  log: string;
}

export const daemonPaths = (projectRoot: string): DaemonPaths => {
  const dir = vgrepDir(projectRoot);
  return {
    sock: join(dir, FILES.daemonSock),
    pid: join(dir, FILES.daemonPid),
    log: join(dir, FILES.daemonLog),
  };
};
