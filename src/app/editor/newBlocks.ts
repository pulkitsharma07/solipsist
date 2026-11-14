import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

export const newBlockKey = new PluginKey<DecorationSet>("newBlocks");
/** The new block whose line the pointer is on (where it starts), or null: it shows the line's delete cross. */
export const lineHoverKey = new PluginKey<number | null>("newBlockLineHover");
/** The cross: how far down from the block's top it reaches, and where it starts right of the page's text column. */
const CROSS_PX = 20;
const CROSS_FROM_PAD = -2;

/** Meta on a transaction: `{ add: [{ from, to }, …] }` flags the top-level blocks those ranges touch as new. */
export type NewBlocksMeta = { add: { from: number; to: number }[] };

/** The new block at `pos`: its start and end, or null when there is none there. */
function newBlockAt(state: EditorState, pos: number) {
  const d = (newBlockKey.getState(state) ?? DecorationSet.empty).find(pos, pos).find((x) => x.from === pos);
  return d ? { from: d.from, to: d.to } : null;
}

/** Deletes the new block that starts at `pos`, as the writer's own edit (saved, and undone with Undo). */
export function deleteNewBlock(view: EditorView, pos: number): boolean {
  const block = newBlockAt(view.state, pos);
  if (!block) return false;
  view.dispatch(view.state.tr.delete(block.from, block.to).setMeta(lineHoverKey, null).scrollIntoView());
  return true;
}

/**
 * Where the pointer is on a new block's line: the block's start, and whether it is on the cross at the line's top.
 * The line is the block's `::after`, drawn in the page's margin right of the block, so an event on the block element
 * right of its own box is on the line.
 */
function onLine(view: EditorView, e: MouseEvent): { pos: number; onCross: boolean } | null {
  const el = (e.target as HTMLElement | null)?.closest?.(".new-block");
  if (!(el instanceof HTMLElement) || !view.dom.contains(el)) return null;
  const rect = el.getBoundingClientRect();
  if (e.clientX <= rect.right) return null;
  const pos = view.posAtDOM(el, 0) - 1;
  const start = view.state.doc.resolve(Math.max(0, Math.min(pos, view.state.doc.content.size))).before(1);
  if (!newBlockAt(view.state, start)) return null;
  // The cross sits just right of the line, past the page's padding (`--pad-x`, which the block inherits).
  const padX = parseFloat(getComputedStyle(el).getPropertyValue("--pad-x")) || 80;
  return { pos: start, onCross: e.clientY - rect.top <= CROSS_PX && e.clientX >= rect.right + padX + CROSS_FROM_PAD };
}

/**
 * Blocks that arrived from outside carry `.new-block`, which draws a slim green line on the right edge of the page.
 * The line stays until the writer types in the block (or it goes). Hovering the line shows a small cross at its top
 * that deletes the block. Decorations only: nothing here is part of the document or the markdown.
 */
export const newBlocks = Extension.create({
  name: "newBlocks",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: newBlockKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            if (tr.docChanged && !tr.getMeta("solipRemote")) {
              // The writer edited: a block they typed in is theirs now.
              const touched: { from: number; to: number }[] = [];
              tr.mapping.maps.forEach((map, i) => {
                const rest = tr.mapping.slice(i + 1);
                map.forEach((_a, _b, from, to) => touched.push({ from: rest.map(from, -1), to: rest.map(to, 1) }));
              });
              // Only a change inside a block edits it. One at the edge between two blocks removed or added whole blocks
              // (the cross, a block cut or pasted), and the blocks either side keep their line.
              const gone = set.find().filter((d) => touched.some((t) => t.from < d.to && t.to > d.from));
              if (gone.length) set = set.remove(gone);
            }
            const meta = tr.getMeta(newBlockKey) as NewBlocksMeta | undefined;
            if (!meta) return set;
            const have = new Set(set.find().map((d) => d.from));
            const decos: Decoration[] = [];
            for (const r of meta.add) {
              if (r.from >= r.to) continue;
              tr.doc.nodesBetween(r.from, r.to, (node, pos, parent) => {
                if (parent !== tr.doc) return false;
                if (!have.has(pos)) { have.add(pos); decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "new-block" })); }
                return false;
              });
            }
            return decos.length ? set.add(tr.doc, decos) : set;
          },
        },
        props: { decorations: (state) => newBlockKey.getState(state) },
      }),
      new Plugin<number | null>({
        key: lineHoverKey,
        state: {
          init: () => null,
          apply(tr, hover) {
            const meta = tr.getMeta(lineHoverKey) as number | null | undefined;
            if (meta !== undefined) return meta;
            if (hover === null || !tr.docChanged) return hover;
            const mapped = tr.mapping.mapResult(hover, 1);
            return mapped.deleted ? null : mapped.pos;
          },
        },
        props: {
          decorations(state) {
            const hover = lineHoverKey.getState(state);
            const block = hover === null || hover === undefined ? null : newBlockAt(state, hover);
            return block ? DecorationSet.create(state.doc, [Decoration.node(block.from, block.to, { class: "new-block-hover" })]) : null;
          },
          handleDOMEvents: {
            mousemove(view, e) {
              const at = onLine(view, e)?.pos ?? null;
              if (at !== lineHoverKey.getState(view.state)) view.dispatch(view.state.tr.setMeta(lineHoverKey, at).setMeta("addToHistory", false));
              return false;
            },
            mouseleave(view) {
              if (lineHoverKey.getState(view.state) !== null) view.dispatch(view.state.tr.setMeta(lineHoverKey, null).setMeta("addToHistory", false));
              return false;
            },
            mousedown(view, e) {
              const at = onLine(view, e);
              if (!at?.onCross || e.button !== 0) return false;
              e.preventDefault(); // keep the caret where it is
              return deleteNewBlock(view, at.pos);
            },
          },
        },
      }),
    ];
  },
});

/** The text of the blocks currently flagged as new, for tests. */
export const newBlockTexts = (state: EditorState) =>
  (newBlockKey.getState(state) ?? DecorationSet.empty).find().map((d) => state.doc.textBetween(d.from, d.to, "\n"));
