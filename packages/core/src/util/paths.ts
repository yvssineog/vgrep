import * as path from "node:path";

/**
 * Path utilities — POSIX-style internally so paths round-trip identically
 * across platforms inside merkle trees, ignore rules, and on-disk JSON.
 *
 * All "relative" paths in vgrep are POSIX (`a/b/c`), with a leading `./`
 * stripped. All "system" paths are joined via `node:path` so they survive
 * Windows backslashes when interfacing with the filesystem.
 */

/** Normalize to a POSIX relative path (`a/b/c`), stripping a leading `./`. */
export function toRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Normalize a system path (POSIX slashes, no trailing `/`). */
export function toSystem(p: string): string {
  return toRelative(p).replace(/\/+$/, "");
}

/** Join a system base with a relative segment, both normalized. */
export function joinSystem(base: string, rel: string): string {
  const b = toSystem(base);
  const r = toRelative(rel);
  if (!r || r === ".") return b;
  return `${b}/${r}`;
}

/** True for absolute POSIX paths (`/foo`) or Windows drive letters (`C:/foo`). */
export function isAbsolute(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

/** Path of `target` relative to `root` (case-insensitive prefix), or `target` if outside. */
export function relativeFrom(root: string, target: string): string {
  const r = toSystem(root).toLowerCase();
  const t = toSystem(target);
  const lower = t.toLowerCase();
  if (lower === r) return ".";
  if (lower.startsWith(`${r}/`)) return t.slice(r.length + 1);
  return t;
}

/** Last segment of a POSIX path. */
export function basename(p: string): string {
  return path.posix.basename(toRelative(p));
}

/** Resolve a candidate (absolute or relative) into a POSIX relative path, or `null` if outside the root. */
export function resolveCandidate(root: string, candidate: string): string | null {
  const rel = isAbsolute(candidate) ? relativeFrom(root, candidate) : candidate;
  const n = toRelative(rel);
  if (!n || n === "." || n.startsWith("../") || n === "..") return null;
  return n;
}
