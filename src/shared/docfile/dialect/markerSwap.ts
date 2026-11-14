import type { JSONContent } from "@tiptap/core";
import { asInstruction, asState, commentFor, fromMarkers, instructionOfHex, OPEN, MARKER_RE, markerText, POINT_NODE, RANGE_MARK, stateOfCode, type TaskState } from "../markers";
import { HTML_COMMENT_INLINE } from "../htmlComment";
import { schema } from "../schema";

// Markers travel through the markdown parser as private-use text (`markers.ts`). These swap that text for
// point nodes and range marks after the parse, and back before the serialize.

type Token = { token: "s" | "e"; taskType: string; id: string; state: TaskState; instruction: string | null };
type Item = JSONContent | Token;
const isToken = (x: Item): x is Token => "token" in x;

/** A text node split at its markers: points become nodes, range ends stay tokens for `pairRanges`. */
function splitText(node: JSONContent, literal: boolean): Item[] {
  if (!node.text?.includes(OPEN)) return [node];
  if (literal) return [{ ...node, text: fromMarkers(node.text) }];
  const out: Item[] = [];
  let at = 0;
  for (const m of node.text.matchAll(MARKER_RE)) {
    if (m.index! > at) out.push({ ...node, text: node.text.slice(at, m.index) });
    const [part, taskType, id, state, instruction] = [m[1] as "p" | "s" | "e", m[2]!, m[3]!, stateOfCode(m[4]), instructionOfHex(m[5]) ?? null];
    out.push(part === "p" ? { type: POINT_NODE, attrs: { taskType, id, state, instruction } } : { token: part, taskType, id, state, instruction });
    at = m.index! + m[0].length;
  }
  if (at < node.text.length) out.push({ ...node, text: node.text.slice(at) });
  return out;
}

/**
 * Turns range tokens into marks. A start pairs with the next end of the same task type and id when no other range token
 * lies between them; everything between gets the mark. Any token left over (a lone comment, overlapping ranges) is an
 * ordinary HTML comment again, so nothing a person wrote is lost.
 */
function pairRanges(items: Item[]): JSONContent[] {
  const marked = new Map<number, { taskType: string; id: string; state: TaskState; instruction: string | null }>();
  const used = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    if (!isToken(a) || a.token !== "s" || used.has(i)) continue;
    let j = i + 1;
    while (j < items.length && !isToken(items[j]!)) j++;
    const b = items[j];
    if (!b || !isToken(b) || b.token !== "e" || b.id !== a.id || b.taskType !== a.taskType) continue;
    used.add(i);
    used.add(j);
    // The opening comment decides the state and the instruction.
    for (let k = i + 1; k < j; k++) marked.set(k, { taskType: a.taskType, id: a.id, state: a.state, instruction: a.instruction });
  }
  const out: JSONContent[] = [];
  items.forEach((item, i) => {
    // A token left over is an ordinary comment again, kept as written.
    if (isToken(item)) { if (!used.has(i)) out.push({ type: HTML_COMMENT_INLINE, attrs: { raw: commentFor(item.token, item.taskType, item.id, item.state, item.instruction) } }); return; }
    const range = marked.get(i);
    out.push(range ? { ...item, marks: [...(item.marks ?? []), { type: RANGE_MARK, attrs: range }] } : item);
  });
  return out;
}

/** After parsing: markers become point nodes and range marks; in code they go back to the literal comment. */
export function placeMarkers(node: JSONContent, inCodeBlock = false): JSONContent[] {
  if (node.type === "text") return splitText(node, inCodeBlock || !!node.marks?.some((m) => m.type === "code")).filter((x): x is JSONContent => !isToken(x));
  if (!node.content) return [node];
  const code = inCodeBlock || node.type === "codeBlock";
  if (schema.nodes[node.type!]?.isTextblock && !code) {
    const items = node.content.flatMap((c): Item[] => (c.type === "text" ? splitText(c, !!c.marks?.some((m) => m.type === "code")) : placeMarkers(c, code)));
    return [{ ...node, content: pairRanges(items) }];
  }
  return [{ ...node, content: node.content.flatMap((c) => placeMarkers(c, code)) }];
}

/**
 * After placing: a range over several blocks has its instruction on its first opening comment only, so every piece of
 * it is given the one found first. Then the writer sees it, and it survives whichever piece is kept.
 */
export function shareInstructions(doc: JSONContent): JSONContent {
  const said = new Map<string, string>();
  const ranges = (n: JSONContent): JSONContent["marks"] => n.marks?.filter((m) => m.type === RANGE_MARK);
  const find = (n: JSONContent) => {
    for (const m of ranges(n) ?? []) if (asInstruction(m.attrs?.instruction) && !said.has(m.attrs!.id)) said.set(m.attrs!.id, m.attrs!.instruction);
    n.content?.forEach(find);
  };
  find(doc);
  if (!said.size) return doc;
  const give = (n: JSONContent): JSONContent => {
    const marks = n.marks?.map((m) => (m.type === RANGE_MARK && said.has(m.attrs?.id) ? { ...m, attrs: { ...m.attrs, instruction: said.get(m.attrs!.id) } } : m));
    return { ...n, ...(marks && { marks }), ...(n.content && { content: n.content.map(give) }) };
  };
  return give(doc);
}

const rangeOf = (n: JSONContent) => n.marks?.find((m) => m.type === RANGE_MARK);
const withoutRange = (n: JSONContent): JSONContent => {
  const marks = (n.marks ?? []).filter((m) => m.type !== RANGE_MARK);
  const { marks: _was, ...rest } = n;
  return marks.length ? { ...rest, marks } : rest;
};
const standIn = (part: "s" | "e", attrs: Record<string, any>): JSONContent => ({
  type: "text",
  text: markerText(part, attrs.taskType, attrs.id, asState(attrs.state), part === "s" ? asInstruction(attrs.instruction) : undefined),
});

/**
 * Before serializing: a range around anything that isn't text (an image, a point marker) is written as its pair of
 * comments here. The mark's own renderer writes them around text only, so a range over an image alone (an `img`
 * marker) came back without its comments at all, and one over text and an image was cut into a pair around each
 * piece. Every run of inline siblings that share a range and holds such a node gives up the mark, and the stand-in
 * text for the two comments goes around the run.
 */
export function nodeRangesToText(node: JSONContent): JSONContent {
  if (!node.content) return node;
  const content = node.content.map(nodeRangesToText);
  if (!schema.nodes[node.type!]?.isTextblock) return { ...node, content };
  const out: JSONContent[] = [];
  for (let i = 0; i < content.length;) {
    const mark = rangeOf(content[i]!);
    if (!mark) { out.push(content[i]!); i++; continue; }
    // The run of neighbours in the same range, and whether any of them is a node rather than text.
    let end = i, nodes = false;
    while (end < content.length && rangeOf(content[end]!)?.attrs?.id === mark.attrs?.id) {
      if (content[end]!.type !== "text") nodes = true;
      end++;
    }
    if (!nodes) { while (i < end) out.push(content[i++]!); continue; }
    out.push(standIn("s", mark.attrs ?? {}));
    while (i < end) out.push(withoutRange(content[i++]!));
    out.push(standIn("e", mark.attrs ?? {}));
  }
  return { ...node, content: out };
}

/** Before serializing: point nodes become marker text (ranges are marks, written by their own renderer). */
export function markersToText(node: JSONContent): JSONContent {
  if (node.type === POINT_NODE) return { type: "text", text: markerText("p", node.attrs?.taskType, node.attrs?.id, asState(node.attrs?.state), asInstruction(node.attrs?.instruction)) };
  return node.content ? { ...node, content: node.content.map(markersToText) } : node;
}

