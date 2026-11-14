import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { BUTTON_EVERY, everyLabel, markerSpots, markersIn, nextRunAt, pressButton, removeButton, setRangeAttrs, type TaskRecord } from "../../shared/docfile";
import { pluginFor } from "../../shared/plugin";
import { openInstruction } from "./instructionInput";
import { openPopup, type OpenPopup } from "./markers/popup";
import { DECISION_META, suggestionKey } from "./suggestions";

/**
 * The button of a task the writer accepted as a button, for a marker at `:btn`: on its
 * own line above the text the marker is around. Pressing it runs the request again with the instruction it has (no
 * input: the button is the instruction, kept): the task goes back to pending, and its next result goes straight into
 * the page. On hover: `✎` changes the instruction, `⏱` sets how often it runs on its own, `×` takes the button off and
 * leaves the text.
 *
 * A schedule (`button.every` in the record) is run by the server (`src/server/agent/schedules.ts`), page open or not; a
 * tab only shows it, and the change arrives like any other. A run that ends on a card (a decline, text changed
 * meanwhile) waits for the writer, and the schedule with it.
 */
interface State { hover: string | null; records: Record<string, TaskRecord>; decos: DecorationSet }
const key = new PluginKey<State>("taskButtons");

/** What the page does when the writer sets a button's schedule: `every` ms (one of `BUTTON_EVERY`), or null for off. */
export type OnSchedule = (task: string, every: number | null) => void;

/** Runs the task of button `id` again: the writer pressed it. */
function run(view: EditorView, id: string) {
  if (!markerSpots(view.state.doc, id)) return;
  const tr = view.state.tr;
  pressButton(tr, id);
  view.dispatch(tr.setMeta(DECISION_META, { id, decision: "asked_again" }));
}

const control = (label: string, className: string, title: string, onClick: (el: HTMLButtonElement) => void) => {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = className;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => onClick(b));
  return b;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** `✎`: the instruction input, filled in; Enter keeps the new instruction (it doesn't run: the button does that). */
function editInstruction(view: EditorView, id: string, taskType: string, instruction: string | undefined, anchor: HTMLElement) {
  const plugin = pluginFor(taskType);
  openInstruction(anchor, {
    label: plugin?.inputLabel ?? plugin?.title ?? "Instruction",
    initial: instruction ?? "",
    required: plugin?.instruction === "required",
    onSubmit: (text) => {
      if (text === (instruction ?? "") || !markerSpots(view.state.doc, id)) return;
      const tr = view.state.tr;
      setRangeAttrs(tr, id, { instruction: text || null });
      view.dispatch(tr);
    },
    onClose: () => { if (!view.isDestroyed) view.focus(); },
  });
}

/** `⏱`'s menu: off, or one of the schedules, the current one ticked. Exported for FEATURES.html. */
export function scheduleMenu(id: string, every: number | undefined, onPick: (every: number | null) => void): HTMLElement {
  const list = document.createElement("div");
  list.className = "sug-more task-schedule-menu";
  list.dataset.taskButton = id;
  list.setAttribute("role", "menu");
  const head = document.createElement("p");
  head.className = "sug-menu-note task-schedule-note";
  head.textContent = "Runs on its own, even with this page closed, and each result goes straight into the page.";
  list.append(head);
  for (const ms of [null, ...BUTTON_EVERY]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sug-menu-item";
    item.setAttribute("role", "menuitemradio");
    const on = (every ?? null) === ms;
    item.setAttribute("aria-checked", String(on));
    item.dataset.every = String(ms ?? "off");
    const label = document.createElement("span");
    label.className = "sug-menu-label";
    label.textContent = `${on ? "✓ " : ""}${ms === null ? "Only when pressed" : everyLabel(ms).replace(/^every/, "Every")}`;
    item.append(label);
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => onPick(ms));
    list.append(item);
  }
  return list;
}

let schedulePopup: OpenPopup | null = null;

/** The button, for task `id`: what it says is what it will ask for; with its schedule, if it has one. */
export function buttonFor(view: EditorView | null, id: string, taskType: string, instruction: string | undefined, record?: TaskRecord, onSchedule?: OnSchedule | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "task-button";
  el.contentEditable = "false";
  el.dataset.taskButton = id;
  const hover = (to: string | null) => () => { if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, { hover: to }).setMeta("addToHistory", false)); };
  el.addEventListener("mouseenter", hover(id));
  el.addEventListener("mouseleave", hover(null));
  const every = record?.button?.every;
  el.append(control(`↻ ${instruction ?? "Run again"}`, "task-btn task-press", "Run this request again: the result goes straight into the page", () => {
    if (view) { run(view, id); view.focus(); }
  }));
  // A schedule shows without hovering: the writer can see the page changes on its own.
  if (every) {
    const chip = document.createElement("span");
    chip.className = "task-every";
    chip.textContent = `⏱ ${everyLabel(every)}`;
    const next = nextRunAt(record);
    chip.title = `Runs on its own ${everyLabel(every)}, even with this page closed${next ? `; next at ${clock(Math.max(next, Date.now()))}` : ""}.`;
    el.append(chip);
  }
  el.append(
    control("✎", "task-btn ghost task-edit", "Change the instruction", (b) => { if (view) editInstruction(view, id, taskType, instruction, b); }),
  );
  if (onSchedule) {
    el.append(control("⏱", "task-btn ghost task-schedule", "Run on a schedule", (b) => {
      if (schedulePopup) { schedulePopup.close(); return; }
      const popup = openPopup(b, scheduleMenu(id, every, (ms) => { schedulePopup?.close(); onSchedule(id, ms); }), () => { if (schedulePopup === popup) schedulePopup = null; });
      schedulePopup = popup;
    }));
  }
  el.append(control("×", "task-btn ghost task-remove", "Remove this button and keep the text", () => {
    if (!view) return;
    const tr = view.state.tr;
    removeButton(tr, id);
    view.dispatch(tr);
    view.focus();
  }));
  return el;
}

/** Where a button goes: above the block its text is in, or above the whole list or table when its text runs across one. */
function spotFor(doc: PMNode, from: number, to: number) {
  const $from = doc.resolve(from);
  let depth = $from.sharedDepth(to);
  const shared = depth ? $from.node(depth).type.name : "doc";
  if (shared === "tableRow") depth -= 1;
  else if (["doc", "listItem", "taskItem", "tableCell", "tableHeader"].includes(shared)) depth += 1;
  return $from.before(depth);
}

/** The buttons in `doc` (each once): their task, type and instruction. */
function buttonsIn(doc: PMNode) {
  const seen = new Set<string>();
  return markersIn(doc).filter((m) => m.state === "btn" && !seen.has(m.id) && !!seen.add(m.id));
}

function decorations(doc: PMNode, hover: string | null, records: Record<string, TaskRecord>, onSchedule: OnSchedule | null): DecorationSet {
  const decos: Decoration[] = [];
  for (const m of buttonsIn(doc)) {
    const pieces = markerSpots(doc, m.id)?.pieces ?? [];
    if (!pieces.length) continue;
    const record = records[m.id];
    const widgetKey = `btn-${m.id}-${m.instruction ?? ""}-${record?.button?.every ?? ""}-${record?.finished ?? ""}`;
    decos.push(Decoration.widget(spotFor(doc, pieces[0]!.from, pieces[pieces.length - 1]!.to), (view) => buttonFor(view, m.id, m.taskType, m.instruction, record, onSchedule), { key: widgetKey, side: -1, ignoreSelection: true, stopEvent: () => true }));
    if (hover === m.id) for (const p of pieces) decos.push(Decoration.inline(p.from, p.to, { class: "task-button-hover" }));
  }
  return DecorationSet.create(doc, decos);
}

const recordsOf = (state: EditorState) => suggestionKey.getState(state)?.records ?? {};

export const taskButtons = Extension.create<{ onSchedule: OnSchedule | null }>({
  name: "taskButtons",
  addOptions: () => ({ onSchedule: null }),
  addProseMirrorPlugins() {
    const onSchedule = this.options.onSchedule;
    return [
      new Plugin<State>({
        key,
        state: {
          init: (_, state) => ({ hover: null, records: recordsOf(state), decos: decorations(state.doc, null, recordsOf(state), onSchedule) }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(key) as { hover: string | null } | undefined;
            const hover = meta ? meta.hover : prev.hover;
            const records = recordsOf(state);
            return tr.docChanged || hover !== prev.hover || records !== prev.records ? { hover, records, decos: decorations(tr.doc, hover, records, onSchedule) } : prev;
          },
        },
        props: { decorations: (state) => key.getState(state)?.decos },
        view: () => ({ destroy: () => { schedulePopup?.close(); } }),
      }),
    ];
  },
});
