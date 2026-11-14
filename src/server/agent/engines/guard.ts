import { isAbsolute, relative, resolve } from "node:path";

/** Whether `path` (relative to `cwd`, or absolute) is `dir` or inside it. Used by both engines' write guards. */
export function insideDir(dir: string, cwd: string, path: string): boolean {
  if (!path) return false;
  const rel = relative(resolve(dir), resolve(cwd, path.replace(/^@/, "")));
  return !rel.startsWith("..") && !isAbsolute(rel);
}
