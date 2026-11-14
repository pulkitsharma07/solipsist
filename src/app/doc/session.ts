import type { Editor } from "@tiptap/core";
import type { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { diffPatch } from "node-diff3";
import { freshKey } from "../editor/freshText";
import { newBlockKey } from "../editor/newBlocks";
import { DECISION_META, suggestionKey } from "../editor/suggestions";
import {
  anchorsFromMarks, toEditorDoc, canonicalBody, commentRanges, POINT_NODE, RANGE_MARK, taskStates, docToMarkdown, listComments, blockKey, type TaskState, markdownToDoc, mergeBodies, withoutStates, withStatesFrom, parseFile, placeComments, type CommentEntry, type CommentsBlock,
} from "../../shared/docfile";
import type { Decision, PutRequest } from "../../server/put";
import { putPage, openEvents, type FileMsg, type PutReply } from "./client";
import { initialState, receiveVia, step, type Effect, type Event, type SessionState } from "./sessionMachine";


// Near-realtime timings.
const SAVE_AFTER_MS = 500;
/** While the writer types without pausing, still save at least this often. */
const SAVE_MAX_WAIT_MS = 3000;
const PAUSE_MS = 700;
/** How long newly arrived text keeps its fade-in highlight. */
const FRESH_MS = 1600;
const RETRY_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export interface Snapshot {
  comments: CommentEntry[];
  /** Ids that currently have a highlight in the page. */
  placed: Set<string>;
  save: "saved" | "dirty" | "saving" | "error";
  conn: "connecting" | "live" | "offline" | "refused";
  conflict: boolean;
}

/**
 * One tab's view of one page (plan section 5): applies files from the server to the editor, saves the editor back
 * with every comment's status and anchor, and tells React when anything on screen changed. `test/browser-tab.ts` drives
 * this class in the tests.
 */
/** A top-level block's key (see `blockKey`), remembered per node: nodes never change, so a block is serialized once. */
const keyCache = new WeakMap<PMNode, string>();
const keyOf = (node: PMNode) => {
  let k = keyCache.get(node);
  if (k === undefined) keyCache.set(node, (k = blockKey(node.toJSON())));
  return k;
};

export class DocSession {
  readonly clientId = `t_${Math.random().toString(36).slice(2, 8)}`;
  private editor!: Editor;
  private lastRev = -1;
  private bodyRev = 0;
  private known = new Set<string>();
  private latest: CommentEntry[] = [];
  /** Save and sync state (`sessionMachine.ts`): changed only by `go`. */
  private m: SessionState = initialState;
  /** The body both we and the server last agreed on: the base of a three-way merge. */
  private base = "";
  private saveTimer?: Timer;
  private dirtySince?: number;
  private pauseTimer?: Timer;
  private freshTimer?: Timer;
  private typingAt: number | undefined;
  private closeEvents?: () => void;
  private listeners = new Set<() => void>();
  private snap: Snapshot = { comments: [], placed: new Set(), save: "saved", conn: "connecting", conflict: false };
  /** `manual`: no timers (tests drive saving and pausing themselves). */
  constructor(readonly id: string, private readonly initial: FileMsg, private readonly opts: { manual?: boolean } = {}) {}

  get lastRevApplied() { return this.lastRev; }
  /** Comments found in the block under the caret, waiting for the writer to pause. */
  deferred: string[] = [];

  /** The body to start the editor with. */
  get initialContent() {
    return markdownToDoc(parseFile(this.initial.file).markdown).toJSON();
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.snap;
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Feeds one event to the state machine and carries out its effects. Null when the machine refused it. */
  private go(e: Event): Effect[] | null {
    const r = step(this.m, e);
    if (!r.ok) {
      console.error(`DocSession: ${e.type} refused: ${r.reason}`);
      return null;
    }
    this.m = r.state;
    const patch: Partial<Snapshot> = {};
    if (r.state.save !== this.snap.save) patch.save = r.state.save;
    if ((r.state.hold.kind === "conflict") !== this.snap.conflict) patch.conflict = r.state.hold.kind === "conflict";
    if (Object.keys(patch).length) this.set(patch);
    for (const fx of r.effects) this.run(fx);
    return r.effects;
  }

  private run(fx: Effect) {
    switch (fx.type) {
      case "scheduleSave": {
        const retry = typeof fx.after === "object" ? fx.after.retry : null;
        if (this.opts.manual && retry === null) return;
        let wait = SAVE_AFTER_MS;
        if (retry !== null) wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)]!;
        else if (fx.after === "typing") {
          this.dirtySince ??= Date.now();
          wait = Math.min(SAVE_AFTER_MS, Math.max(0, this.dirtySince + SAVE_MAX_WAIT_MS - Date.now()));
        }
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.save(), wait);
        return;
      }
      case "sendPut": return; // `save` sends it: it awaits the reply
      case "adopt": return this.adopt(fx.merged, fx.theirs, fx.bodyRev);
    }
  }

  /** Called once the editor exists. Applies the first file and opens the stream. */
  attach(editor: Editor) {
    this.editor = editor;
    const first = this.initial;
    this.bodyRev = parseFile(first.file).block.meta.body_rev;
    this.base = parseFile(first.file).markdown;
    this.receive(first.file);
    editor.on("update", ({ transaction }) => {
      if (transaction.getMeta("solipRemote")) return;
      const decided = transaction.getMeta(DECISION_META) as { id: string; decision: Decision } | { id: string; decision: Decision }[] | undefined;
      for (const d of [decided ?? []].flat()) this.decisions.set(d.id, d.decision);
      this.onEdit();
    });
    editor.on("selectionUpdate", () => this.refreshPlaced());
    if (this.opts.manual) return;
    this.closeEvents = openEvents(this.id, {
      onFile: (m) => this.receive(m.file),
      onState: (conn) => this.set({ conn }),
    });
    window.addEventListener("pagehide", this.onHide);
    window.addEventListener("blur", this.onBlur);
  }

  /** Set once the page is gone: a save still in flight then finishes on the server, and its reply is dropped. */
  private destroyed = false;

  destroy() {
    // Leaving the page inside the app (All pages) fires no pagehide: typing not yet saved goes now, as on a tab close.
    // The request is built before the page goes; its reply is dropped (`destroyed`).
    if (this.snap.save !== "saved") void this.save(true);
    this.destroyed = true;
    this.closeEvents?.();
    clearTimeout(this.saveTimer);
    clearTimeout(this.pauseTimer);
    clearTimeout(this.freshTimer);
    window.removeEventListener("pagehide", this.onHide);
    window.removeEventListener("blur", this.onBlur);
  }

  private onHide = () => { if (this.snap.save !== "saved") void this.save(true); };
  private onBlur = () => { if (this.snap.save === "dirty") void this.save(); };

  // ---- applying a file (5.2) ----
  receive(src: string): "applied" | "stale" | "merged" | "reloaded" | "conflict" {
    const { block, markdown: theirs } = parseFile(src);
    if (block.meta.rev <= this.lastRev) return "stale";
    let outcome: "applied" | "merged" | "reloaded" | "conflict" = "applied";
    if (block.meta.body_by !== this.clientId && block.meta.body_rev > this.bodyRev) {
      const mine = docToMarkdown(this.editor.state.doc);
      this.held = new Map([...taskStates(mine)].filter(([id]) => this.decisions.has(id)));
      // A task that has moved on (`:ack`, `:done`) is not a change to review: its loader just changes state.
      this.syncTaskStates(theirs);
      const via = receiveVia(this.m);
      const bodyRev = block.meta.body_rev;
      // Someone else changed the body: fold their change into the page, keeping what the writer has typed.
      const merged = via === "take" ? theirs : this.merge3(this.baseFor(mine, theirs), mine, theirs);
      this.go({ type: "fileReceived", via, theirs, bodyRev, merged, same: this.same(merged, theirs) });
      outcome = merged === null ? "conflict" : via === "take" ? "reloaded" : "merged";
    }
    this.lastRev = block.meta.rev;
    this.latest = listComments(block);
    this.syncRecords(block);
    this.place();
    return outcome;
  }

  /** The tasks' records, as the file has them: the page shows the suggestions they hold. */
  private records = "";
  private syncRecords(block: CommentsBlock) {
    const records = block.tasks ?? {};
    const json = JSON.stringify(records);
    if (json === this.records) return;
    this.records = json;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(suggestionKey, { records }).setMeta("solipRemote", true).setMeta("addToHistory", false));
  }

  /** The states of the tasks the writer has decided on and not yet saved: the file doesn't know of those decisions yet. */
  private held = new Map<string, TaskState>();

  /** Moves the tasks in the page to the states the file gives them, in place, so their loaders can animate the change. */
  private syncTaskStates(theirs: string) {
    const wanted = taskStates(theirs);
    if (!wanted.size) return;
    for (const [id, state] of this.held) if (this.decisions.has(id) && wanted.has(id)) wanted.set(id, state);
    const { state, view } = this.editor;
    const tr = state.tr;
    let changed = false;
    state.doc.descendants((node, pos) => {
      if (node.type.name === POINT_NODE) {
        const to = wanted.get(node.attrs.id);
        if (to && to !== node.attrs.state) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, state: to }); changed = true; }
        return;
      }
      for (const m of node.marks) {
        const to = m.type.name === RANGE_MARK ? wanted.get(m.attrs.id) : undefined;
        if (to && to !== m.attrs.state) { tr.addMark(pos, pos + node.nodeSize, m.type.create({ ...m.attrs, state: to })); changed = true; }
      }
    });
    if (changed) view.dispatch(tr.setMeta("solipRemote", true).setMeta("addToHistory", false));
  }

  /**
   * mergeBodies, ignoring where the tasks are in their life. A task that moved on (`:ack`, `:done`) is
   * already moved on in the page, so `mine` and `theirs` would both have changed that line from `base`: a clash that
   * isn't one. The result has no states; `adopt` puts them back.
   */
  private merge3(base: string, mine: string, theirs: string) {
    return mergeBodies(withoutStates(base), withoutStates(mine), withoutStates(theirs));
  }

  /**
   * The body to merge from. Usually the one last agreed with the server; but while a save is unanswered the server may
   * already hold it, and their body then builds on it, not on the old base. Only when it does: their body has
   * everything that save changed. A save that never got there (lost, or refused with a 409) is not a base; merging
   * from it would say the writer changed nothing, and their body would replace the typing.
   */
  private baseFor(mine: string, theirs: string) {
    const awaiting = this.m.awaiting?.body;
    if (awaiting === undefined || this.merge3(this.base, mine, theirs) !== null) return this.base;
    const buildsOn = this.same(this.merge3(this.base, awaiting, theirs), theirs);
    return buildsOn && this.merge3(awaiting, mine, theirs) !== null ? awaiting : this.base;
  }

  /** A merge result that is their body, task states aside: nothing of the writer's is left to save. */
  private same(merged: string | null, theirs: string) {
    return merged !== null && canonicalBody(withoutStates(merged)) === canonicalBody(withoutStates(theirs));
  }

  /** Shows `merged` (their body with the writer's own edits kept) and treats `theirs` as the new agreed body. */
  private adopt(merged: string, theirs: string, bodyRev: number) {
    this.applyBody(merged);
    this.syncTaskStates(theirs); // blocks that were rebuilt start out pending
    this.base = theirs;
    this.bodyRev = bodyRev;
    this.known = new Set([...this.known].filter((id) => commentRanges(this.editor.state.doc).has(id)));
  }

  /**
   * Makes the page show `markdown`, replacing only the top-level blocks that differ. Blocks are matched by a diff, so
   * any number of changes above and below the block the writer is typing in leave that block, its caret and its
   * highlights untouched. A block that reads the same on disk stays as the writer has it (a trailing space or a
   * line break at the end of a paragraph is not in the markdown). Highlights in a replaced block are re-found from
   * their anchors.
   */
  private applyBody(markdown: string) {
    const next = toEditorDoc(this.editor.schema, markdown);
    const { state, view } = this.editor;
    const cur = state.doc;
    const keys = (doc: PMNode) => { const out: string[] = []; doc.forEach((c) => out.push(keyOf(c))); return out; };
    const starts = (doc: PMNode) => { const out = [0]; doc.forEach((c) => out.push(out[out.length - 1]! + c.nodeSize)); return out; };
    // The editor keeps an empty paragraph after a table or code block at the end of the page, so there is always
    // somewhere to type. It isn't in the markdown: leave it alone, caret and all.
    const isEmptyPara = (n: PMNode | null) => !!n && n.type.name === "paragraph" && n.content.size === 0;
    const curKeys = keys(cur);
    if (isEmptyPara(cur.lastChild) && !isEmptyPara(next.lastChild)) curKeys.pop();
    const patches = diffPatch(curKeys, keys(next));
    if (!patches.length) return;
    const [curAt, nextAt] = [starts(cur), starts(next)];
    const tr = state.tr;
    const flashes: { from: number; to: number }[] = [];
    let delta = 0; // how much the blocks replaced so far have grown or shrunk the document
    for (const p of patches) {
      const [i, n, j, m] = [p.buffer1.offset, p.buffer1.length, p.buffer2.offset, p.buffer2.chunk.length];
      const oldFrag = cur.content.cut(curAt[i]!, curAt[i + n]!);
      const newFrag = next.content.cut(nextAt[j]!, nextAt[j + m]!);
      const from = curAt[i]! + delta;
      const first = oldFrag.findDiffStart(newFrag);
      let end: { a: number; b: number } | null = null;
      if (first != null) {
        end = oldFrag.findDiffEnd(newFrag)!;
        const overlap = first - Math.min(end.a, end.b);
        end = { a: end.a + Math.max(overlap, 0), b: end.b + Math.max(overlap, 0) };
      }
      // Replace only what differs, so the caret in a list item or table cell next to the change stays where it is.
      if (first != null && end && !this.replaceWithin(tr, from, first, end, next, nextAt[j]!, newFrag)) {
        tr.replaceWith(from, curAt[i + n]! + delta, newFrag);
      } else if (first == null) {
        tr.replaceWith(from, curAt[i + n]! + delta, newFrag);
      }
      // Flash only the words that are new, not the whole block they sit in.
      if (first != null && end) flashes.push({ from: from + first, to: from + end.b });
      delta += newFrag.size - oldFrag.size;
    }
    // A button rewriting its own text (`:btn`, its run applied straight in) is not a change to review: no fade, no
    // new-block line. The margin says when it last ran instead.
    const ownText = (r: { from: number; to: number }) => {
      let button = false;
      tr.doc.nodesBetween(r.from, Math.min(r.to, tr.doc.content.size), (n) => { if (n.marks.some((m) => m.type.name === RANGE_MARK && m.attrs.state === "btn")) button = true; return !button; });
      return button;
    };
    const shown = flashes.filter((r) => !ownText(r));
    if (shown.length) {
      tr.setMeta(freshKey, { add: shown }).setMeta(newBlockKey, { add: shown });
      clearTimeout(this.freshTimer);
      if (!this.opts.manual) this.freshTimer = setTimeout(() => this.clearFresh(), FRESH_MS);
    }
    // Text inserted right at the caret (a block added after what the writer is typing) must not push the caret past it.
    const sel = state.selection;
    if (sel instanceof TextSelection) {
      const [$anchor, $head] = [tr.doc.resolve(tr.mapping.map(sel.anchor, -1)), tr.doc.resolve(tr.mapping.map(sel.head, -1))];
      // A caret in a block that was replaced outright maps to between blocks: it goes to the nearest text instead.
      const inText = $anchor.parent.inlineContent && $head.parent.inlineContent;
      tr.setSelection(inText ? TextSelection.create(tr.doc, $anchor.pos, $head.pos) : TextSelection.between($anchor, $head));
    }
    view.dispatch(tr.setMeta("solipRemote", true).setMeta("addToHistory", false));
  }

  /**
   * Swaps the part of a replaced run of blocks that differs (`first` .. `end`, offsets inside the run that starts at
   * `from`) for the same part of `next`, leaving the rest, and the caret in it, alone. False (and `tr` untouched)
   * when that can't be done cleanly: the caller then replaces the whole run.
   */
  private replaceWithin(tr: Transaction, from: number, first: number, end: { a: number; b: number }, next: PMNode, nextFrom: number, newFrag: Fragment): boolean {
    try {
      const trial = new Transform(tr.doc);
      trial.replace(from + first, from + end.a, next.slice(nextFrom + first, nextFrom + end.b));
      if (!trial.doc.slice(from, from + newFrag.size).content.eq(newFrag)) return false;
      trial.steps.forEach((st) => tr.step(st));
      return true;
    } catch {
      return false;
    }
  }

  /** Loads another writer's body, discarding anything unsaved (the writer chose Reload). */
  reload(src: string) {
    const { markdown, block } = parseFile(src);
    this.applyBody(markdown);
    this.base = markdown;
    this.known.clear();
    this.bodyRev = block.meta.body_rev;
    this.lastRev = -1;
    this.typingAt = undefined;
    this.go({ type: "reload" });
    this.receive(src);
  }

  private place() {
    const r = placeComments(this.editor.state, this.latest, this.known, { deferInBlockAt: this.typingAt });
    r.tr.setMeta("solipRemote", true);
    this.editor.view.dispatch(r.tr);
    r.known.forEach((id) => this.known.add(id));
    r.forgotten.forEach((id) => this.known.delete(id));
    this.deferred = r.deferred;
    this.set({ comments: this.latest });
    this.refreshPlaced();
    this.reportLost();
  }

  /** Which comments have a highlight right now (a comment with no mark has no note). */
  private refreshPlaced() {
    const placed = new Set<string>();
    this.editor.view.dom.querySelectorAll<HTMLElement>("[data-comment]").forEach((el) => placed.add(el.dataset.comment!));
    const prev = this.snap.placed;
    if (placed.size !== prev.size || [...placed].some((id) => !prev.has(id))) this.set({ placed });
  }

  // ---- the writer ----
  private onEdit() {
    this.typingAt = this.editor.state.selection.head;
    clearTimeout(this.pauseTimer);
    if (!this.opts.manual) this.pauseTimer = setTimeout(() => this.settle(), PAUSE_MS);
    this.refreshPlaced();
    this.go({ type: "edit" });
  }

  /**
   * Comments the file calls open but whose passage this page can't find are orphans. Say so right away (not only
   * at the writer's next edit), so the server can clean them out of the file.
   */
  private reportLost() {
    const lost = step(this.m, { type: "lost" }); // a dry run: is there anything a report would do?
    if (!lost.ok || !lost.effects.length) return;
    const marked = commentRanges(this.editor.state.doc);
    if (!this.latest.some((c) => c.status === "open" && this.known.has(c.id) && !marked.has(c.id))) return;
    this.go({ type: "lost" });
  }

  clearFresh() {
    if (this.editor.isDestroyed) return;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(freshKey, { clear: true }).setMeta("solipRemote", true).setMeta("addToHistory", false));
  }

  /** The writer has stopped typing: comments held back for the block under the caret are placed. */
  settle() {
    clearTimeout(this.pauseTimer);
    this.typingAt = undefined;
    this.place();
  }

  // ---- saving (5.1) ----
  /**
   * The writer's decisions on suggestions since the last save that took them, by task id. The server checks
   * each against the body it is sent, so one the writer undid since is not recorded.
   */
  private decisions = new Map<string, Decision>();
  private sentDecisions = new Map<string, Decision>();

  /**
   * What the writer did to a comment since the last save that took it: `dismissed` takes it down for good (the
   * Reader never raises that passage again), `opened` says they have read the card, which keeps a better question
   * from taking its place. Travels with the next save, the way a suggestion's decision does.
   */
  private commentActs = new Map<string, "dismissed" | "opened">();
  private sentActs = new Map<string, "dismissed" | "opened">();

  /**
   * The writer took a comment down: it goes at once, and the save records it.
   *
   * Both go through `edit`, the same event the writer's typing raises, so the save loop owns them: it coalesces
   * them, waits its turn behind a save already in flight, retries a failure and holds them back in a conflict.
   * Saving directly would not — a dismissal changes no body text, so an unforced save sends nothing, and a forced
   * one is dropped outright while another save is in flight (opening a card, then dismissing it, did exactly that).
   */
  dismissComment(id: string) {
    this.commentActs.set(id, "dismissed");
    this.latest = this.latest.map((c) => (c.id === id ? { ...c, status: "dismissed" as const } : c));
    this.set({ comments: this.latest });
    this.go({ type: "edit" });
  }

  /** The writer opened a comment's card. Recorded once: the first open is what counts. */
  openComment(id: string) {
    if (this.commentActs.get(id) === "dismissed" || this.latest.find((c) => c.id === id)?.opened_at) return;
    this.commentActs.set(id, "opened");
    this.go({ type: "edit" });
  }

  /** The request a save sends: the body, and every received comment's status with an anchor rebuilt from its mark. */
  buildPut(): PutRequest {
    const markdown = canonicalBody(docToMarkdown(this.editor.state.doc));
    this.go({ type: "sent", body: markdown });
    const anchors = anchorsFromMarks(this.editor.state.doc);
    const comments: PutRequest["comments"] = {};
    for (const id of this.known) {
      const a = anchors.get(id);
      if (this.commentActs.get(id) === "dismissed") comments[id] = { status: "dismissed" };
      else if (a) comments[id] = { status: "open", anchor: a, ...(this.commentActs.get(id) === "opened" && { opened: true }) };
      else comments[id] = { status: "orphaned" };
    }
    // A comment the writer dismissed before this tab ever had a mark for it still has to reach the server.
    for (const [id, act] of this.commentActs) if (act === "dismissed" && !comments[id]) comments[id] = { status: "dismissed" };
    this.sentDecisions = new Map(this.decisions);
    this.sentActs = new Map(this.commentActs);
    return { client_id: this.clientId, base_rev: this.lastRev, markdown, comments, ...(this.decisions.size && { decisions: Object.fromEntries(this.decisions) }) };
  }

  /** Handles a save's reply: the new file on success, or a 409's latest file. */
  onPutResult(reply: { ok: true; rev: number; file: string } | { ok: false; file?: string }) {
    const sent = this.m.awaiting?.body;
    if (reply.ok) {
      if (!this.go({ type: "saveOk" })) return;
      // Recorded: a decision made again since (asked again, then accepted) goes with the next save.
      for (const [id, d] of this.sentDecisions) if (this.decisions.get(id) === d) this.decisions.delete(id);
      for (const [id, a] of this.sentActs) if (this.commentActs.get(id) === a) this.commentActs.delete(id);
      this.bodyRev = reply.rev;
      this.base = sent!;
      this.receive(reply.file);
    } else {
      if (!this.go({ type: "save409" })) return;
      this.receive(reply.file!); // a 409: someone else wrote the body; we are dirty, so this merges or raises the banner
    }
  }

  /** `force` sends even when nothing changed (a first save makes the file canonical). */
  async save(keepalive = false, force = false): Promise<PutReply | null> {
    if (!this.go({ type: "save", force })?.some((fx) => fx.type === "sendPut")) return null;
    clearTimeout(this.saveTimer);
    this.dirtySince = undefined;
    const req = this.buildPut();
    let reply: PutReply | null;
    try {
      reply = await putPage(this.id, req, keepalive);
    } catch {
      reply = null;
    }
    // The writer left the page while it saved: nothing is left to update, but typing refused because the file changed
    // meanwhile (a 409) is merged into it here, as a live page would, and sent once more. A real conflict (both changed
    // the same block) can't be settled without the writer, and is left.
    if (this.destroyed) {
      if (reply && !reply.ok && reply.file) {
        const { markdown: theirs, block } = parseFile(reply.file);
        const merged = this.merge3(this.base, req.markdown, theirs);
        if (merged !== null && !this.same(merged, theirs)) {
          reply = await putPage(this.id, { ...req, base_rev: block.meta.rev, markdown: canonicalBody(withStatesFrom(merged, theirs, new Map([...taskStates(req.markdown)].filter(([id]) => id in (req.decisions ?? {}))))) }, keepalive).catch(() => null);
        }
      }
      return reply;
    }
    if (!reply || (!reply.ok && !reply.file)) {
      this.go({ type: "saveFailed" });
      return reply;
    }
    this.onPutResult(reply);
    return reply;
  }

  keepMine() {
    this.go({ type: "keepMine" });
    return this.save();
  }
  reloadTheirs() {
    void import("./client").then(async ({ getPage }) => this.reload((await getPage(this.id)).file));
  }
}
