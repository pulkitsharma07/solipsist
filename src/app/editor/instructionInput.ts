import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { asInstruction, markerSpots, RANGE_MARK, setRangeAttrs } from "../../shared/docfile";
import { pluginFor } from "../../shared/plugin";
import { openPopup, type OpenPopup, type PopupAnchor } from "./markers/popup";

/**
 * The instruction of a range task type that takes one (`TaskTypePlugin.instruction`, `sel`): the writer selects text,
 * presses the task type's key, and says in a line what they want. Also how they change it while it waits, see it while it
 * is worked on, and change it when they ask again.
 */

/** Longer than this is not an instruction: the comment is one line of the file. */
export const MAX_INSTRUCTION = 500;

export interface InstructionBoxOptions {
  label: string;
  initial?: string;
  /** Enter with nothing typed is refused. */
  required?: boolean;
  /** Shows the instruction without letting it change (a run is working on it). */
  readOnly?: boolean;
  onSubmit?(instruction: string): void;
}

/** A brief shake: the key or the Enter did nothing, and this is why it looked like nothing happened. */
export function refuse(el: HTMLElement) {
  el.classList.remove("task-refused");
  void el.offsetWidth; // restart the animation
  el.classList.add("task-refused");
  setTimeout(() => el.classList.remove("task-refused"), 400);
}

/** The input: one line that grows as it wraps. Enter submits, Shift+Enter too (an instruction is one line). */
export function instructionBox(opts: InstructionBoxOptions): { el: HTMLElement; field: HTMLTextAreaElement } {
  const el = document.createElement("div");
  el.className = "task-ask";
  const field = document.createElement("textarea");
  field.rows = 1;
  field.maxLength = MAX_INSTRUCTION;
  field.placeholder = opts.label;
  field.setAttribute("aria-label", opts.label);
  field.value = opts.initial ?? "";
  field.readOnly = !!opts.readOnly;
  field.spellcheck = true;
  const grow = () => { field.style.height = "auto"; field.style.height = `${field.scrollHeight}px`; };
  field.addEventListener("input", () => {
    if (/[\r\n]/.test(field.value)) field.value = field.value.replace(/\s*[\r\n]+\s*/g, " ");
    grow();
  });
  field.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (opts.readOnly) return;
    const text = field.value.trim();
    if (opts.required && !text) return refuse(el);
    opts.onSubmit?.(text);
  });
  el.append(field);
  if (opts.readOnly) el.classList.add("read-only");
  queueMicrotask(grow);
  return { el, field };
}

/** Opens the input under `anchor`. `onClose(submitted)` runs once, however it closes (Enter, Escape, a click away). */
export function openInstruction(anchor: PopupAnchor, opts: InstructionBoxOptions & { onClose?(submitted: boolean): void }): OpenPopup {
  let submitted = false;
  let popup: OpenPopup;
  const { el, field } = instructionBox({
    ...opts,
    onSubmit: (text) => { submitted = true; opts.onSubmit?.(text); popup.close(); },
  });
  popup = openPopup(anchor, el, () => opts.onClose?.(submitted));
  field.focus();
  if (!opts.readOnly) field.setSelectionRange(field.value.length, field.value.length);
  return popup;
}

/** The text being asked about while the input is open, kept highlighted (the editor's own selection hides when it loses focus). */
const askingKey = new PluginKey<{ from: number; to: number } | null>("asking");

/** Where the selection `from`..`to` is on screen, for the input to sit under. */
export const selectionAnchor = (view: EditorView, from: number, to: number): PopupAnchor => ({
  isConnected: true,
  contains: () => false,
  getBoundingClientRect: () => {
    const a = view.coordsAtPos(from), b = view.coordsAtPos(to);
    const left = Math.min(a.left, b.left), bottom = Math.max(a.bottom, b.bottom);
    return new DOMRect(left, Math.min(a.top, b.top), Math.max(1, Math.abs(b.right - a.left)), bottom - Math.min(a.top, b.top));
  },
});

/** Marks the text being asked about (null: nothing is), without touching the history. */
export const setAsking = (view: EditorView, at: { from: number; to: number } | null) => view.dispatch(view.state.tr.setMeta(askingKey, at).setMeta("addToHistory", false));
/** The text being asked about, where it is now. */
export const askingRange = (view: EditorView) => askingKey.getState(view.state) ?? null;

/** The instruction range `id` has in `doc` ("" for none), or undefined when it isn't there. */
export const instructionOf = (doc: PMNode, id: string) => {
  let found: string | undefined;
  doc.descendants((n) => {
    if (found === undefined) for (const m of n.marks) if (m.type.name === RANGE_MARK && m.attrs.id === id) found = asInstruction(m.attrs.instruction) ?? "";
    return found === undefined;
  });
  return found;
};

/**
 * A click on the loader of a range whose task type takes an instruction: while it waits, the input, to change it (Enter
 * with nothing typed takes it off, unless the task type needs one); while a run works on it, the instruction, read only.
 * False when there is nothing to show, so the loader does what it would otherwise.
 */
export function openRangeInstruction(view: EditorView, id: string, anchor: HTMLElement, closed: () => void = () => {}): OpenPopup | null {
  const spots = markerSpots(view.state.doc, id);
  const plugin = spots && pluginFor(spots.taskType);
  if (!plugin || (plugin.instruction ?? "none") === "none") return null;
  const said = instructionOf(view.state.doc, id) ?? "";
  const state = view.state.doc.nodeAt(spots.pieces[0]!.from)?.marks.find((m) => m.type.name === RANGE_MARK && m.attrs.id === id)?.attrs.state;
  if (state === "ack") {
    if (!said) return null;
    return openInstruction(anchor, { label: plugin.inputLabel ?? plugin.title, initial: said, readOnly: true, onClose: closed });
  }
  if (state !== "pending") return null;
  return openInstruction(anchor, {
    label: plugin.inputLabel ?? plugin.title,
    initial: said,
    required: plugin.instruction === "required",
    onSubmit: (text) => {
      if (text === said || !markerSpots(view.state.doc, id)) return;
      const tr = view.state.tr;
      setRangeAttrs(tr, id, { instruction: text || null });
      view.dispatch(tr);
    },
    onClose: () => { closed(); if (!view.isDestroyed) view.focus(); },
  });
}

/**
 * Before a task runs again (Ask again, a button): the input under `anchor`, with the instruction it had, to change first.
 * Enter calls `ask` with what it says; Escape or a click away changes nothing. False for a task type that takes no instruction.
 */
export function openAskAgain(view: EditorView, taskType: string, id: string, anchor: HTMLElement | null, ask: (instruction: string | null) => void): boolean {
  const plugin = pluginFor(taskType);
  if (plugin?.shape !== "range" || (plugin.instruction ?? "none") === "none" || !anchor) return false;
  openInstruction(anchor, {
    label: plugin.inputLabel ?? plugin.title,
    initial: instructionOf(view.state.doc, id) ?? "",
    required: plugin.instruction === "required",
    onSubmit: (text) => ask(text || null),
    onClose: () => { if (!view.isDestroyed) view.focus(); },
  });
  return true;
}

/** The highlight on the text being asked about. */
export const instructionInput = Extension.create({
  name: "instructionInput",
  addProseMirrorPlugins() {
    return [
      new Plugin<{ from: number; to: number } | null>({
        key: askingKey,
        state: {
          init: () => null,
          apply(tr, prev) {
            const meta = tr.getMeta(askingKey) as { from: number; to: number } | null | undefined;
            if (meta !== undefined) return meta;
            if (!prev || !tr.docChanged) return prev;
            const from = tr.mapping.map(prev.from, 1), to = tr.mapping.map(prev.to, -1);
            return from < to ? { from, to } : null;
          },
        },
        props: {
          decorations: (state) => {
            const at = askingKey.getState(state);
            return at ? DecorationSet.create(state.doc, [Decoration.inline(at.from, at.to, { class: "task-asking" })]) : null;
          },
        },
      }),
    ];
  },
});
