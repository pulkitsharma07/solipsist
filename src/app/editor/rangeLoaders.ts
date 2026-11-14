import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { asState, RANGE_MARK, type TaskState } from "../../shared/docfile";
import { pluginFor } from "../../shared/plugin";
import { openRangeInstruction } from "./instructionInput";
import { createLoader, type Loader } from "./markers/loader";

const key = new PluginKey<DecorationSet>("rangeLoaders");

/** Every range marker in the page: its task type, where its last piece of text ends, and its state. */
function ranges(doc: PMNode) {
  const found = new Map<string, { taskType: string; end: number; state: TaskState }>();
  doc.descendants((node, pos) => {
    for (const m of node.marks) if (m.type.name === RANGE_MARK) found.set(m.attrs.id, { taskType: m.attrs.taskType, end: pos + node.nodeSize, state: asState(m.attrs.state) });
  });
  return found;
}

/** What is showing after a range: a wrapper in the page, and the loader inside it. */
interface Shown { wrap: HTMLElement; loader: Loader; taskType: string }

/**
 * A loader right after the last piece of text of each range, for as long as the range is in the page.
 *
 * ProseMirror rebuilds a widget whenever the text before it is rebuilt, and a range whose state changes is exactly
 * that (its element changes). So the element lives here, per id: the widget hands the same element back each time,
 * and the loader inside it changes state in place, which is what lets the change animate.
 */
function widgets(doc: PMNode, shown: Map<string, Shown>, view: () => EditorView): DecorationSet {
  return DecorationSet.create(doc, [...ranges(doc)].map(([id, { taskType, end, state }]) =>
    Decoration.widget(end, () => {
      let s = shown.get(id);
      if (!s || s.taskType !== taskType) {
        s?.loader.destroy();
        const wrap = document.createElement("span");
        wrap.className = "task-range-loader";
        wrap.contentEditable = "false";
        wrap.dataset.taskType = taskType;
        wrap.dataset.id = id;
        // A task type that takes an instruction shows it on a click: to change while it waits, to read while it is worked on.
        const takes = (pluginFor(taskType)?.instruction ?? "none") !== "none";
        const loader = createLoader(taskType, id, state, takes ? (el, _state, closed) => openRangeInstruction(view(), id, el, closed) : undefined);
        wrap.append(loader.el);
        shown.set(id, (s = { wrap, loader, taskType }));
      }
      s.loader.setState(state, { live: true });
      return s.wrap;
    }, // The key is the id alone, not the position or the state: when text above moves the widget, ProseMirror keeps it.
    // `marks: []` puts it outside the range's own element rather than inside it.
    { side: -1, key: `ph-${id}`, marks: [], ignoreSelection: true, stopEvent: () => true })));
}

export const rangeLoaders = Extension.create({
  name: "rangeLoaders",
  addProseMirrorPlugins() {
    const shown = new Map<string, Shown>(); // per editor: ids repeat across pages
    const view = () => this.editor.view;
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, { doc }) => widgets(doc, shown, view),
          apply: (tr, set) => (tr.docChanged ? widgets(tr.doc, shown, view) : set),
        },
        props: { decorations: (state) => key.getState(state) },
        view: () => ({
          update: (view, prev) => {
            if (view.state.doc === prev.doc) return;
            const now = ranges(view.state.doc);
            for (const [id, { state }] of now) shown.get(id)?.loader.setState(state, { live: true });
            // A range that is gone takes its loader (and any popup) with it.
            for (const [id, s] of shown) if (!now.has(id)) { s.loader.destroy(); shown.delete(id); }
          },
          destroy: () => { shown.forEach((s) => s.loader.destroy()); shown.clear(); },
        }),
      }),
    ];
  },
});
