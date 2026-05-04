import { join } from "node:path";
import { Effect } from "effect";
import { basename, toRelative } from "./util/paths";

/**
 * `.vgrepignore` parsing and matching.
 *
 * Two buckets to keep matching cheap:
 *   - exactNames  : plain names like `node_modules`, `.env`. Match a path
 *                   if any path segment equals one of these names.
 *   - globPatterns: anything containing glob metacharacters; matched via
 *                   `Bun.Glob` against either the basename or the full path.
 */
export interface IgnoreRules {
  exactNames: Set<string>;
  globPatterns: Bun.Glob[];
}

const VGREPIGNORE_FILE = ".vgrepignore";
const HAS_GLOB_META = /[*?{}\[\]]/;

/** Empty rule set. */
export const emptyIgnore = (): IgnoreRules => ({
  exactNames: new Set(),
  globPatterns: [],
});

/** Parse `.vgrepignore`-style lines (ignores comments + blank lines). */
export function parseIgnore(patterns: Iterable<string>): IgnoreRules {
  const rules = emptyIgnore();
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.endsWith("/") ? line.slice(0, -1) : line;
    if (HAS_GLOB_META.test(pattern)) {
      rules.globPatterns.push(new Bun.Glob(pattern));
    } else {
      rules.exactNames.add(toRelative(pattern));
    }
  }
  return rules;
}

/** Merge `src` into `target` in place. */
export function mergeIgnore(target: IgnoreRules, src: IgnoreRules): void {
  for (const n of src.exactNames) target.exactNames.add(n);
  target.globPatterns.push(...src.globPatterns);
}

/** Read `<rootDir>/.vgrepignore` if present; otherwise return empty rules. */
export const loadIgnore = (rootDir: string): Effect.Effect<IgnoreRules, Error> =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(join(rootDir, VGREPIGNORE_FILE));
      if (!(await file.exists())) return emptyIgnore();
      return parseIgnore((await file.text()).split("\n"));
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });

/** Match a relative path against a rule set. */
export function matchesIgnore(rules: IgnoreRules, relativePath: string): boolean {
  const normalized = toRelative(relativePath);
  const name = basename(normalized);
  if (
    rules.exactNames.has(name) ||
    rules.exactNames.has(normalized) ||
    normalized.split("/").some((s) => rules.exactNames.has(s))
  ) {
    return true;
  }
  for (const g of rules.globPatterns) {
    if (g.match(name) || g.match(normalized)) return true;
  }
  return false;
}
