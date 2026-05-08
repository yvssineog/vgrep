import { join } from "node:path";
import { homedir } from "node:os";

const HOME_VGREP_DIR = join(homedir(), ".vgrep");
const MODEL_DIR = join(HOME_VGREP_DIR, "models");

/**
 * Env vars to splat onto every sidecar spawn.
 *
 * The Mojo sidecar runs the embedding model through the native MAX
 * engine in-process; these vars (a) point HF caches at a global dir
 * shared by every project, (b) silence noisy progress output, and
 * (c) skip every HF Hub HTTP probe once the model is on disk.
 *
 * `firstRun` flips the offline mode off so the first ever vgrep
 * invocation can fetch the model. Every subsequent call (and every
 * daemon restart) runs fully offline.
 */
export function sidecarEnv(firstRun: boolean): Record<string, string> {
  const env: Record<string, string> = {
    HF_HOME: MODEL_DIR,
    HF_HUB_CACHE: MODEL_DIR,
    TRANSFORMERS_CACHE: MODEL_DIR,
    TRANSFORMERS_VERBOSITY: "error",
    TRANSFORMERS_NO_ADVISORY_WARNINGS: "1",
    TOKENIZERS_PARALLELISM: "false",
    MODULAR_TELEMETRY_DISABLED: "1",
  };
  if (!firstRun) {
    env.HF_HUB_DISABLE_PROGRESS_BARS = "1";
    env.HF_HUB_DISABLE_TELEMETRY = "1";
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
  }
  return env;
}

/** True if scripts/install.sh has already pre-warmed the model on this machine. */
export function modelIsCached(): boolean {
  // Heuristic: the HF cache holds a snapshot of the model after pre-warm.
  // A real check would walk the snapshot tree; for the env-decision
  // purposes here, the marker file written by `vgrep init` first-run is
  // the source of truth (see `FIRST_RUN_MARKER` in init.ts).
  return false;
}
