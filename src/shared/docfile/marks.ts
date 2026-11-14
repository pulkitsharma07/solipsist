import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import { Fragment, Slice as PMSlice } from "@tiptap/pm/model";
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state";
import { anchor, describe, type Anchor } from "./anchor";
import type { CommentEntry } from "./file";
import { RANGE_MARK } from "./markers";
import { docText } from "./text";

/**
 * Comment marks in a ProseMirror document. Pure and DOM-free: the browser's editor uses these, and so do the tests
 * that play a browser tab headlessly.
 */

/**
 * Each comment id's position range in the document: the text carrying its mark in the first text block it appears
 * in (one comment, one block; `oneBlockPerComment` removes the rest from the editor).
 */
export function commentRanges(doc: PMNode): Map<string, { from: number; to: number }> {
  const ranges = new Map<string, { from: number; to: number; block: number }>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    node.forEach((child, offset) => {
      if (!child.isInline) return;
      const from = pos + 1 + offset, to = from + child.nodeSize;
      for (const m of child.marks) {
        if (m.type.name !== "comment") continue;
        const r = ranges.get(m.attrs.id);
        if (!r) ranges.set(m.attrs.id, { from, to, block: pos });
        else if (r.block === pos) ranges.set(m.attrs.id, { from: Math.min(r.from, from), to: Math.max(r.to, to), block: pos });
      }
    });
    return false;
  });
  return new Map([...ranges].map(([id, { from, to }]) => [id, { from, to }]));
}

/**
 * One comment, one block: after any change (Enter inside a highlight, a paste), a comment's mark is kept only in the
 * first text block it appears in. Appended to the writer's transaction, so Undo restores the whole highlight.
 */
export const oneBlockPerComment = () =>
  new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.docChanged)) return null;
      const first = commentRanges(state.doc);
      const tr = state.tr;
      state.doc.descendants((node, pos) => {
        if (!node.isInline) return;
        for (const m of node.marks) {
          if (m.type.name !== "comment") continue;
          const keep = first.get(m.attrs.id)!;
          if (pos >= keep.to || pos + node.nodeSize <= keep.from) tr.removeMark(pos, pos + node.nodeSize, m);
        }
      });
      return tr.docChanged ? tr : null;
    },
  });

/** Rebuilds every marked comment's anchor from its mark: what a save sends. */
export function anchorsFromMarks(doc: PMNode): Map<string, Anchor> {
  const dt = docText(doc);
  const out = new Map<string, Anchor>();
  for (const [id, r] of commentRanges(doc)) {
    const from = dt.toOffset(r.from), to = dt.toOffset(r.to);
    if (from != null && to != null) out.set(id, describe(dt, from, to));
  }
  return out;
}

/** Finds an anchor in a document and returns its ProseMirror range. */
export function anchorInDoc(doc: PMNode, a: Anchor): { from: number; to: number } | null {
  const dt = docText(doc);
  const r = anchor(dt, a);
  if (!r) return null;
  const from = dt.toPos(r.from), to = dt.toPos(r.to);
  return from != null && to != null ? { from, to } : null;
}

export interface PlaceResult {
  tr: Transaction;
  /** Comments now handled by this tab: they have a mark, or their passage wasn't found (and so are orphaned). */
  known: string[];
  /** Matches in the block under the caret: retried when the writer pauses. */
  deferred: string[];
  /** Comments the file took down (dismissed) or no longer has: their marks are removed and the tab stops reporting them. */
  forgotten: string[];
}

/**
 * Applies the comments of a received file to the editor (plan section 5.2). Comments the tab already knows keep their
 * marks: the marks are more current than the file. New open comments are searched for and marked. Comments the
 * server took down (dismissed) lose their marks. The transaction is kept out of the undo history.
 */
export function placeComments(
  state: EditorState,
  comments: CommentEntry[],
  known: Set<string>,
  opts: { deferInBlockAt?: number } = {},
): PlaceResult {
  const tr = state.tr.setMeta("addToHistory", false);
  const markType = state.schema.marks.comment!;
  const ranges = commentRanges(state.doc);
  const result: PlaceResult = { tr, known: [], deferred: [], forgotten: [] };
  const caretBlock = opts.deferInBlockAt == null ? null : blockRange(state.doc, opts.deferInBlockAt);

  const inFile = new Set(comments.map((c) => c.id));
  for (const [id, r] of ranges) {
    if (inFile.has(id)) continue;
    tr.removeMark(r.from, r.to, markType.create({ id }));
    result.forgotten.push(id);
  }
  for (const c of comments) {
    const r = ranges.get(c.id);
    if (c.status === "dismissed") {
      if (r) tr.removeMark(r.from, r.to, markType.create({ id: c.id }));
      result.forgotten.push(c.id);
      continue;
    }
    if (known.has(c.id) || c.status !== "open") continue;
    const at = anchorInDoc(state.doc, c.anchor);
    if (at && caretBlock && at.from >= caretBlock.from && at.to <= caretBlock.to) {
      result.deferred.push(c.id);
      continue;
    }
    if (at) tr.addMark(at.from, at.to, markType.create({ id: c.id }));
    result.known.push(c.id);
  }
  return result;
}

function blockRange(doc: PMNode, pos: number) {
  const $pos = doc.resolve(Math.min(pos, doc.content.size));
  for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).isTextblock) return { from: $pos.start(d), to: $pos.end(d) };
  return null;
}

/**
 * For pasting. A copied passage loses its comment marks (the comment stays on the original); a cut one keeps them
 * (its comment moves with the text), because after a cut its id is no longer in the document.
 */
export function stripCommentMarks(slice: Slice, doc: PMNode): Slice {
  // A pasted copy must not carry an id that the page already has: comment highlights and `sel` ranges alike.
  const present = new Set<string>(commentRanges(doc).keys());
  doc.descendants((n) => { n.marks.forEach((m) => { if (m.type.name === RANGE_MARK) present.add(m.attrs.id); }); });
  const carries = (m: { type: { name: string }; attrs: Record<string, unknown> }) =>
    (m.type.name === "comment" || m.type.name === RANGE_MARK) && present.has(m.attrs.id as string);
  const strip = (frag: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    frag.forEach((n) => {
      if (n.isInline) nodes.push(n.mark(n.marks.filter((m) => !carries(m))));
      else nodes.push(n.copy(strip(n.content)));
    });
    return Fragment.from(nodes);
  };
  return new PMSlice(strip(slice.content), slice.openStart, slice.openEnd);
}
