import { Fragment, Slice, type Mark, type MarkType, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import type { TaskRecord, SuggestionEdit } from "./file";
import { blockKey, toEditorDoc } from "./markdown";
import { markerComments, POINT_NODE, RANGE_MARK } from "./markers";

/**
 * Accepting and rejecting a suggestion: a marker at `:sug` whose result waits in its record (`file.ts`). Each is
 * one set of steps on the writer's document, so it is saved like typing and Undo takes it back. Pure: the editor and
 * the tests call these with a transaction or a transform.
 *
 * - accept: the proposal goes where the record says (`at` the point, `replace` the range's text, `after` the range),
 *   and the marker goes. Its edits to other blocks (`edits`) are made too.
 * - reject (also how a decline is dismissed): the marker goes, the writer's text stays.
 * - ask again: the marker goes back to pending, for another run.
 * - button: accepted, and the marker stays around the result at `:btn`, to run the task again later. A task with a
 *   button keeps it whatever is decided on a later result.
 * - asked for a button: asked again, the agent told to give a result that can be a button (one piece of text in place).
 */
export type Decision = "accepted" | "rejected" | "asked_again" | "button" | "asked_for_button";

/** Where a marker is in a document: a point's position, or the pieces of text a range covers, in order. */
export interface MarkerSpots {
  taskType: string;
  points: number[];
  pieces: { from: number; to: number }[];
}

/** Every spot of marker `id` in `doc`, or null when it isn't there. Adjacent marked text is one piece. */
export function markerSpots(doc: PMNode, id: string): MarkerSpots | null {
  let taskType: string | null = null;
  const points: number[] = [];
  const pieces: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === POINT_NODE && node.attrs.id === id) { taskType = node.attrs.taskType; points.push(pos); return false; }
    const mark = node.isInline ? node.marks.find((m) => m.type.name === RANGE_MARK && m.attrs.id === id) : undefined;
    if (!mark) return true;
    taskType = mark.attrs.taskType;
    const last = pieces[pieces.length - 1];
    if (last && last.to === pos) last.to = pos + node.nodeSize;
    else pieces.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });
  return taskType === null ? null : { taskType, points, pieces };
}

/**
 * The proposal as a slice of the document's own schema. Inline content is a paragraph open at both ends, so it joins
 * the text around where it goes; blocks are closed. Empty markdown is nothing.
 */
export function suggestionSlice(doc: PMNode, markdown: string, place: TaskRecord["place"]): Slice {
  if (!markdown.trim()) return Slice.empty;
  const parsed = toEditorDoc(doc.type.schema, markdown);
  const only = parsed.childCount === 1 ? parsed.firstChild! : null;
  if (place === "inline" && only?.type.name === "paragraph") return new Slice(Fragment.from(only), 1, 1);
  return new Slice(parsed.content, 0, 0);
}

/** What each top-level block of a document says, as `blockKey` has it, remembered per node. */
const keys = new WeakMap<PMNode, string>();
const keyOf = (node: PMNode) => {
  let k = keys.get(node);
  if (k === undefined) keys.set(node, (k = blockKey(node.toJSON())));
  return k;
};

/**
 * Where the top-level blocks that `markdown` is made of sit in `doc`, one after another: their span, or null when
 * they are not there, or are there more than once (no way to tell which is meant).
 */
export function findBlocks(doc: PMNode, markdown: string): { from: number; to: number } | null {
  const want = blockKeysOf(doc, markdown);
  if (!want.length) return null;
  const have: { key: string; from: number; to: number }[] = [];
  doc.forEach((node, offset) => have.push({ key: keyOf(node), from: offset, to: offset + node.nodeSize }));
  let found: { from: number; to: number } | null = null;
  for (let i = 0; i + want.length <= have.length; i++) {
    if (!want.every((k, j) => have[i + j]!.key === k)) continue;
    if (found) return null;
    found = { from: have[i]!.from, to: have[i + want.length - 1]!.to };
  }
  return found;
}

/** The keys of the top-level blocks `markdown` is made of (none for blank markdown). */
function blockKeysOf(doc: PMNode, markdown: string): string[] {
  if (!markdown.trim()) return [];
  const out: string[] = [];
  toEditorDoc(doc.type.schema, markdown).forEach((n) => out.push(keyOf(n)));
  return out;
}

/** An edit to other blocks: `before` replaced by `after`, or removed. False, changing nothing, when `before` can't be found once. */
export function applyEdit(tr: Transform, edit: SuggestionEdit): boolean {
  const at = findBlocks(tr.doc, edit.before);
  if (!at) return false;
  const schema = tr.doc.type.schema;
  // Removing every block of the page leaves one empty paragraph: a page is never without a block.
  const after = edit.after.trim() ? toEditorDoc(schema, edit.after).content : at.from === 0 && at.to === tr.doc.content.size ? schema.nodes.paragraph!.create() : null;
  if (after) tr.replaceWith(at.from, at.to, after);
  else tr.delete(at.from, at.to);
  return true;
}

/** Every piece of range marker `id` given the attributes in `patch` (its state, its instruction). */
export function setRangeAttrs(tr: Transform, id: string, patch: Record<string, unknown>) {
  for (const p of markerSpots(tr.doc, id)?.pieces ?? []) {
    tr.doc.nodesBetween(p.from, p.to, (node, pos) => {
      const mark = node.marks.find((m) => m.type.name === RANGE_MARK && m.attrs.id === id);
      if (mark) tr.addMark(Math.max(p.from, pos), Math.min(p.to, pos + node.nodeSize), mark.type.create({ ...mark.attrs, ...patch }));
    });
  }
}

/** Text with marks of marker `id` taken off, from `from` to `to`. */
function unmark(tr: Transform, id: string, from: number, to: number) {
  const marks: { from: number; to: number; mark: Mark }[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    for (const m of node.marks) if (m.type.name === RANGE_MARK && m.attrs.id === id) marks.push({ from: Math.max(from, pos), to: Math.min(to, pos + node.nodeSize), mark: m });
  });
  for (const m of marks) tr.removeMark(m.from, m.to, m.mark);
}

/** What a span may widen out of when it covers it whole: a text block, and a list item. A quote or a cell stays. */
const widens = (n: PMNode) => n.isTextblock || n.type.name === "listItem" || n.type.name === "taskItem";

/**
 * A span widened out of every text block and list item it covers whole, so replacing it removes them rather than
 * leaving them empty.
 */
function span(doc: PMNode, from: number, to: number) {
  for (let grew = true; grew;) {
    grew = false;
    const $f = doc.resolve(from);
    if ($f.depth > 0 && widens($f.parent) && from === $f.start() && to >= $f.end()) { from = $f.before(); grew = true; }
    const $t = doc.resolve(to);
    if ($t.depth > 0 && widens($t.parent) && to === $t.end() && from <= $t.start()) { to = $t.after(); grew = true; }
  }
  return { from, to };
}

/**
 * Closed blocks going into a node of their own type (a numbered list over items of a numbered list) are opened, so
 * their children join it instead of nesting a second one inside.
 */
function into(doc: PMNode, pos: number, slice: Slice): Slice {
  const only = slice.content.childCount === 1 ? slice.content.firstChild! : null;
  if (slice.openStart || !only || only.type !== doc.resolve(pos).parent.type) return slice;
  return new Slice(slice.content, 1, 1);
}

/**
 * After text was taken out at `pos`: a space left doubled, or left before punctuation or the block's end, goes, and
 * so does one left at the block's start.
 */
function tidySpace(tr: Transform, pos: number) {
  const $pos = tr.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return;
  const after = pos < $pos.end() ? tr.doc.textBetween(pos, pos + 1) : "";
  if (pos <= $pos.start()) {
    if (after === " ") tr.delete(pos, pos + 1);
    return;
  }
  const before = tr.doc.textBetween(pos - 1, pos);
  if (before === " " && (after === "" || /^[\s.,;:!?)]$/.test(after))) tr.delete(pos - 1, pos);
}

/** Takes out the point at `pos`: with its block when it was alone in it, otherwise tidying the space it leaves. */
function removePoint(tr: Transform, pos: number) {
  if (aloneInBlock(tr.doc, pos)) {
    const $pos = tr.doc.resolve(pos);
    const { from, to } = span(tr.doc, $pos.start(), $pos.end());
    tr.deleteRange(from, to);
    return;
  }
  tr.delete(pos, pos + 1);
  tidySpace(tr, pos);
}

export function aloneInBlock(doc: PMNode, pos: number) {
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return false;
  let alone = true;
  $pos.parent.forEach((child, offset) => {
    if ($pos.start() + offset === pos) return;
    if (!(child.isText && !child.text!.trim())) alone = false;
  });
  return alone;
}

/** A space between the text before `pos` and inline content that starts with a word, as a writer would leave one. */
function spaced(doc: PMNode, pos: number, slice: Slice): Slice {
  const before = doc.resolve(pos).nodeBefore;
  const first = slice.content.firstChild?.firstChild;
  const last = before?.isText ? before.text!.slice(-1) : "";
  if (!first?.isText || !last || /\s/.test(last) || !/^[\p{L}\p{N}(“"'‘[]/u.test(first.text!)) return slice;
  const para = slice.content.firstChild!;
  const withSpace = para.copy(Fragment.from(doc.type.schema.text(" ")).append(para.content));
  return new Slice(Fragment.from(withSpace), 1, 1);
}

/**
 * Applies the writer's decision on marker `id` to `tr`. `record` is the marker's record (its proposal and
 * where it goes); a decline has no proposal, and accepting it is the same as rejecting it. Returns false, changing
 * nothing, when the marker isn't in the document.
 */
export function decide(tr: Transform, id: string, decision: Decision, record: Pick<TaskRecord, "mode" | "place" | "suggestion" | "edits" | "button">): boolean {
  const spots = markerSpots(tr.doc, id);
  if (!spots) return false;
  const placed = decideMarker(tr, id, decision, record, spots);
  // Its edits elsewhere: each found by what it changes, in the page as the steps above left it. One the writer has
  // changed since can't be found, and is left out.
  if (decision === "accepted") for (const edit of record.edits ?? []) applyEdit(tr, edit);
  return placed;
}

function decideMarker(tr: Transform, id: string, decision: Decision, record: Pick<TaskRecord, "mode" | "place" | "suggestion" | "button">, spots: MarkerSpots): boolean {
  const { points, pieces } = spots;
  if (decision === "asked_again" || decision === "asked_for_button") {
    for (const pos of points) tr.setNodeMarkup(pos, undefined, { ...tr.doc.nodeAt(pos)!.attrs, state: "pending" });
    if (pieces.length) setRangeAttrs(tr, id, { state: "pending" });
    return true;
  }
  const suggested = record.suggestion;
  if (pieces.length && (decision === "button" || record.button)) {
    if (decision === "rejected" || !suggested?.trim()) { setRangeAttrs(tr, id, { state: "btn" }); return true; }
    return acceptKeepingButton(tr, id, record, suggested, pieces);
  }
  const accept = (decision === "accepted" || decision === "button") && suggested !== undefined;
  // Positions were found in the document as it was when this call began; `tr` may already hold other steps.
  const start = tr.steps.length;
  const map = (pos: number) => tr.mapping.slice(start).map(pos);
  // Right to left, so each change leaves the positions before it as they were.
  for (const pos of [...points].reverse()) {
    const mapped = map(pos);
    const slice = accept ? suggestionSlice(tr.doc, suggested, record.place) : Slice.empty;
    if (!slice.size) { removePoint(tr, mapped); continue; }
    if (slice.openStart === 0 && aloneInBlock(tr.doc, mapped)) {
      const $pos = tr.doc.resolve(mapped);
      const { from, to } = span(tr.doc, $pos.start(), $pos.end());
      tr.replaceRange(from, to, into(tr.doc, from, slice));
    } else tr.replaceRange(mapped, mapped + 1, slice.openStart ? spaced(tr.doc, mapped, slice) : slice);
  }
  if (!pieces.length) return true;
  const mode = record.mode ?? "after";
  if (accept && mode === "replace") {
    const { from, to } = span(tr.doc, map(pieces[0]!.from), map(pieces[pieces.length - 1]!.to));
    const slice = suggestionSlice(tr.doc, suggested, record.place);
    if (slice.size) tr.replaceRange(from, to, into(tr.doc, from, slice));
    else {
      const before = tr.steps.length;
      tr.deleteRange(from, to);
      tidySpace(tr, tr.mapping.slice(before).map(from));
    }
    return true;
  }
  const end = pieces[pieces.length - 1]!.to;
  unmark(tr, id, map(pieces[0]!.from), map(end));
  if (accept && suggested.trim()) {
    const slice = suggestionSlice(tr.doc, suggested, record.place);
    const at = map(end);
    // Inline: right after the range, on its line. Blocks: after the block that holds the range's end.
    if (slice.openStart) tr.replaceRange(at, at, spaced(tr.doc, at, slice));
    else { const after = tr.doc.resolve(at).after(); tr.replaceRange(after, after, slice); }
  }
  return true;
}

/**
 * The result goes in as Accept would put it, and the marker ends up around it at `:btn`, whatever the mode: a later run
 * replaces that text. With `after`, the text the writer asked about stays, as plain text.
 */
function acceptKeepingButton(tr: Transform, id: string, record: Pick<TaskRecord, "mode" | "place">, suggested: string, pieces: MarkerSpots["pieces"]): boolean {
  const first = pieces[0]!, last = pieces[pieces.length - 1]!;
  const mark = tr.doc.nodeAt(first.from)?.marks.find((m) => m.type.name === RANGE_MARK && m.attrs.id === id);
  if (!mark) return false;
  const slice = suggestionSlice(tr.doc, suggested, record.place);
  const start = tr.steps.length;
  let from = last.to, to = last.to, lead = 0;
  if ((record.mode ?? "after") === "replace") {
    ({ from, to } = wholeTable(tr.doc, span(tr.doc, first.from, last.to)));
    tr.replaceRange(from, to, into(tr.doc, from, slice));
  } else {
    unmark(tr, id, first.from, last.to);
    if (slice.openStart) {
      const withSpace = spaced(tr.doc, last.to, slice);
      if (withSpace !== slice) lead = 1; // the space `spaced` put first is not part of the result
      tr.replaceRange(last.to, last.to, withSpace);
    } else {
      from = to = tr.doc.resolve(last.to).after();
      tr.replaceRange(from, to, slice);
    }
  }
  const made = tr.mapping.slice(start);
  tr.addMark(made.map(from, -1) + lead, made.map(to, 1), mark.type.create({ ...mark.attrs, state: "btn" }));
  return true;
}

/** A span over every cell of a table, as the span of the table: the result takes the table's place, not the inside of its cells. */
function wholeTable(doc: PMNode, s: { from: number; to: number }) {
  const $f = doc.resolve(s.from);
  for (let d = $f.sharedDepth(s.to); d > 0; d--) {
    if ($f.node(d).type.name !== "table") continue;
    const covered = !doc.textBetween($f.start(d), s.from).trim() && !doc.textBetween(s.to, $f.end(d)).trim();
    return covered ? { from: $f.before(d), to: $f.after(d) } : s;
  }
  return s;
}

/** Whether a block's first or last inline content can carry the range's mark, however deep it is. */
function edgeTakes(block: PMNode, side: "firstChild" | "lastChild", mark: MarkType): boolean {
  let n = block;
  while (!n.isTextblock) {
    const next = n[side];
    if (!next) return false;
    n = next;
  }
  const edge = n[side];
  return !!edge && n.type.allowsMarkType(mark) && !edge.marks.some((m) => m.type.excludes(mark));
}

/**
 * What keeps a result from being a button, or null. A button rewrites only its own text, so its result must be one piece
 * of text in place: not changes to other parts of the page, not nothing, no requests of its own, and nothing at either
 * end that its mark can't cover (a code block).
 */
export type ButtonBlocker = "elsewhere" | "deletes" | "requests" | "edge";
export function buttonBlocker(schema: Schema, record: Pick<TaskRecord, "suggestion" | "edits">): ButtonBlocker | null {
  if (record.edits?.length) return "elsewhere";
  if (!record.suggestion?.trim()) return "deletes";
  if (markerComments(record.suggestion).length) return "requests";
  const doc = toEditorDoc(schema, record.suggestion);
  const mark = schema.marks[RANGE_MARK]!;
  if (!edgeTakes(doc.firstChild!, "firstChild", mark) || !edgeTakes(doc.lastChild!, "lastChild", mark)) return "edge";
  return null;
}

/** Each blocker in the writer's words: what they can see on the page, and the one rule (a button rewrites only its own text). */
export const BUTTON_BLOCKED: Record<ButtonBlocker, string> = {
  elsewhere: "It also changes other parts of the page (struck through in red). A button can only rewrite its own text.",
  deletes: "It deletes the text, so there would be nothing for a button to rewrite.",
  requests: "It contains new requests of its own, which a button can't hold.",
  edge: "It starts or ends with a code block, which a button can't hold.",
};

/** Why this result can't be kept as a button, in the writer's words; null when it can. A re-run's reply must pass too. */
export function whyNoButton(schema: Schema, record: Pick<TaskRecord, "suggestion" | "edits">): string | null {
  const b = buttonBlocker(schema, record);
  return b && BUTTON_BLOCKED[b];
}

/** The writer pressed the button of task `id`: it goes back to pending, as an ask again does. `instruction`, if given, is its new one. */
export function pressButton(tr: Transform, id: string, instruction?: string | null) {
  setRangeAttrs(tr, id, { state: "pending", ...(instruction !== undefined && { instruction: instruction || null }) });
}

/** Takes the button of task `id` off: the comments go, the text stays. */
export function removeButton(tr: Transform, id: string) {
  for (const p of markerSpots(tr.doc, id)?.pieces ?? []) unmark(tr, id, p.from, p.to);
}

/**
 * How often a button may run on its own, the choices the writer is offered (ms). The server runs it, page open or not, as
 * if the writer pressed it (`src/server/agent/schedules.ts`).
 */
export const BUTTON_EVERY = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;
/** `every` in words: "every minute", "every 15 minutes", "every hour", "every day". */
export const everyLabel = (ms: number) =>
  ms === 60_000 ? "every minute" : ms < 3_600_000 ? `every ${ms / 60_000} minutes` : ms === 3_600_000 ? "every hour" : ms === 86_400_000 ? "every day" : `every ${Math.round(ms / 3_600_000)} hours`;
/** When the button of `record` runs next on its own (epoch ms), or null when it has no schedule. */
export function nextRunAt(record: Pick<TaskRecord, "button" | "finished"> | undefined): number | null {
  const every = record?.button?.every;
  if (!every) return null;
  const last = Math.max(...[record.finished, record.button!.at, record.button!.from].map((t) => (t ? Date.parse(t) : 0)).filter(Number.isFinite));
  return last + every;
}
