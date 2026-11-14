import type { DocText } from "./text";

/** Where a comment sits, by its text: the passage, the text around it, and where it was last seen. */
export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  /** Offset in the document text when the anchor was made. Only breaks ties. */
  start: number;
  /** The `src` of each image in `exact` (an image is the character \ufffc), in order. Tells images apart. */
  images?: string[];
}

export const IMAGE_CHAR = "\ufffc";

/** The srcs of the images in a range of the document text. */
export function imagesIn(dt: DocText, from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const leaf = dt.leaves.get(i);
    if (leaf?.type.name === "image") out.push(String(leaf.attrs.src));
  }
  return out;
}

export interface Range { from: number; to: number }

const CONTEXT_MIN = 32;
const CONTEXT_STEP = 16;
const CONTEXT_MAX = 96;
/** A candidate is accepted only if at least this much of one side's context still matches (or all of it, if shorter). */
const CONTEXT_REQUIRED = 8;

/** Folds typographic variants and collapses whitespace runs, keeping a map back to the original indices. */
function normalise(s: string) {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s[i]!;
    if (c === "‘" || c === "’") c = "'";
    else if (c === "“" || c === "”") c = '"';
    else if (c === "–" || c === "—") c = "-";
    else if (/\s/.test(c)) c = " ";
    if (c === " " && out.endsWith(" ")) continue;
    out += c;
    map.push(i);
  }
  return { out, map };
}
const norm = (s: string) => normalise(s).out;

interface Candidate extends Range { p: number; s: number }

/** Every occurrence of `exact` inside one text block, scored by how much of the stored context still matches. */
function candidates(dt: DocText, a: Pick<Anchor, "exact" | "prefix" | "suffix" | "images">): Candidate[] {
  const { out: text, map } = normalise(dt.text);
  const exact = norm(a.exact).trim();
  if (!exact) return [];
  const prefix = norm(a.prefix);
  const suffix = norm(a.suffix);
  const found: Candidate[] = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) {
    const from = map[i]!;
    const to = map[i + exact.length - 1]! + 1;
    if (!dt.blocks.some((b) => from >= b.start && to <= b.end)) continue;
    if (a.images?.length && imagesIn(dt, from, to).join("\n") !== a.images.join("\n")) continue;
    let p = 0;
    while (p < prefix.length && i - 1 - p >= 0 && text[i - 1 - p] === prefix[prefix.length - 1 - p]) p++;
    let s = 0;
    const after = i + exact.length;
    while (s < suffix.length && after + s < text.length && text[after + s] === suffix[s]) s++;
    found.push({ from, to, p, s });
  }
  return found;
}

/**
 * Finds an anchor in the document text. A candidate must still look like the place the comment was made on: at least
 * one side of its context has to match. Of those, the best context wins, then the one nearest `start`. Null means
 * not found; the caller orphans the comment rather than risk attaching it to the wrong passage.
 */
export function anchor(dt: DocText, a: Anchor): Range | null {
  const needP = Math.min(CONTEXT_REQUIRED, norm(a.prefix).length);
  const needS = Math.min(CONTEXT_REQUIRED, norm(a.suffix).length);
  let best: Candidate | null = null;
  for (const c of candidates(dt, a)) {
    if (c.p < needP && c.s < needS) continue;
    if (!best || c.p + c.s > best.p + best.s || (c.p + c.s === best.p + best.s && Math.abs(c.from - a.start) < Math.abs(best.from - a.start))) best = c;
  }
  return best && { from: best.from, to: best.to };
}

/** How many places a bare quote (no context) matches inside single blocks. */
export function countMatches(dt: DocText, exact: string, images?: string[]): number {
  return candidates(dt, { exact, prefix: "", suffix: "", images }).length;
}

/**
 * Makes an anchor from a range of the document text. The context grows until no other occurrence of the passage
 * has the same surroundings; only identical paragraphs stay ambiguous, and then `start` decides.
 */
export function describe(dt: DocText, from: number, to: number): Anchor {
  while (from < to && /\s/.test(dt.text[from]!)) from++;
  while (to > from && /\s/.test(dt.text[to - 1]!)) to--;
  const exact = dt.text.slice(from, to);
  const images = imagesIn(dt, from, to);
  const withImages = (x: Anchor): Anchor => (images.length ? { ...x, images } : x);
  let a: Anchor = withImages({ exact, prefix: "", suffix: "", start: from });
  for (let ctx = CONTEXT_MIN; ctx <= CONTEXT_MAX; ctx += CONTEXT_STEP) {
    a = withImages({ exact, prefix: dt.text.slice(Math.max(0, from - ctx), from), suffix: dt.text.slice(to, to + ctx), start: from });
    const p = norm(a.prefix).length, s = norm(a.suffix).length;
    const full = candidates(dt, a).filter((c) => c.p === p && c.s === s);
    if (full.length <= 1) break;
  }
  return a;
}
