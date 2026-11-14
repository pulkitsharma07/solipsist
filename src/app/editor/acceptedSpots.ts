import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markerSpots, type Decision } from "../../shared/docfile";
import { DECISION_META } from "./suggestions";

/**
 * Where the result of each suggestion the writer accepted landed, while the page is open: its marker is gone, so this
 * is what the agent's margin note sits level with afterwards (`AgentNotes`, "Accepted"), for as long as the page is
 * open. A spot follows the edits around it, and goes when its text is deleted or an Undo brings the suggestion back.
 * It draws only an empty anchor, `[data-accepted]`.
 */
type Spots = ReadonlyMap<string, { from: number; to: number }>;
const key = new PluginKey<{ spots: Spots; decos: DecorationSet }>("acceptedSpots");

/** The tasks a transaction accepted, from its decision meta (one, or several for Accept all). */
const acceptedIn = (tr: Transaction) => {
  const meta = tr.getMeta(DECISION_META) as { id: string; decision: Decision } | { id: string; decision: Decision }[] | undefined;
  return [meta ?? []].flat().filter((d) => d.decision === "accepted").map((d) => d.id);
};

function apply(tr: Transaction, prev: Spots): Spots {
  const accepted = acceptedIn(tr);
  if (!tr.docChanged && !accepted.length) return prev;
  const next = new Map<string, { from: number; to: number }>();
  for (const [id, s] of prev) {
    const from = tr.mapping.map(s.from, 1), to = tr.mapping.map(s.to, -1);
    // Gone with its text, or waiting again (an Undo of the Accept).
    if (from < to && !markerSpots(tr.doc, id)) next.set(id, { from, to });
  }
  for (const id of accepted) {
    const was = markerSpots(tr.before, id);
    // A task kept as a button is still in the page: its button carries its note.
    if (!was || markerSpots(tr.doc, id)) continue;
    const a = was.points[0] ?? was.pieces[0]!.from;
    const b = was.points.length ? a + 1 : was.pieces[was.pieces.length - 1]!.to;
    const from = tr.mapping.map(a, -1), to = tr.mapping.map(b, 1);
    if (from < to) next.set(id, { from, to });
  }
  return next;
}

const anchor = (id: string) => () => {
  const el = document.createElement("span");
  el.className = "task-accepted";
  el.dataset.accepted = id;
  el.setAttribute("aria-hidden", "true");
  return el;
};

export const acceptedSpots = Extension.create({
  name: "acceptedSpots",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => ({ spots: new Map() as Spots, decos: DecorationSet.create(doc, []) }),
          apply(tr, prev) {
            const spots = apply(tr, prev.spots);
            if (spots === prev.spots) return prev;
            return { spots, decos: DecorationSet.create(tr.doc, [...spots].map(([id, s]) => Decoration.widget(s.from, anchor(id), { key: `accepted-${id}`, side: -1, marks: [], ignoreSelection: true }))) };
          },
        },
        props: { decorations: (state) => key.getState(state)?.decos },
      }),
    ];
  },
});
