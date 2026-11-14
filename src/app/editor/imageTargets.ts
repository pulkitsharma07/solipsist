import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { RANGE_MARK } from "../../shared/docfile";
import { plugins, targetOf } from "../../shared/plugin";
import { startRange } from "./markerCommands";
import { vimKey } from "./vim";
import { keyLabel } from "../keys";

/**
 * The image a request key would act on. An image task type (`TaskTypePlugin.subject === "image"`, the built-in `img`)
 * is asked about by selecting the image and pressing its key: in vim, `v` or `V` on the image's line; otherwise a
 * click on the image, or a drag over it. While the selection is on one, the page says so over it: the image gets a
 * dashed ring and a small hint in its corner, so the writer sees that the key is there without being told.
 *
 * `imageTarget` is what both sides read: the decorations here, and the key in `markerCommands.ts`.
 */

/** Whether any registered task type asks about images: without one, nothing is offered. */
const anyImageKind = () => plugins().some((p) => targetOf(p) === "image");

/**
 * The image the selection holds, as the range around it, or null. The selection must hold one image and nothing else
 * but spaces, so a selection of text that happens to have a picture in it is still a request about the text. An image
 * already in a marker is not a target: it is being asked about already.
 */
export function imageTarget(state: EditorState): { from: number; to: number } | null {
  let { from, to } = state.selection;
  if (from >= to) {
    // Vim's normal mode has a caret, not a selection: it is on the image when the image is the character after it.
    const vim = vimKey.getState(state);
    const after = state.selection.empty && vim?.on && vim.mode === "normal" ? state.selection.$from.nodeAfter : null;
    if (!after || after.type.name !== "image" || after.marks.some((m) => m.type.name === RANGE_MARK)) return null;
    return { from, to: from + after.nodeSize };
  }
  let found: { from: number; to: number } | null = null;
  let other = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (other) return false;
    if (!node.isInline) return true;
    if (node.isText) {
      // Only the part of the text inside the selection counts.
      if (node.text!.slice(Math.max(0, from - pos), to - pos).trim()) other = true;
      return false;
    }
    // A second image, or one the selection only covers part of (it can't), is not a single target.
    if (node.type.name !== "image" || found || pos < from || pos + node.nodeSize > to) other = true;
    else if (node.marks.some((m) => m.type.name === RANGE_MARK)) other = true;
    else found = { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return other ? null : found;
}

/**
 * The overlay over the image: it blurs the picture and puts the one thing to do in its centre, a button that asks
 * what to change (the same as the key). It sits against the block the image is in and takes no clicks but the
 * button's, so a click elsewhere on the image still selects it.
 */
function hint(at: { from: number; to: number }) {
  return (view: EditorView): HTMLElement => {
    const el = document.createElement("span");
    el.className = "img-hint";
    el.contentEditable = "false";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-primary img-hint-button";
    button.append("Change this image", Object.assign(document.createElement("kbd"), { textContent: keyLabel("Mod-.") }));
    // Keep the editor's selection (and focus) where it is: the button acts on the image the overlay is over.
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      const imagePlugin = plugins().find((p) => targetOf(p) === "image");
      const editor = (view as EditorView & { editor?: Editor }).editor;
      if (imagePlugin && editor) startRange(editor, imagePlugin, at);
    });
    el.append(button);
    return el;
  };
}

/**
 * Lays the overlay over the image's own box. It is placed against the block the image is in, which is a little taller
 * than the image, so the box is measured once the picture is there.
 */
function placeHint(view: { dom: Element }) {
  const el = view.dom.querySelector<HTMLElement>(".img-hint");
  const img = view.dom.querySelector<HTMLElement>("img.img-target");
  if (!el || !img) return;
  if (!img.offsetHeight) { img.addEventListener("load", () => placeHint(view), { once: true }); return; }
  el.style.left = `${img.offsetLeft}px`;
  el.style.top = `${img.offsetTop}px`;
  el.style.width = `${img.offsetWidth}px`;
  el.style.height = `${img.offsetHeight}px`;
}

/** The ring and the hint on the image the key would act on. */
export const imageTargets = Extension.create({
  name: "imageTargets",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          placeHint(view);
          return { update: () => placeHint(view) };
        },
        props: {
          decorations: (state) => {
            if (!anyImageKind()) return null;
            const at = imageTarget(state);
            if (!at) return null;
            // The hint is placed against the block the image is in, which is where the image's corner is.
            const block = state.doc.resolve(at.from).before();
            return DecorationSet.create(state.doc, [
              Decoration.node(block, state.doc.resolve(at.from).after(), { class: "img-target-block" }),
              Decoration.node(at.from, at.to, { class: "img-target" }),
              Decoration.widget(at.from, hint(at), { key: "img-hint", side: -1, marks: [], ignoreSelection: true, stopEvent: () => false }),
            ]);
          },
        },
      }),
    ];
  },
});
