import { Extension } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { BUTTON_BLOCKED, buttonBlocker, decide, findBlocks, markerSpots, markersIn, POINT_NODE, RANGE_MARK, setRangeAttrs, toEditorDoc, type Decision, type TaskRecord, type SuggestionEdit } from "../../shared/docfile";
import { openAskAgain } from "./instructionInput";
import { openPopup, type OpenPopup } from "./markers/popup";
import { pluginFor } from "../../shared/plugin";
import { sideCard } from "./sideCard";
import { keyLabel } from "../keys";

/**
 * Suggestions in the page: a marker at `:sug` whose result waits in its record.
 * The result is shown where it would go, as decorations only (nothing in the document): a green preview at a point or
 * after a range, and a range's text struck through when the result would replace it. Blocks elsewhere that it would
 * change (`edits`) are struck through in red, with what replaces them after them in green. Hovering any of it shows a
 * card in the margin beside it (`sideCard.ts`, kept in view however large the diff) with Accept, Reject, Ask again and
 * Chat (with the agent kept behind it); a click on it, or the keys, pin the card
 * until Escape or a click elsewhere. The keys act on the suggestion at the caret. A decision is the writer's own edit
 * (`decide`), saved like typing and undone with Undo; the transaction says which (`DECISION_META`), for the save.
 */
export const suggestionKey = new PluginKey<SuggestionState>("suggestions");

/** Meta on the transaction of a decision: `{ id, decision }`. */
export const DECISION_META = "solipSuggestion";

interface SuggestionState {
  /** The markers' records, from the file's block (the session sets them on every file it receives). */
  records: Record<string, TaskRecord>;
  /** The suggestion whose card is pinned open (a click on it, the keys); a hovered one shows its card meanwhile. */
  open: string | null;
  decos: DecorationSet;
}

type Meta = { records: Record<string, TaskRecord> } | { open: string | null };

/** One suggestion waiting in the page: where its marker is, and its record (none if the file has no record). */
export interface Suggestion {
  id: string;
  taskType: string;
  from: number;
  to: number;
  record: TaskRecord | null;
  /** A decline: a reason and no result. */
  declined: boolean;
  /** An answer to a question about the text: shown in the card, nothing to put in the page. */
  answered: boolean;
}

/** The suggestions in the page, in page order. */
export const suggestionsIn = (state: EditorState): Suggestion[] => findSuggestions(state.doc, suggestionKey.getState(state)?.records ?? {});

function findSuggestions(doc: PMNode, records: Record<string, TaskRecord>): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const p of markersIn(doc)) {
    if (p.state !== "sug" || seen.has(p.id)) continue;
    seen.add(p.id);
    const spots = markerSpots(doc, p.id);
    if (!spots) continue;
    const [from, to] = spots.points.length ? [spots.points[0]!, spots.points[0]! + 1] : [spots.pieces[0]!.from, spots.pieces[spots.pieces.length - 1]!.to];
    const record = records[p.id] ?? null;
    out.push({ id: p.id, taskType: p.taskType, from, to, record, declined: isDecline(record), answered: record?.answer !== undefined && record.status === "suggested" });
  }
  return out;
}

/** A decline, or a marker at `:sug` whose record is missing or holds no result: there is nothing to accept. */
const isDecline = (r: TaskRecord | null) => !r || r.status === "declined" || (r.suggestion === undefined && !r.edits?.length && r.answer === undefined);

/** The suggestion at `pos` (on its marker, or at either end of it), or null. */
export const suggestionAt = (state: EditorState, pos: number) => suggestionsIn(state).find((s) => s.from <= pos && pos <= s.to) ?? null;

/** The suggestion the keys act on: the one at the caret, else the one whose card is open. */
function current(state: EditorState): Suggestion | null {
  const open = suggestionKey.getState(state)?.open;
  return suggestionAt(state, state.selection.from) ?? suggestionsIn(state).find((s) => s.id === open) ?? null;
}

/**
 * Carries out the writer's decision on suggestion `id`, as one undoable edit. False when it isn't in the page. On an
 * ask again, `instruction` (if given) is the range's new instruction, null for none.
 */
export function decideSuggestion(view: EditorView, id: string, decision: Decision, instruction?: string | null): boolean {
  const s = suggestionsIn(view.state).find((x) => x.id === id);
  if (!s) return false;
  const tr = view.state.tr;
  if (!decide(tr, id, decision, s.record ?? {})) return false;
  if ((decision === "asked_again" || decision === "asked_for_button") && instruction !== undefined) setRangeAttrs(tr, id, { instruction: instruction || null });
  caretAt(tr, tr.mapping.map(s.to));
  view.dispatch(tr.setMeta(DECISION_META, { id, decision }).setMeta(suggestionKey, { open: null } satisfies Meta).scrollIntoView());
  return true;
}

/**
 * The caret goes where the decision was made. Deciding from the card, the caret is wherever the writer last put it
 * (the start of the page, often): scrolling it into view after the edit would throw them back there.
 */
function caretAt(tr: Transaction, pos: number) {
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, Math.min(pos, tr.doc.content.size))), -1));
}

/** Decides every suggestion in the page the same way, as one undoable edit. Returns how many. */
export function decideAll(view: EditorView, decision: "accepted" | "rejected"): number {
  const all = suggestionsIn(view.state);
  if (!all.length) return 0;
  const tr = view.state.tr;
  const done: { id: string; decision: Decision }[] = [];
  for (const s of all) if (decide(tr, s.id, decision, s.record ?? {})) done.push({ id: s.id, decision });
  caretAt(tr, tr.mapping.map(all[0]!.to));
  view.dispatch(tr.setMeta(DECISION_META, done).setMeta(suggestionKey, { open: null } satisfies Meta).scrollIntoView());
  return done.length;
}

/** Moves the caret to the next suggestion after it (`dir` 1) or the one before (-1), wrapping, and opens its card. */
export function goToSuggestion(view: EditorView, dir: 1 | -1): boolean {
  const all = suggestionsIn(view.state);
  if (!all.length) return false;
  const { from, to } = view.state.selection;
  const next = dir === 1 ? all.find((s) => s.from > to) ?? all[0]! : [...all].reverse().find((s) => s.to < from) ?? all[all.length - 1]!;
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(next.to)));
  view.dispatch(tr.setMeta(suggestionKey, { open: next.id } satisfies Meta).scrollIntoView());
  return true;
}

export const openSuggestion = (view: EditorView, id: string | null) => view.dispatch(view.state.tr.setMeta(suggestionKey, { open: id } satisfies Meta).setMeta("addToHistory", false));

/** Markdown drawn into `el` as the page would draw it; one paragraph as its inline content when `inline`. */
function drawMarkdown(el: HTMLElement, schema: Schema, markdown: string, inline: boolean) {
  try {
    const doc = toEditorDoc(schema, markdown);
    const ser = DOMSerializer.fromSchema(schema);
    const only = doc.childCount === 1 && doc.firstChild!.type.name === "paragraph" ? doc.firstChild! : null;
    el.append(ser.serializeFragment(inline && only ? only.content : doc.content));
  } catch {
    el.textContent = markdown;
  }
}

/** Markdown the suggestion would put in, drawn as the page would draw it: inline content in a span, blocks in a div. */
function preview(schema: Schema, id: string, markdown: string, place: TaskRecord["place"]): HTMLElement {
  const blocks = place === "blocks";
  const el = document.createElement(blocks ? "div" : "span");
  el.className = `sug-preview ${blocks ? "sug-blocks" : "sug-inline"}`;
  el.dataset.sug = id;
  el.contentEditable = "false";
  el.title = "Suggested: accept, reject or chat in the card beside it.";
  drawMarkdown(el, schema, markdown, !blocks);
  // Links in a preview are not followed: a click opens the card.
  el.querySelectorAll("a").forEach((a) => a.removeAttribute("href"));
  return el;
}

/** An answer to a question about the text: a chip after it; the answer is in the card. */
function answerChip(id: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "sug-chip sug-answer";
  el.dataset.sug = id;
  el.contentEditable = "false";
  el.textContent = "Answered";
  el.title = "Read the answer in the card beside it.";
  return el;
}

/** A decline, or a marker at `:sug` whose record is missing: a small muted chip. */
function declinedChip(id: string, record: TaskRecord | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "sug-declined";
  el.dataset.sug = id;
  el.contentEditable = "false";
  el.textContent = record?.note ? `Declined: ${record.note}` : "No suggestion";
  el.title = "Dismiss or Ask again in the card beside it.";
  return el;
}

/** A suggestion whose result is all changes elsewhere: a chip at its spot, saying where they are. */
function changesChip(id: string, where: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "sug-chip";
  el.dataset.sug = id;
  el.contentEditable = "false";
  el.textContent = `Changes suggested ${where}`;
  el.title = "Accept or reject in the card beside it.";
  return el;
}

/** What an edit does, in a few words: "Removes a table", "Changes 2 blocks". */
function describeEdit(schema: Schema, edit: SuggestionEdit): string {
  const NAMES: Record<string, string> = { paragraph: "a paragraph", heading: "a heading", table: "a table", bulletList: "a list", orderedList: "a list", taskList: "a list", codeBlock: "a code block", blockquote: "a quote", horizontalRule: "a rule", image: "an image" };
  let what = "blocks";
  try {
    const doc = toEditorDoc(schema, edit.before);
    what = doc.childCount === 1 ? NAMES[doc.firstChild!.type.name] ?? "a block" : `${doc.childCount} blocks`;
  } catch {}
  return `${edit.after.trim() ? "Changes" : "Removes"} ${what}`;
}

/** Opens the card on a click, without moving the caret. */
function clickable(el: HTMLElement, view: EditorView, id: string) {
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", () => openSuggestion(view, id));
  return el;
}

function decorations(doc: PMNode, records: Record<string, TaskRecord>): DecorationSet {
  const decos: Decoration[] = [];
  const schema = doc.type.schema;
  for (const s of findSuggestions(doc, records)) {
    const { id, record } = s;
    // ProseMirror keeps a widget whose key is unchanged: anything the widget draws from the record is in its key.
    const key = `sug-${id}-${JSON.stringify(record)}`;
    const spots = markerSpots(doc, id)!;
    const range = spots.pieces.length > 0;
    if (s.declined || !record) {
      decos.push(Decoration.widget(s.to, (view) => clickable(declinedChip(id, record), view, id), { key, side: 1, marks: [], ignoreSelection: true, stopEvent: () => true }));
      continue;
    }
    if (s.answered) {
      decos.push(Decoration.widget(s.to, (view) => clickable(answerChip(id), view, id), { key, side: 1, marks: [], ignoreSelection: true, stopEvent: () => true }));
      continue;
    }
    // Its changes elsewhere: the blocks struck through, and what replaces them after them. One the writer has changed
    // since can't be found: nothing shows for it, and the card says so.
    const found = (record.edits ?? []).map((e) => ({ e, at: findBlocks(doc, e.before) }));
    for (const [i, { e, at }] of found.entries()) {
      if (!at) continue;
      doc.nodesBetween(at.from, at.to, (node, pos) => { decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "sug-old-block", "data-sug": id })); return false; });
      if (e.after.trim()) decos.push(Decoration.widget(at.to, (view) => clickable(preview(schema, id, e.after, "blocks"), view, id), { key: `${key}-edit-${i}`, side: -1, ignoreSelection: true, stopEvent: () => true }));
    }
    if (record.suggestion === undefined) {
      // All of it is elsewhere: a chip here says where.
      const places = found.flatMap(({ at }) => (at ? [at.from < s.from ? "above" : "below"] : []));
      const where = places.length && places.every((p) => p === places[0]) ? places[0]! : "elsewhere";
      decos.push(Decoration.widget(s.to, (view) => clickable(changesChip(id, where), view, id), { key, side: 1, marks: [], ignoreSelection: true, stopEvent: () => true }));
      continue;
    }
    if (range && record.mode === "replace") for (const p of spots.pieces) decos.push(Decoration.inline(p.from, p.to, { class: "sug-old", "data-sug": id }));
    // Where it would go: at a point; after a range (after its block, for blocks).
    let at = s.to;
    if (range && record.place === "blocks" && record.mode === "after") at = doc.resolve(s.to).after();
    const suggested = record.suggestion;
    decos.push(Decoration.widget(at, (view) => clickable(preview(schema, id, suggested, record.place), view, id), { key, side: 1, marks: [], ignoreSelection: true, stopEvent: () => true }));
  }
  return DecorationSet.create(doc, decos);
}

/** What the page does when the writer asks to chat with the agent behind suggestion `id`. */
export type OnChat = (id: string) => void;

/** Each editor's `onChat`, for the keys outside this extension (vim's `gc`). */
const chatters = new WeakMap<EditorView, OnChat>();

/** Opens the chat on suggestion `id` if its agent was kept. False when it can't. */
export function chatSuggestion(view: EditorView, id: string): boolean {
  const s = suggestionsIn(view.state).find((x) => x.id === id);
  const onChat = chatters.get(view);
  if (!s || !canChat(s) || !onChat) return false;
  onChat(s.id);
  return true;
}

/** Whether the agent behind suggestion `s` was kept, so the writer can chat with it (only engines that keep conversations record one). */
export const canChat = (s: Suggestion) => !!s.record?.agent;

/** The marker at `pos` an agent is working on (acknowledged), if any: its id. */
export function workingAt(state: EditorState, pos: number): string | null {
  const $p = state.doc.resolve(pos);
  for (const n of [$p.nodeAfter, $p.nodeBefore]) {
    if (!n) continue;
    if (n.type.name === POINT_NODE && n.attrs.state === "ack") return String(n.attrs.id);
    const m = n.marks.find((x) => x.type.name === RANGE_MARK && x.attrs.state === "ack");
    if (m) return String(m.attrs.id);
  }
  return null;
}

/**
 * Opens the chat at the caret: on the suggestion there, with the agent kept behind it, or on the marker an agent
 * is working on, to look in on its run (the server says if its engine keeps no conversation). False when neither.
 */
export function chatAt(view: EditorView, pos: number): boolean {
  const s = suggestionAt(view.state, pos);
  if (s) return chatSuggestion(view, s.id);
  const id = workingAt(view.state, pos);
  const onChat = chatters.get(view);
  if (!id || !onChat) return false;
  onChat(id);
  return true;
}

/**
 * The card for suggestion `s`: what was asked, the agent's note, a warning if the text changed, and the actions.
 * `dismiss` puts it away, for an action that goes on somewhere else (the chat, the instruction input).
 */
function card(view: EditorView, s: Suggestion, onChat: OnChat | null, dismiss: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "task-card sug-card";
  const head = document.createElement("header");
  // What it is, not which task type made it: the same words for every request.
  head.textContent = s.declined ? "Declined" : s.answered ? "Answer" : "Suggestion";
  // Its accent: the popover is the same for every kind of comment, only the colour differs (margin.css `[data-kind]`).
  el.dataset.kind = s.declined ? "declined" : s.answered ? "answer" : "suggestion";
  el.append(head);
  if (s.answered) {
    const a = document.createElement("div");
    a.className = "sug-answer-text";
    drawMarkdown(a, view.state.schema, s.record!.answer!, false);
    el.append(a);
  }
  const note = s.record?.note;
  if (note) {
    const p = document.createElement("p");
    p.className = "sug-note";
    p.textContent = note;
    el.append(p);
  }
  const edits = s.declined ? [] : s.record?.edits ?? [];
  if (edits.length) {
    const ul = document.createElement("ul");
    ul.className = "sug-edits";
    for (const e of edits) {
      const li = document.createElement("li");
      li.textContent = describeEdit(view.state.schema, e);
      if (!findBlocks(view.state.doc, e.before)) {
        li.classList.add("gone");
        li.textContent += " (changed since: Accept leaves it as it is)";
      }
      ul.append(li);
    }
    el.append(ul);
  }
  if (s.record?.saw !== undefined && !s.declined) {
    const spots = markerSpots(view.state.doc, s.id);
    const now = spots?.pieces.map((p) => view.state.doc.textBetween(p.from, p.to, "\n", "￼")).join("\n\n");
    if (now !== undefined && now !== s.record.saw) {
      const w = document.createElement("p");
      w.className = "sug-stale";
      w.textContent = s.answered ? "This text changed after the answer was given."
        : s.record.mode === "replace" ? "This text changed after the suggestion was made. Accepting replaces your newer text."
          : "This text changed after the suggestion was made.";
      el.append(w);
    }
  }
  const row = document.createElement("div");
  row.className = "task-row sug-actions";
  const button = (label: string, title: string, decision: Decision, primary = false) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.className = primary ? "task-btn primary" : decision === "rejected" ? "task-btn ghost" : "task-btn";
    b.dataset.decision = decision;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      if (decision === "asked_again" && askAgainWithInstruction(view, s)) { dismiss(); return; }
      decideSuggestion(view, s.id, decision);
      view.focus();
    });
    return b;
  };
  /** Accept, and beside it the `▾` for Accept as a Button on a task type that has it and a task that has no button yet. */
  /**
   * Accept, and on a request that can have a button, ▾ with the way to one: Accept as a Button when the result fits,
   * Ask again as a button when it doesn't. Asked for as a button,
   * the card leads with Accept as a Button and plain Accept moves into ▾.
   */
  const acceptControl = () => {
    const hasButton = !!s.record?.button;
    const accept = button("Accept", hasButton ? `Put it in the page; the button stays (${keyLabel("Mod-Alt-y")})` : `Put it in the page (${keyLabel("Mod-Alt-y")})`, "accepted", true);
    if (hasButton || !pluginFor(s.taskType)?.reusable) return accept;
    const choices = buttonChoices(view, s, dismiss);
    const main = choices.lead ?? accept;
    const group = document.createElement("span");
    group.className = "sug-accept";
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = "▾";
    more.className = "task-btn primary sug-accept-more";
    more.setAttribute("aria-label", "More ways to accept");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("mousedown", (e) => e.preventDefault());
    // The dropdown floats under Accept ▾ (the card scrolls, and would cut it off or push it below its last row).
    more.addEventListener("click", () => {
      if (menuPopup) return closeMenu();
      more.setAttribute("aria-expanded", "true");
      // Flush with Accept's left edge and close under it (a popup otherwise sits 12px left and 8px below its anchor).
      const under = {
        get isConnected() { return group.isConnected; },
        contains: (n: Node | null) => group.contains(n),
        getBoundingClientRect: () => { const r = group.getBoundingClientRect(); return new DOMRect(r.left + 12, r.top, r.width, r.height - 4); },
      };
      const popup = openPopup(under, acceptMenu(s.id, choices.items), () => {
        if (menuPopup === popup) menuPopup = null;
        more.setAttribute("aria-expanded", "false");
      });
      menuPopup = popup;
    });
    group.append(main, more);
    return group;
  };
  if (s.declined) {
    row.append(button("Dismiss", "Take the marker out", "rejected", true), button("Ask again", "Send it to the agent again", "asked_again"));
  } else if (s.answered) {
    row.append(button("Done", "Take the marker out: your text stays as it is", "rejected", true), button("Ask again", "Ask the agent again", "asked_again"));
  } else {
    row.append(
      acceptControl(),
      button("Reject", `Leave the page as it is (${keyLabel("Mod-Alt-n")})`, "rejected"),
      button("Ask again", "Turn this down and ask the agent for another", "asked_again"),
    );
  }
  if (onChat) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Chat";
    b.className = "task-btn ghost";
    b.dataset.action = "chat";
    b.disabled = !canChat(s);
    b.title = canChat(s) ? `Talk to the agent that made this (${keyLabel("Mod-Alt-c")})` : "Chat needs an agent that was kept: this one wasn't.";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { dismiss(); onChat(s.id); });
    row.append(b);
  }
  el.append(row);
  return el;
}

/**
 * Ask again on a range whose task type takes an instruction: the input opens first (`openAskAgain`). False for other
 * task types, which ask again at once.
 */
function askAgainWithInstruction(view: EditorView, s: Suggestion): boolean {
  return openAskAgain(view, s.taskType, s.id, view.dom.querySelector<HTMLElement>(`[data-sug="${s.id}"]`), (text) => { decideSuggestion(view, s.id, "asked_again", text); });
}

/** The dropdown of Accept ▾ while it is open (one at a time). */
let menuPopup: OpenPopup | null = null;
const closeMenu = () => menuPopup?.close();

/** One choice in Accept ▾'s dropdown: what it is, and a line saying what will happen. */
export interface AcceptChoice { label: string; note: string; action: string; onPick(): void }

/**
 * The ways to a button from suggestion `s`. A result that fits (one piece of text in place) can be accepted as a button;
 * one that doesn't is asked for again as a button, saying why in what the writer can see. Never a dead end.
 * `lead`: the card's main button, when the writer asked for this one as a button and it fits.
 */
function buttonChoices(view: EditorView, s: Suggestion, dismiss: () => void): { lead?: HTMLElement; items: AcceptChoice[] } {
  const blocker = buttonBlocker(view.state.schema, s.record ?? {});
  const pick = (f: () => void) => () => { closeMenu(); dismiss(); f(); };
  const asButton: AcceptChoice = { label: "Accept as a Button", note: "Keep this text with a ↻ button above it that rewrites it when you press it.", action: "accept-as-button", onPick: pick(() => confirmAcceptAsButton(view, s)) };
  if (blocker) {
    const anchor = () => view.dom.querySelector<HTMLElement>(`[data-sug="${s.id}"]`);
    const ask = (text?: string | null) => { decideSuggestion(view, s.id, "asked_for_button", text); };
    return { items: [{ label: "Ask again as a button", note: `${BUTTON_BLOCKED[blocker]} The agent will be asked for a version in one piece here, leaving the rest of the page as it is.`, action: "ask-for-button", onPick: pick(() => { if (!openAskAgain(view, s.taskType, s.id, anchor(), ask)) ask(); }) }] };
  }
  if (!s.record?.wants_button) return { items: [asButton] };
  // Asked for as a button: that is the main choice, and plain Accept the other.
  const lead = document.createElement("button");
  lead.type = "button";
  lead.textContent = "Accept as a Button";
  lead.className = "task-btn primary";
  lead.dataset.action = "accept-as-button";
  lead.title = asButton.note;
  lead.addEventListener("mousedown", (e) => e.preventDefault());
  lead.addEventListener("click", () => { dismiss(); confirmAcceptAsButton(view, s); });
  return { lead, items: [{ label: "Accept without a button", note: `Put the text in the page as ordinary text (${keyLabel("Mod-Alt-y")}).`, action: "accept-plain", onPick: () => { closeMenu(); decideSuggestion(view, s.id, "accepted"); view.focus(); } }] };
}

/**
 * Accept ▾'s dropdown: its choices, each a label and a line saying what will happen. It counts as part of the suggestion
 * (`data-sug`), so the card stays while the pointer is on it. Exported for FEATURES.html.
 */
export function acceptMenu(id: string, choices: AcceptChoice[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "sug-more";
  list.dataset.sug = id;
  list.setAttribute("role", "menu");
  for (const c of choices) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "sug-menu-item";
    item.dataset.action = c.action;
    item.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.className = "sug-menu-label";
    label.textContent = c.label;
    const note = document.createElement("span");
    note.className = "sug-menu-note";
    note.textContent = c.note;
    item.append(label, note);
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", c.onPick);
    list.append(item);
  }
  return list;
}

/** What the writer is told before a result becomes a button. Exported for FEATURES.html. */
export function buttonConfirm(onCancel: () => void, onConfirm: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "task-card sug-button-confirm";
  const head = document.createElement("header");
  head.textContent = "Accept as a Button";
  const p = document.createElement("p");
  p.className = "sug-note";
  p.textContent = "Pressing this button runs the request again and puts the new result straight into the page, in place of this text. You won't see a diff, and Undo won't bring the old text back.";
  const row = document.createElement("div");
  row.className = "task-row sug-actions";
  const action = (label: string, cls: string, f: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.className = cls;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", f);
    return b;
  };
  const confirm = action("Accept as a Button", "task-btn primary", onConfirm);
  confirm.dataset.decision = "button";
  row.append(action("Cancel", "task-btn ghost", onCancel), confirm);
  el.append(head, p, row);
  return el;
}

/** The popup that says what a button does; Accept as a Button happens on its confirm. Anything else leaves the suggestion waiting. */
function confirmAcceptAsButton(view: EditorView, s: Suggestion) {
  const anchor = view.dom.querySelector<HTMLElement>(`[data-sug="${s.id}"]`) ?? view.dom;
  let popup: OpenPopup;
  const box = buttonConfirm(() => popup.close(), () => { popup.close(); decideSuggestion(view, s.id, "button"); });
  popup = openPopup(anchor, box, () => { if (!view.isDestroyed) view.focus(); });
}

export const suggestions = Extension.create<{ onChat: OnChat | null }>({
  name: "suggestions",
  addOptions: () => ({ onChat: null }),
  addKeyboardShortcuts() {
    const act = (decision: Decision) => () => {
      const s = current(this.editor.state);
      return !!s && decideSuggestion(this.editor.view, s.id, decision);
    };
    return {
      "Mod-Alt-y": act("accepted"),
      "Mod-Alt-n": act("rejected"),
      "Mod-Alt-c": () => {
        const s = current(this.editor.state);
        return s ? chatSuggestion(this.editor.view, s.id) : chatAt(this.editor.view, this.editor.state.selection.from);
      },
      "Mod-Alt-]": () => goToSuggestion(this.editor.view, 1),
      "Mod-Alt-[": () => goToSuggestion(this.editor.view, -1),
    };
  },
  addProseMirrorPlugins() {
    const onChat = this.options.onChat;
    return [
      new Plugin<SuggestionState>({
        key: suggestionKey,
        state: {
          init: (_, state) => ({ records: {}, open: null, decos: decorations(state.doc, {}) }),
          apply(tr, prev) {
            const meta = tr.getMeta(suggestionKey) as Meta | undefined;
            const records = meta && "records" in meta ? meta.records : prev.records;
            const open = meta && "open" in meta ? meta.open : prev.open;
            if (!tr.docChanged && records === prev.records) return open === prev.open ? prev : { ...prev, open };
            return { records, open, decos: decorations(tr.doc, records) };
          },
        },
        props: {
          decorations: (state) => suggestionKey.getState(state)?.decos,
          handleDOMEvents: {
            // A click in a block a suggestion would change opens its card (the caret goes there too, as usual).
            click(view, e) {
              // On a question's highlight the click is the question's: one window opens, not two.
              if ((e.target as HTMLElement | null)?.closest?.("[data-comment]")) return false;
              const id = (e.target as HTMLElement | null)?.closest?.(".sug-old-block")?.getAttribute("data-sug");
              if (id && suggestionKey.getState(view.state)?.open !== id) openSuggestion(view, id);
              return false;
            },
          },
        },
        view(view) {
          if (onChat) chatters.set(view, onChat);
          const side = sideCard(view.dom);
          /** The suggestion under the pointer (its diff, or its card), if any. */
          let hovered: string | null = null;
          let leaving: ReturnType<typeof setTimeout> | undefined;
          /** What the card shows now: the suggestion's id, record and the page, so it is drawn again when they change. */
          let drawn: { id: string; record: TaskRecord | null; doc: PMNode } | null = null;
          const sync = () => {
            const open = suggestionKey.getState(view.state)?.open ?? null;
            const all = suggestionsIn(view.state);
            const s = all.find((x) => x.id === hovered) ?? all.find((x) => x.id === open) ?? null;
            if (!s) { drawn = null; closeMenu(); side.hide(); return; }
            if (drawn?.id !== s.id || drawn.record !== s.record || drawn.doc !== view.state.doc) {
              drawn = { id: s.id, record: s.record, doc: view.state.doc };
              closeMenu(); // its Accept ▾ is about to be drawn again
              side.show(s.id, card(view, s, onChat, unpin));
            } else side.place();
          };
          // The card follows the pointer: on a diff, its card; off it and off the card, after a moment (time to reach
          // the card), the pinned one's, or none.
          const point = (target: EventTarget | null) => {
            const node = target as HTMLElement | null;
            const on = node?.closest?.("[data-sug]")?.getAttribute("data-sug") ?? (side.contains(node) ? side.id : null);
            clearTimeout(leaving);
            if (on) { if (on !== hovered) { hovered = on; sync(); } return; }
            if (hovered) leaving = setTimeout(() => { hovered = null; if (!view.isDestroyed) sync(); }, 250);
          };
          const over = (e: MouseEvent) => point(e.target);
          const gone = () => point(null); // the pointer left the window
          document.addEventListener("mouseover", over);
          document.documentElement.addEventListener("mouseleave", gone);
          // A pinned card closes on Escape or a click away from it and its diff.
          function unpin() { clearTimeout(leaving); hovered = null; if (suggestionKey.getState(view.state)?.open) openSuggestion(view, null); else sync(); }
          const away = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            if (!side.id || side.contains(t) || t?.closest?.(`[data-sug="${side.id}"]`)) return;
            unpin();
          };
          const key = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || !side.id) return;
            // Accept ▾'s dropdown closes first (it closes itself on Escape); the card stays.
            if (menuPopup) return;
            unpin();
          };
          document.addEventListener("mousedown", away, true);
          document.addEventListener("keydown", key, true);
          return {
            update: sync,
            destroy() {
              clearTimeout(leaving);
              document.removeEventListener("mouseover", over);
              document.documentElement.removeEventListener("mouseleave", gone);
              document.removeEventListener("mousedown", away, true);
              document.removeEventListener("keydown", key, true);
              side.destroy();
            },
          };
        },
      }),
    ];
  },
});
