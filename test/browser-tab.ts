// A browser tab for the tests: the real `DocSession` on a real Tiptap editor in a fake DOM, with the server's pure
// functions (`Server`) standing in for the network. The writer's actions are ProseMirror transactions, as in a browser.
import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { mock } from "bun:test";
import type { PutReply } from "../src/app/doc/client";
import type { PutRequest } from "../src/server/put";
import { Server } from "./sim";

export { Server };

// The session talks to the server through `client.ts`: route its saves to whichever tab (and Server) sent them.
const tabs = new Map<string, Tab>();
let mounting: Tab | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
mock.module("../src/app/doc/client", () => ({
  // The page's event stream: the tab being mounted keeps the callbacks, so a test can deliver files as SSE would.
  openEvents: (_id: string, on: Tab["events"]) => { mounting!.events = on; on!.onState("live"); return () => {}; },
  getPage: async () => { throw new Error("unused"); },
  putPage: async (_id: string, body: PutRequest): Promise<PutReply> => {
    const tab = tabs.get(body.client_id)!;
    if (tab.live) await sleep(tab.latency()); // the request travels
    const r = tab.server!.put(body);
    if (tab.live) await sleep(tab.latency()); // and so does the answer
    tab.lastReply = r;
    return r.ok ? { ok: true, rev: r.rev, file: r.file } : { ok: false, code: r.code, rev: r.rev, file: r.file };
  },
  // The chat (rendered by tests that load this module too): never opens here.
  openChatStream: () => () => {},
  sayInChat: async () => null,
  stopChat: async () => {},
  // The model picker reads the catalog when it is opened: nothing to offer beyond what it was given.
  getAgentModels: async () => null,
}));

// The session logs a state-machine event it fed in and the machine refused: that is a bug in the session, so the
// test that caused it fails.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("DocSession:")) throw new Error(args[0]);
  consoleError(...args);
};

const { DocSession } = await import("../src/app/doc/session");
const { commentRanges, docText, docToMarkdown, stripCommentMarks } = await import("../src/shared/docfile");
const { editorExtensions } = await import("../src/app/editor/behaviour");

const leafText = (leaf: PMNode) => (leaf.type.name === "hardBreak" ? "\n" : leaf.type.name === "image" ? `[img:${leaf.attrs.src}]` : "");

export class Tab {
  session!: InstanceType<typeof DocSession>;
  editor!: Editor;
  server: Server | null = null;
  lastReply: { ok: boolean } | null = null;

  /** `live`: the session runs on its own timers (saving, pausing, fading) and its saves take time, as in a browser. */
  events: { onFile(m: { rev: number; file: string }): void; onState(s: string): void } | null = null;
  latency = () => 10;
  /** The suggestions whose chat the writer opened, in order. */
  chats: string[] = [];
  /** The schedules the writer set on buttons (`taskButtons.ts`), as the page would send them to the server. */
  schedules: { task: string; every: number | null }[] = [];

  constructor(src: string, readonly live = false) {
    this.mount(src);
  }

  private mount(src: string) {
    this.session?.destroy();
    this.editor?.destroy();
    this.session = new DocSession("doc", { rev: 0, file: src }, { manual: !this.live });
    this.editor = new Editor({
      element: document.createElement("div"),
      extensions: editorExtensions({ onChat: (id) => this.chats.push(id), onSchedule: (task, every) => this.schedules.push({ task, every }) }),
      content: this.session.initialContent,
    });
    tabs.set(this.session.clientId, this);
    mounting = this;
    this.session.attach(this.editor);
  }

  get clientId() { return this.session.clientId; }
  get state(): EditorState { return this.editor.state; }
  get doc(): PMNode { return this.editor.state.doc; }
  get dirty() { return this.session.getSnapshot().save !== "saved"; }
  get conflict() { return this.session.getSnapshot().conflict; }
  get deferred() { return this.session.deferred; }
  get lastRev() { return this.session.lastRevApplied; }

  /** Another tab, a fresh page load, or the writer's Reload: start over from this file. */
  load(src: string) { this.session.reload(src); }
  receive(src: string) { return this.session.receive(src); }
  dispatch(tr: Transaction) { this.editor.view.dispatch(tr); }
  makePut() { return this.session.buildPut(); }
  onPutResult(r: Parameters<typeof this.session.onPutResult>[0]) { this.session.onPutResult(r); return r; }
  pause() { this.session.settle(); }

  // ---- the writer ----
  private edit(fn: (tr: Transaction) => void) {
    const tr = closeHistory(this.state.tr);
    fn(tr);
    this.dispatch(tr);
  }
  find(text: string, nth = 0) {
    const dt = docText(this.state.doc);
    let i = -1;
    for (let k = 0; k <= nth; k++) i = dt.text.indexOf(text, i + 1);
    if (i < 0) throw new Error(`"${text}" not in page`);
    return { from: dt.toPos(i)!, to: dt.toPos(i + text.length)! };
  }
  typeAfter(anchorText: string, text: string) {
    const { to } = this.find(anchorText);
    this.edit((tr) => tr.setSelection(TextSelection.create(tr.doc, to)).insertText(text));
  }
  /** Types at the caret, where the writer is. */
  typeAtCaret(text: string) {
    this.edit((tr) => tr.insertText(text));
  }
  typeBefore(anchorText: string, text: string) {
    const { from } = this.find(anchorText);
    this.edit((tr) => tr.setSelection(TextSelection.create(tr.doc, from)).insertText(text));
  }
  replace(oldText: string, newText: string) {
    const { from, to } = this.find(oldText);
    this.edit((tr) => tr.insertText(newText, from, to));
  }
  remove(text: string) {
    const { from, to } = this.find(text);
    this.edit((tr) => tr.delete(from, to));
  }
  /** Shift+Enter right after `text`: a line break inside the paragraph. */
  shiftEnterAfter(text: string) {
    const { to } = this.find(text);
    this.edit((tr) => tr.insert(to, this.editor.schema.nodes.hardBreak!.create()));
  }
  paragraphBefore(text: string, newText: string) {
    const $pos = this.state.doc.resolve(this.find(text).from);
    const at = $pos.before($pos.depth);
    this.edit((tr) => tr.insert(at, this.editor.schema.nodes.paragraph!.create(null, this.editor.schema.text(newText))));
  }
  removeNodeAround(text: string, type: string) {
    const $pos = this.state.doc.resolve(this.find(text).from);
    for (let d = $pos.depth; d > 0; d--) {
      if ($pos.node(d).type.name === type) {
        const from = $pos.before(d), to = $pos.after(d);
        this.edit((tr) => tr.delete(from, to));
        return;
      }
    }
    throw new Error(`no ${type} around "${text}"`);
  }
  /// Copy and paste go through the editor's own paste transform, as the browser's paste would.
  copyPaste(text: string, target: string) {
    const { from, to } = this.find(text);
    const slice = this.state.doc.slice(from, to);
    const at = this.find(target).to;
    this.edit((tr) => tr.replace(at, at, this.pasted(slice, tr.doc)));
  }
  cutPaste(text: string, target: string) {
    const { from, to } = this.find(text);
    const slice = this.state.doc.slice(from, to);
    this.edit((tr) => tr.delete(from, to));
    const at = this.find(target).to;
    this.edit((tr) => tr.replace(at, at, this.pasted(slice, tr.doc)));
  }
  private pasted(slice: ReturnType<PMNode["slice"]>, doc: PMNode) {
    return this.editor.view.someProp("transformPasted", (f) => f(slice, this.editor.view, false)) ?? stripCommentMarks(slice, doc);
  }
  insertImage(afterText: string, src: string, alt = "") {
    const at = this.find(afterText).to;
    this.edit((tr) => tr.insert(at, this.editor.schema.nodes.image!.create({ src, alt })));
  }
  imagePos(src: string, nth = 0) {
    const found: number[] = [];
    this.state.doc.descendants((n, pos) => { if (n.type.name === "image" && n.attrs.src === src) found.push(pos); });
    if (found[nth] == null) throw new Error(`no image ${src}`);
    return found[nth]!;
  }
  removeImage(src: string, nth = 0) {
    const at = this.imagePos(src, nth);
    this.edit((tr) => tr.delete(at, at + 1));
  }
  pasteImage(src: string, target: string, cut = false) {
    const at = this.imagePos(src);
    const slice = this.state.doc.slice(at, at + 1);
    if (cut) this.edit((tr) => tr.delete(at, at + 1));
    const to = this.find(target).to;
    this.edit((tr) => tr.replace(to, to, this.pasted(slice, tr.doc)));
  }
  enterBefore(text: string) {
    const { from } = this.find(text);
    this.edit((tr) => tr.split(from));
  }
  command(text: string, cmd: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean) {
    const { from } = this.find(text);
    this.dispatch(closeHistory(this.state.tr.setSelection(TextSelection.create(this.state.doc, from))));
    if (!cmd(this.state, (tr) => this.dispatch(tr))) throw new Error("command not applicable");
  }
  selectAllDelete() {
    this.edit((tr) => tr.delete(0, tr.doc.content.size));
  }
  undo() {
    this.editor.commands.undo();
  }

  // ---- saving ----
  async save(server: Server) {
    if (this.conflict) throw new Error("tab is in conflict: reload or keepMine first");
    this.server = server;
    await this.session.save(false, true);
    return this.lastReply as { ok: boolean };
  }
  async keepMine(server: Server) {
    this.server = server;
    await this.session.keepMine();
    return this.lastReply as { ok: boolean };
  }

  // ---- what's on screen ----
  get markdown() { return docToMarkdown(this.state.doc); }
  highlighted(id: string): string | null {
    const r = commentRanges(this.state.doc).get(id);
    return r ? this.state.doc.textBetween(r.from, r.to, "\n", leafText) : null;
  }
  allMarked(id: string): string[] {
    const out: string[] = [];
    this.state.doc.descendants((n) => {
      if (n.isInline && n.marks.some((m) => m.type.name === "comment" && m.attrs.id === id)) out.push(n.isText ? n.text! : leafText(n));
    });
    return out;
  }
  get highlights(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, r] of commentRanges(this.state.doc)) out[id] = this.state.doc.textBetween(r.from, r.to, "\n", leafText);
    return out;
  }
}
