import { parse } from "yaml";

const FENCE = /^---[ \t]*\r?$/;

/**
 * Splits YAML frontmatter off a file: at byte 0, opened by a `---` line, closed by the next `---` line, and holding a
 * YAML mapping. Anything else is a rule and text, and the whole file is the body. `frontmatter` keeps every byte
 * through the closing line's newline, so `frontmatter + body` is the file.
 */
export function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  const none = { frontmatter: "", body: src };
  const first = src.indexOf("\n");
  if (first === -1 || !FENCE.test(src.slice(0, first))) return none;
  let at = first + 1;
  while (at < src.length) {
    const nl = src.indexOf("\n", at);
    const end = nl === -1 ? src.length : nl;
    if (FENCE.test(src.slice(at, end))) {
      const stop = nl === -1 ? src.length : nl + 1;
      try {
        const value: unknown = parse(src.slice(first + 1, at));
        if (!value || typeof value !== "object" || Array.isArray(value)) return none;
      } catch { return none; }
      return { frontmatter: src.slice(0, stop), body: src.slice(stop) };
    }
    if (nl === -1) break;
    at = nl + 1;
  }
  return none;
}
