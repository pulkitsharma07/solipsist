import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { newTaskId, POINT_NODE, RANGE_MARK } from "../../shared/docfile";
import { plugins, targetOf, type TaskTypePlugin } from "../../shared/plugin";
import { askingRange, openInstruction, selectionAnchor, setAsking } from "./instructionInput";
import { imageTarget } from "./imageTargets";
import { openPopup } from "./markers/popup";

/** Ids of every marker in the page, of any task type: one id space, so no two markers share an id. */
export function taskIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === POINT_NODE) ids.push(n.attrs.id);
    for (const m of n.marks) if (m.type.name === RANGE_MARK) ids.push(m.attrs.id);
  });
  return ids;
}

/** Puts a point marker of `taskType` at the caret (written to the markdown as `<!-- type:abc -->`). */
export function insertPoint(editor: Editor, taskType: string) {
  return editor.chain().insertContent({ type: POINT_NODE, attrs: { taskType, id: newTaskId(taskIds(editor)) } }).run();
}

const isCode = (n: PMNode) => n.marks.some((m) => m.type.spec.code);

/**
 * Whether a range's comments at `from`..`to` would land inside inline code, where they are read back as text: a
 * boundary inside a code span, or a block whose part of the range is all code, give or take whitespace (each block
 * gets its own pair of comments, and around code alone they end up inside the backticks once the page is read back).
 * Code spans the range only contains are fine.
 */
function splitsCode(doc: PMNode, from: number, to: number): "inside" | "alone" | null {
  const inside = (pos: number) => { const $p = doc.resolve(pos); return !!$p.nodeBefore && !!$p.nodeAfter && isCode($p.nodeBefore) && isCode($p.nodeAfter); };
  if (inside(from) || inside(to)) return "inside";
  let allCode = false;
  doc.nodesBetween(from, to, (n, pos) => {
    if (!n.isTextblock) return true;
    // Whitespace doesn't count: markdown leaves it outside the comments, so code and a space are code alone.
    let any = false, code = true;
    n.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (start + child.nodeSize <= from || start >= to) return;
      if (child.isText && !isCode(child) && !child.text!.slice(Math.max(0, from - start), to - start).trim()) return;
      any = true;
      if (!child.isText || !isCode(child)) code = false;
    });
    if (any && code) allCode = true;
    return false;
  });
  return allCode ? "alone" : null;
}

/**
 * Why `from`..`to` can't become a range, in words for the writer, or null when it can: some of it must hold the mark,
 * none may be in a code block or put its comments inside inline code (`splitsCode`: they would be read back as text),
 * and none may be in a range already (no nesting).
 */
export function whyNotRange(editor: Editor, from: number, to: number): string | null {
  const { state } = editor;
  const type = state.schema.marks[RANGE_MARK]!;
  if (from >= to) return "Select some text first.";
  if (state.doc.rangeHasMark(from, to, type)) return "Part of this is already being asked about. Accept, reject or remove that request first.";
  let codeBlock = false;
  state.doc.nodesBetween(from, to, (n) => { if (n.type.spec.code) codeBlock = true; });
  if (codeBlock) return "A request can't include a code block.";
  const code = splitsCode(state.doc, from, to);
  if (code === "inside") return "A request can't start or end inside inline code. Select the whole code span.";
  if (code === "alone") return "A request can't be about inline code alone. Include some of the text around it.";
  if (!state.tr.addMark(from, to, type.create({ kind: "x", id: "xxx" })).doc.rangeHasMark(from, to, type)) return "This selection can't hold a request.";
  return null;
}

/** Whether `from`..`to` can become a range (`whyNotRange`). */
export const canMarkRange = (editor: Editor, from: number, to: number) => whyNotRange(editor, from, to) === null;

/** Says under the selection why it can't become a range; it goes after a few seconds, on a click or on Escape. */
function refuseRange(editor: Editor, why: string) {
  const { from, to } = editor.state.selection;
  const el = document.createElement("p");
  el.className = "task-refusal";
  el.setAttribute("role", "alert");
  el.textContent = why;
  const popup = openPopup(selectionAnchor(editor.view, from, to), el);
  setTimeout(() => popup.close(), 5000);
}

/**
 * Makes `from`..`to` (default: the selection) a range marker of `taskType`, with `instruction` if one is given
 * (written as `<!-- type:abc "instruction" -->…<!-- /type:abc -->`), and puts the caret after it. Text that already
 * sits in a range, of any task type, is left alone; so is code, which can't hold the mark.
 */
export function markRange(editor: Editor, taskType: string, instruction?: string, at: { from: number; to: number } = editor.state.selection): boolean {
  const { from, to } = at;
  if (!canMarkRange(editor, from, to)) return true;
  editor.chain().setTextSelection({ from, to }).setMark(RANGE_MARK, { taskType, id: newTaskId(taskIds(editor)), instruction: instruction || null }).setTextSelection(to).run();
  return true;
}

/**
 * The key of a range task type that takes an instruction, on a selection (or on `at`, the image it is on): the input opens
 * under it. Enter makes the range, with what was typed if anything; Escape or a click elsewhere makes nothing and
 * gives the selection back.
 */
export function askForRange(editor: Editor, plugin: TaskTypePlugin, at: { from: number; to: number } = editor.state.selection): boolean {
  const view = editor.view;
  const { from, to } = at;
  setAsking(view, { from, to });
  openInstruction(selectionAnchor(view, from, to), {
    label: plugin.inputLabel ?? plugin.title,
    required: plugin.instruction === "required",
    onSubmit: (text) => {
      const at = askingRange(view);
      if (at) markRange(editor, plugin.taskType, text, at);
    },
    onClose: (submitted) => {
      if (view.isDestroyed) return;
      const at = askingRange(view);
      const tr = view.state.tr.setMeta("addToHistory", false);
      if (!submitted && at) tr.setSelection(TextSelection.create(tr.doc, at.from, at.to));
      view.dispatch(tr);
      setAsking(view, null);
      view.focus();
    },
  });
  return true;
}

/** Makes a range of `plugin`'s task type over `at`, asking for the instruction first if the task type takes one, or says why not. */
export function startRange(editor: Editor, plugin: TaskTypePlugin, at: { from: number; to: number }): boolean {
  const why = whyNotRange(editor, at.from, at.to);
  if (why) { refuseRange(editor, why); return true; }
  return (plugin.instruction ?? "none") === "none" ? markRange(editor, plugin.taskType, undefined, at) : askForRange(editor, plugin, at);
}

/**
 * The keys the plugins ask for, and what each acts on (`targetOf`). At a caret a key makes the marker of the
 * point plugin that has it; on a selection that holds one image, that of the image plugin (`img`); on any other
 * selection, that of the text range plugin (`sel`). Mod-. is all three. A task type that takes an instruction asks for it
 * first. A selection that can't be a range (code, or text already in one) gets a note under it saying why.
 */
export const markerKeys = Extension.create<{ canAsk: () => boolean; onCannotAsk: () => void }>({
  name: "markerKeys",
  addOptions: () => ({ canAsk: () => true, onCannotAsk: () => {} }),
  addKeyboardShortcuts() {
    const { canAsk, onCannotAsk } = this.options;
    const keys = new Set(plugins().flatMap((p) => p.keys ?? []));
    return Object.fromEntries([...keys].map((key) => [key, ({ editor }: { editor: Editor }) => {
      if (!canAsk()) { onCannotAsk(); return true; }
      const forKey = (target: string) => plugins().find((p) => targetOf(p) === target && p.keys?.includes(key));
      const image = imageTarget(editor.state);
      if (image) {
        const imagePlugin = forKey("image");
        if (imagePlugin) return startRange(editor, imagePlugin, image);
      }
      if (editor.state.selection.empty) {
        const point = forKey("point");
        return point ? insertPoint(editor, point.taskType) : false;
      }
      const plugin = forKey("text");
      return plugin ? startRange(editor, plugin, editor.state.selection) : false;
    }]));
  },
});
