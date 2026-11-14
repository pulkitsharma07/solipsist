import { lexPieces, parseMarkdown, serializeMarkdown, type Piece } from "./dialect";

/** A body in the form the app writes it, ignoring how it was typed. */
export const canonical = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

const DEFINITION = /^\s*\[[^\]]+\]:/;

/** Which `next` piece (by index) keeps which `old` piece: the longest common run of keys, in order. */
function align(oldAt: number[], nextAt: number[], old: Piece[], next: Piece[]): Map<number, number> {
  const best = Array.from({ length: oldAt.length + 1 }, () => new Array<number>(nextAt.length + 1).fill(0));
  for (let i = oldAt.length - 1; i >= 0; i--) {
    for (let j = nextAt.length - 1; j >= 0; j--) {
      best[i]![j] = old[oldAt[i]!]!.key === next[nextAt[j]!]!.key ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
    }
  }
  const pairs = new Map<number, number>();
  for (let i = 0, j = 0; i < oldAt.length && j < nextAt.length;) {
    if (old[oldAt[i]!]!.key === next[nextAt[j]!]!.key) pairs.set(nextAt[j++]!, oldAt[i++]!);
    else if (best[i + 1]![j]! >= best[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

function splice(snapshot: string, body: string, splitLists: boolean): string {
  const old = lexPieces(snapshot, splitLists);
  const next = lexPieces(body, splitLists);
  const keyed = (ps: Piece[]) => ps.flatMap((p, i) => (p.key === null ? [] : [i]));
  const [oldAt, nextAt] = [keyed(old), keyed(next)];
  const pairs = align(oldAt, nextAt, old, next);
  const kept = new Set<number>();
  let out = "";
  let prevNext = -1;
  let prevOld = -1;
  for (const n of nextAt) {
    const o = pairs.get(n);
    if (prevNext < 0) {
      // Whatever came before the first piece (the blank line after frontmatter) stays if that piece did.
      if (o !== undefined && o === oldAt[0]) for (let k = 0; k < o; k++) { out += old[k]!.text; kept.add(k); }
    } else if (o !== undefined && prevOld >= 0 && oldAt.indexOf(o) === oldAt.indexOf(prevOld) + 1) {
      for (let k = prevOld + 1; k < o; k++) { out += old[k]!.text; kept.add(k); }
    } else {
      for (let k = prevNext + 1; k < n; k++) out += next[k]!.text;
    }
    out += o !== undefined ? old[o]!.text : next[n]!.text;
    prevNext = n;
    prevOld = o ?? -1;
  }
  // Definitions whose neighbours went are kept, at the end, or a link that uses one would stop being a link.
  const left = old.filter((p, k) => p.key === null && !kept.has(k) && DEFINITION.test(p.text)).map((p) => p.text.trim());
  if (left.length) out = `${out.replace(/\n+$/, "")}\n\n${left.join("\n")}`;
  return out.replace(/\n+$/, "") + snapshot.match(/\n*$/)![0];
}

/**
 * The text to write for `body`, an edit of `snapshot`: what the writer didn't change stays exactly as it was in
 * `snapshot`, and only what they changed is in the form the app writes it. `fallback`: the result didn't read back as
 * `body`, so `body` itself is returned. That costs tidiness, never content.
 */
export function restoreSource(snapshot: string, body: string): { text: string; fallback: boolean } {
  const crlf = snapshot.includes("\r\n") && !/(^|[^\r])\n/.test(snapshot);
  const lf = crlf ? snapshot.replace(/\r\n/g, "\n") : snapshot;
  const want = canonical(body);
  // Item by item first. A new item beside old ones with another marker (`-` among `*`) starts a new list, so then whole lists.
  const text = [true, false].map((split) => splice(lf, body, split)).find((t) => canonical(t) === want);
  if (text === undefined) return { text: body, fallback: true };
  return { text: crlf ? text.replace(/\n/g, "\r\n") : text, fallback: false };
}
