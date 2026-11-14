import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const freshKey = new PluginKey<DecorationSet>("freshText");

/** Meta on a transaction: `{ add: [{ from, to }, …] }` marks those ranges as just arrived, `{ clear: true }` forgets them. */
export type FreshMeta = { add: { from: number; to: number }[] } | { clear: true };

/**
 * Text that arrived from outside (a hand edit, the loop) is wrapped in `.fresh`, which CSS fades in. Decorations only:
 * nothing here is part of the document or the markdown.
 */
export const freshText = Extension.create({
  name: "freshText",
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: freshKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            set = set.map(tr.mapping, tr.doc);
            const meta = tr.getMeta(freshKey) as FreshMeta | undefined;
            if (!meta) return set;
            if ("clear" in meta) return DecorationSet.empty;
            const decos = meta.add.filter((r) => r.from < r.to).map((r) => Decoration.inline(r.from, r.to, { class: "fresh" }));
            return decos.length ? set.add(tr.doc, decos) : set;
          },
        },
        props: { decorations: (state) => freshKey.getState(state) },
      }),
    ];
  },
});

/** The text currently flagged as fresh, for tests. */
export const freshTexts = (state: EditorState) =>
  (freshKey.getState(state) ?? DecorationSet.empty).find().map((d) => state.doc.textBetween(d.from, d.to, "\n"));
