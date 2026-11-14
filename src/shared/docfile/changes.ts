import type { JSONContent } from "@tiptap/core";
import { diffPatch } from "node-diff3";
import { canonicalBody } from "./file";
import { blockKey, markdownToDoc } from "./markdown";
import { HTML_COMMENT, HTML_COMMENT_INLINE } from "./htmlComment";
import { asInstruction, POINT_NODE, RANGE_MARK } from "./markers";
import { pluginFor } from "../plugin";

/** A word of an edited line: kept, added, or removed. */
export interface Word { text: string; kind: "same" | "add" | "del" }

/** One line of an edited block, as a diff shows it. "gap" stands for lines left out because nothing changed there. */
export type DiffLine = { kind: "same" | "add" | "del"; words: Word[] } | { kind: "gap"; count: number };

/** `at`: the block's index in their body (added, edited) or the body both started from (removed): where it happens. */
export type Change =
  | { kind: "added"; after: JSONContent; at: number }
  | { kind: "removed"; before: JSONContent; at: number }
  | { kind: "edited"; before: JSONContent; after: JSONContent; lines: DiffLine[]; at: number };

const pointText = (kind: string) => pluginFor(kind)?.reviewText ?? `[${kind}]`;

const blocks = (markdown: string): JSONContent[] => markdownToDoc(markdown).toJSON().content ?? [];

/**
 * The text of inline content as it reads; a range is shown between ⟦ ⟧, followed by its instruction (`⟦text⟧ → "make
 * it shorter"`) where it has one, and a point as its plugin's `reviewText` ([complete]).
 */
const inlineText = (node: JSONContent): string => {
  const kids = node.content ?? [];
  if (node.text !== undefined || node.type !== undefined && !kids.length) {
    if (node.text !== undefined) return node.text;
    return node.type === "hardBreak" ? "\n" : node.type === "image" ? `[image ${node.attrs?.alt ?? ""}]`.replace(" ]", "]") : node.type === POINT_NODE ? pointText(node.attrs?.taskType) : node.type === HTML_COMMENT_INLINE ? String(node.attrs?.raw ?? "") : "";
  }
  // Runs of children that carry the same range are wrapped together.
  const range = (n: JSONContent) => n.marks?.find((m) => m.type === RANGE_MARK)?.attrs;
  let out = "";
  for (let i = 0; i < kids.length; ) {
    const id = range(kids[i]!)?.id as string | undefined;
    let j = i + 1;
    while (id && j < kids.length && range(kids[j]!)?.id === id) j++;
    const text = kids.slice(i, j).map(inlineText).join("");
    const instruction = asInstruction(range(kids[i]!)?.instruction);
    out += id ? `⟦${text}⟧${instruction ? ` → "${instruction}"` : ""}` : text;
    i = j;
  }
  return out;
};

const prefixed = (lines: string[], first: string, rest: string) => lines.map((l, i) => (i === 0 ? first : rest) + l);

/**
 * A block as lines of text, the way it reads on the page: a list item per line (nested ones indented), a table row
 * per line, a code block's own lines, a line break as a new line. Used to show what changed, line by line.
 */
export function blockLines(node: JSONContent): string[] {
  const kids = (n: JSONContent) => n.content ?? [];
  switch (node.type) {
    case "heading": return prefixed(inlineText(node).split("\n"), `${"#".repeat(node.attrs?.level ?? 1)} `, "");
    case "codeBlock": return inlineText(node).split("\n");
    case "horizontalRule": return ["───"];
    case HTML_COMMENT: return String(node.attrs?.raw ?? "").split("\n");
    case "bulletList":
    case "orderedList":
    case "taskList":
      return kids(node).flatMap((item, i) => {
        const mark = node.type === "bulletList" ? "• " : node.type === "orderedList" ? `${(node.attrs?.start ?? 1) + i}. ` : item.attrs?.checked ? "☑ " : "☐ ";
        const inner = kids(item).flatMap(blockLines);
        return prefixed(inner.length ? inner : [""], mark, "  ");
      });
    case "blockquote": return kids(node).flatMap(blockLines).map((l) => `> ${l}`);
    case "table": return kids(node).map((row) => kids(row).map((cell) => kids(cell).flatMap(blockLines).join(" ")).join(" │ "));
    case "paragraph": return inlineText(node).split("\n");
    default: return kids(node).length && kids(node).some((k) => k.type !== "text") ? kids(node).flatMap(blockLines) : inlineText(node).split("\n");
  }
}

function wordDiff(a: string, b: string): { before: Word[]; after: Word[] } {
  const [wa, wb] = [a.split(/(\s+)/).filter(Boolean), b.split(/(\s+)/).filter(Boolean)];
  const [before, after]: [Word[], Word[]] = [[], []];
  let at = 0;
  for (const p of diffPatch(wa, wb)) {
    for (; at < p.buffer1.offset; at++) { before.push({ text: wa[at]!, kind: "same" }); after.push({ text: wa[at]!, kind: "same" }); }
    for (const w of wa.slice(p.buffer1.offset, p.buffer1.offset + p.buffer1.length)) before.push({ text: w, kind: "del" });
    for (const w of p.buffer2.chunk) after.push({ text: w, kind: "add" });
    at = p.buffer1.offset + p.buffer1.length;
  }
  for (; at < wa.length; at++) { before.push({ text: wa[at]!, kind: "same" }); after.push({ text: wa[at]!, kind: "same" }); }
  return { before, after };
}

const whole = (text: string, kind: Word["kind"]): Word[] => (text === "" ? [] : [{ text, kind }]);
/** Lines of context kept around a change; longer runs of unchanged lines collapse into a gap. */
const CONTEXT = 1;

/** The lines of an edited block as a diff: changed lines paired up and marked word by word, unchanged ones as context. */
export function diffLines(before: JSONContent, after: JSONContent): DiffLine[] {
  const [a, b] = [blockLines(before), blockLines(after)];
  const all: DiffLine[] = [];
  let at = 0;
  const same = (line: string): DiffLine => ({ kind: "same", words: whole(line, "same") });
  for (const p of diffPatch(a, b)) {
    for (; at < p.buffer1.offset; at++) all.push(same(a[at]!));
    const [old, now] = [a.slice(p.buffer1.offset, p.buffer1.offset + p.buffer1.length), p.buffer2.chunk];
    const paired = Math.min(old.length, now.length);
    const pairs = Array.from({ length: paired }, (_, i) => wordDiff(old[i]!, now[i]!));
    // Removed lines first, then added ones, as a unified diff lists them.
    pairs.forEach((w) => all.push({ kind: "del", words: w.before }));
    old.slice(paired).forEach((l) => all.push({ kind: "del", words: whole(l, "del") }));
    pairs.forEach((w) => all.push({ kind: "add", words: w.after }));
    now.slice(paired).forEach((l) => all.push({ kind: "add", words: whole(l, "add") }));
    at = p.buffer1.offset + p.buffer1.length;
  }
  for (; at < a.length; at++) all.push(same(a[at]!));
  // Keep the changed lines and CONTEXT lines around them; fold the rest.
  const keep = all.map((l, i) => l.kind !== "same" || all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== "same"));
  const out: DiffLine[] = [];
  for (let i = 0; i < all.length; i++) {
    if (keep[i]) { out.push(all[i]!); continue; }
    let j = i;
    while (j < all.length && !keep[j]) j++;
    out.push(j - i === 1 ? all[i]! : { kind: "gap", count: j - i });
    i = j - 1;
  }
  return out;
}

/**
 * What someone else changed: the blocks (paragraphs, headings, lists, tables…) that differ between the body both
 * writers started from (`base`) and the body they saved (`theirs`). A block changed in place is "edited", with the
 * words that differ; blocks that only appeared or vanished are "added" and "removed".
 */
export function diffBodies(base: string, theirs: string): Change[] {
  // Compared as the file stores them: the serializer's own trailing blank lines must not look like a block.
  const [a, b] = [blocks(canonicalBody(base)), blocks(canonicalBody(theirs))];
  const out: Change[] = [];
  for (const p of diffPatch(a.map(blockKey), b.map(blockKey))) {
    const old = a.slice(p.buffer1.offset, p.buffer1.offset + p.buffer1.length);
    const now = p.buffer2.chunk.length ? b.slice(p.buffer2.offset, p.buffer2.offset + p.buffer2.chunk.length) : [];
    const paired = Math.min(old.length, now.length);
    for (let i = 0; i < paired; i++) {
      const [oi, ni] = [p.buffer1.offset + i, p.buffer2.offset + i];
      out.push(old[i]!.type === now[i]!.type
        ? { kind: "edited", before: old[i]!, after: now[i]!, lines: diffLines(old[i]!, now[i]!), at: ni }
        : { kind: "removed", before: old[i]!, at: oi });
      if (old[i]!.type !== now[i]!.type) out.push({ kind: "added", after: now[i]!, at: ni });
    }
    old.slice(paired).forEach((x, k) => out.push({ kind: "removed", before: x, at: p.buffer1.offset + paired + k }));
    now.slice(paired).forEach((x, k) => out.push({ kind: "added", after: x, at: p.buffer2.offset + paired + k }));
  }
  return out;
}

export const summarize = (changes: Change[]) => ({
  added: changes.filter((c) => c.kind === "added").length,
  edited: changes.filter((c) => c.kind === "edited").length,
  removed: changes.filter((c) => c.kind === "removed").length,
});
