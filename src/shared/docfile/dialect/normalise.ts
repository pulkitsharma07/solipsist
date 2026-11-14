import type { JSONContent } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { schema } from "../schema";

// What a parsed or about-to-be-written document needs so that every page loads, and reads back as itself.

/**
 * The parser puts an image that stands on its own line straight into its container (doc, list item, quote), where
 * only blocks may go. Wrap such inline nodes in a paragraph: it serializes back to the same `![alt](src)` line.
 */
export function wrapStrayInlines(node: JSONContent): JSONContent {
  const type = schema.nodes[node.type!];
  if (!node.content) {
    return type && !type.isLeaf && !type.isTextblock && !type.contentMatch.validEnd ? { ...node, content: type.createAndFill()?.toJSON().content ?? [] } : node;
  }
  const content: JSONContent[] = [];
  for (const child of node.content.map(wrapStrayInlines)) {
    const childType = schema.nodes[child.type!];
    const strayInline = type && !type.isTextblock && type.contentMatch.matchType(schema.nodes.paragraph!) && childType?.isInline;
    if (strayInline) {
      const last = content[content.length - 1];
      if (last?.type === "paragraph" && last.attrs?.wrapped) last.content!.push(child);
      else content.push({ type: "paragraph", attrs: { wrapped: true }, content: [child] });
    } else content.push(child);
  }
  for (const c of content) if (c.attrs?.wrapped) delete c.attrs;
  // An empty list item ("2. " with nothing after it) parses to a listItem with no content, which isn't valid.
  if (type && !content.length && !type.isLeaf && !type.isTextblock && !type.contentMatch.validEnd) {
    return { ...node, content: type.createAndFill()?.toJSON().content ?? [] };
  }
  // A list item that starts with a nested list ("1. " and then an indented "- …") has no text of its own: give it an
  // empty first paragraph, since a list item must start with one.
  const first = content[0] && schema.nodes[content[0].type!];
  if (type && first && !type.contentMatch.matchType(first)) {
    const para = schema.nodes.paragraph!;
    if (type.contentMatch.matchType(para)?.matchType(first)) content.unshift({ type: "paragraph" });
  }
  return { ...node, content };
}

/**
 * Spaces at the start of a line of text (after a hard break, or a line the paragraph wraps onto) are indentation, not
 * text: CommonMark strips them. The parser keeps them, so how many survive depends on the list the line is in, and the
 * next save writes a different indent: `   - a  \n   b` loaded `b` with three spaces and read back with one, and a
 * wrapped line `    - b` was saved where it read back as a list. Drop them, everywhere but in code.
 */
export function trimLineIndents(node: JSONContent): JSONContent {
  if (!node.content || node.type === "codeBlock") return node;
  const content: JSONContent[] = [];
  for (const child of node.content) {
    if (child.type !== "text") { content.push(trimLineIndents(child)); continue; }
    let text = child.text!.replace(/\n[ \t]+/g, "\n");
    if (content[content.length - 1]?.type === "hardBreak") text = text.replace(/^[ \t]+/, "");
    if (text) content.push(text === child.text ? child : { ...child, text });
  }
  return { ...node, content };
}

/**
 * Comment highlights write nothing, but they cut the text into pieces, and the serializer closes and reopens marks at
 * each cut: a highlight from plain text into the middle of "**budget owner**" made it write `**budget**` and then
 * `<strong>owner</strong>`, literal text on the next load. Drop them, and join the text they cut, before writing.
 */
export function withoutHighlights(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content: JSONContent[] = [];
  for (const child of node.content) {
    const marks = child.marks?.filter((m) => m.type !== "comment");
    const next = marks && marks.length !== child.marks!.length ? { ...child, ...(marks.length ? { marks } : { marks: undefined }) } : child;
    if (!next.marks) delete next.marks;
    const prev = content[content.length - 1];
    if (prev?.type === "text" && next.type === "text" && JSON.stringify(prev.marks ?? []) === JSON.stringify(next.marks ?? [])) {
      content[content.length - 1] = { ...prev, text: prev.text! + next.text! };
      continue;
    }
    content.push(withoutHighlights(next));
  }
  return { ...node, content };
}

/**
 * Marks a text node can't carry together (code excludes every other mark, so `**`x`**` has no home in the schema) are
 * reduced the way ProseMirror itself would: the first mark that excludes another one wins. The page then loads; it only
 * loses the bold or link around the code.
 */
export function compatibleMarks(node: JSONContent): JSONContent {
  if (node.marks && node.marks.length > 1) {
    let set: readonly Mark[] = [];
    for (const m of node.marks) {
      const type = schema.marks[m.type];
      if (type) set = type.create(m.attrs).addToSet(set);
    }
    node = { ...node, marks: set.map((m) => m.toJSON() as { type: string; attrs?: Record<string, unknown> }) };
  }
  return node.content ? { ...node, content: node.content.map(compatibleMarks) } : node;
}

/**
 * Two bullet lists in a row would both be written with `-` and read back as one list. The second is written with `*`
 * instead: its items are flagged here, and `starMarkers` swaps the marker once the markdown is written.
 */
const STAR = "\uE002";
export function flagStarLists(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const out: JSONContent[] = [];
  for (const child of node.content.map(flagStarLists)) {
    const prev = out[out.length - 1];
    // Alternate `-` and `*` down a run of lists, so each differs from the one before.
    if (child.type !== "bulletList" || prev?.type !== "bulletList" || prev.attrs?.star) { out.push(child); continue; }
    out.push({
      ...child,
      attrs: { ...child.attrs, star: true },
      content: child.content?.map((item) => ({ ...item, content: item.content?.map((c, k) => (k === 0 && c.type === "paragraph" ? { ...c, content: [{ type: "text", text: STAR }, ...(c.content ?? [])] } : c)) })),
    });
  }
  return { ...node, content: out };
}
export const starMarkers = (md: string) => md.replace(new RegExp(`^((?:> ?)*)- ${STAR}`, "gm"), "$1* ").replaceAll(STAR, "");

