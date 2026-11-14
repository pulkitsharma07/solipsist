// End to end, without a browser: the real server (every API route, the files, the lock, the watcher, the agent loop) in
// this process on a scratch docs folder, and the real app (router, `Sheet`, the session, the Tiptap editor, the
// chat) rendered in happy-dom, talking to it over real HTTP and event streams. Only the model is scripted
// (`ScriptedEngine`): a test decides what each run answers and when, which is how races are staged.
//
// The writer acts as in a browser: transactions on the editor the page made, keys sent to its DOM, clicks on the
// page's buttons, and edits to the file on disk from outside. What a test checks is what the writer would see (the
// DOM, the editor's markdown) and what is on disk.
import "./platform"; // first: see platform.ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { projectDir } from "../project-dir";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEngine, AgentSession, RunOptions, RunResult, StartOptions } from "../../src/server/agent/engine";
import { pageChanged } from "../../src/server/runtime";
import type { AnyReply } from "../../src/server/suggest";
import type { ChatEvent, ChatMessage } from "../../src/shared/chat";
import type { TaskRecord } from "../../src/shared/docfile";
import type { ReactNode } from "react";

// ---------------------------------------------------------------- the scripted model

/** One run, as the engine sees it: which task, the prompt, and a way to hear it was stopped. */
export interface RunCtx {
  /** The task the run is for (from the run prompt), or "" for a chat message. */
  task: string;
  kind: string;
  prompt: string;
  /** Runs started on this engine so far, this one included. */
  n: number;
  aborted: boolean;
  /** Whether the run is over (it replied, failed, or was stopped). */
  ended: boolean;
  /** What the agent streams to a chat looking in (a text reply, word by word, say). */
  stream(e: ChatEvent): void;
  /** Messages steered in during the run and not yet taken. */
  steered: string[];
  /** Takes the steered messages in, as the agent's next step would (they join the conversation): their texts. */
  take(): string[];
}
/** What a run does: give a reply (by the reply tool, checked as Pi's are), fail, or answer in plain text (a chat). */
export type RunPlan = AnyReply | { fail: string } | { text: string } | { throws: string };
type Script = (run: RunCtx) => RunPlan | Promise<RunPlan>;

/** A held run: it waits at `hold()` until the test lets it go. */
export class Gate {
  private waiters: (() => void)[] = [];
  open = false;
  wait() { return this.open ? Promise.resolve() : new Promise<void>((r) => this.waiters.push(r)); }
  release() { this.open = true; for (const w of this.waiters.splice(0)) w(); }
}

/**
 * The model, scripted: `script(run)` says what each run does. It keeps conversations (a session id, a history) as Pi
 * does, so the loop keeps its agents and the chats work. It counts what is open, so a test can check nothing leaks.
 */
export class ScriptedEngine {
  /** Whether its agents take a message mid-run (steering), as Pi's do. */
  steers = true;
  script: Script = () => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: "Hello." });
  runs: RunCtx[] = [];
  starts: StartOptions[] = [];
  open = 0;
  /** The most runs at once, across its agents. */
  peak = 0;
  private live = 0;
  private sessions = 0;
  private histories = new Map<string, ChatMessage[]>();

  readonly engine: AgentEngine = {
    name: "fake", title: "Fake", chats: true, replyTools: true,
    models: () => [{ id: "m", title: "M" }, { id: "n", title: "N" }],
    unavailable: () => null,
    start: (o) => this.start(o),
  };

  private async start(o: StartOptions): Promise<AgentSession> {
    this.starts.push(o);
    this.open++;
    const sessionId = o.resume && this.histories.has(o.resume) ? o.resume : `s${++this.sessions}`;
    const history = this.histories.get(sessionId) ?? [];
    this.histories.set(sessionId, history);
    let closed = false;
    let current: RunCtx | null = null;
    let wake: (() => void) | null = null;
    return {
      sessionId,
      died: new Promise<string>(() => {}),
      history: () => history.map((m) => ({ ...m })),
      abort: async () => { if (current) current.aborted = true; wake?.(); },
      ...(this.steers && {
        steer: async (prompt: string) => {
          if (!current || current.ended) return false;
          current.steered.push(prompt);
          return true;
        },
      }),
      // Closing an agent ends its run, as a real engine's process going would.
      close: async () => { if (current) current.aborted = true; wake?.(); if (!closed) { closed = true; this.open--; } },
      run: async (prompt: string, opts?: RunOptions): Promise<RunResult> => {
        const m = /the (\w+) task ([a-z0-9]+),/.exec(prompt);
        const ctx: RunCtx = { task: m?.[2] ?? "", kind: m?.[1] ?? "", prompt, n: this.runs.length + 1, aborted: false, ended: false, stream: (e) => o.onStream?.(e), steered: [],
          take: () => ctx.steered.splice(0).map((p) => {
            const said = /<chat>\n([\s\S]*)\n<\/chat>/.exec(p)?.[1] ?? p;
            history.push({ id: `u${history.length}`, role: "user", blocks: [{ type: "text", text: said }] } as ChatMessage);
            o.onStream?.({ t: "message", message: history.at(-1)! });
            return said;
          }) };
        current = ctx;
        this.runs.push(ctx);
        this.live++;
        this.peak = Math.max(this.peak, this.live);
        const userId = `u${history.length}`;
        history.push({ id: userId, role: "user", blocks: [{ type: "text", text: prompt }] } as ChatMessage);
        o.onStream?.({ t: "message", message: history.at(-1)! });
        try {
          // A run the writer stops ends at once, whatever the script is waiting for.
          const plan = await Promise.race([Promise.resolve(this.script(ctx)), new Promise<RunPlan>((r) => { wake = () => r({ fail: "aborted" }); })]);
          if (ctx.aborted) return { ok: false, result: "", error: "aborted" };
          if ("throws" in plan) throw new Error(plan.throws);
          if ("fail" in plan) return { ok: false, result: "", error: plan.fail };
          const text = "text" in plan ? plan.text : "Done.";
          const msg = { id: `a${history.length}`, role: "assistant", blocks: [{ type: "text", text }] } as ChatMessage;
          history.push(msg);
          o.onStream?.({ t: "message", message: msg });
          if ("text" in plan) return { ok: true, result: plan.text };
          const why = opts?.check?.(plan) ?? null;
          return why ? { ok: true, result: "", error: why } : { ok: true, result: "", reply: plan };
        } finally {
          this.live--;
          ctx.ended = true;
          current = null;
        }
      },
    };
  }

  /** The runs for task `task`. */
  runsFor(task: string) { return this.runs.filter((r) => r.task === task); }
}

// ---------------------------------------------------------------- the app and its server

// Bun's own fetch and web types: happy-dom brings its own, and the server in this process must keep Bun's.
const NATIVE = ["fetch", "Request", "Response", "Headers", "ReadableStream", "WritableStream", "TransformStream", "TextDecoderStream", "TextEncoderStream", "TextEncoder", "TextDecoder", "AbortController", "AbortSignal", "Blob", "FormData", "URL", "URLSearchParams", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask"] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface App {
  root: string;
  docs: string;
  base: string;
  model: ScriptedEngine;
  /** Puts a page on disk, as the writer's file. */
  write(id: string, markdown: string): void;
  /** The file on disk now. */
  file(id: string): string;
  body(id: string): string;
  records(id: string): Record<string, TaskRecord>;
  open(id: string): Promise<PageView>;
  /** Renders something other than a page (the chat on its own, say); closed by `close()`. */
  mount(node: ReactNode): Promise<{ el: HTMLElement; close(): Promise<void> }>;
  /** What the app logged as an error, and what its handlers threw: a browser suite's "no page logged an error". */
  errors: string[];
  /** The path of every request the app made, in order. */
  requests: string[];
  /** Makes the page's saves fail as a dropped connection would, until called with `false`. */
  blockSaves(id: string, on?: boolean): void;
  /** Waits until `ok()` holds, polling; fails naming `what` (and showing `detail()`) after `ms`. */
  until(what: string, ok: () => boolean | Promise<boolean>, ms?: number, detail?: () => string): Promise<void>;
  close(): Promise<void>;
}

export interface AppOptions {
  /** Real engines in place of the scripted model, given the project's root. `App.model` then has no part in it. */
  engines?: (root: string) => AgentEngine[] | Promise<AgentEngine[]>;
  /** Routes that take the place of the app's own, path by path. */
  routes?: Record<string, unknown>;
}

/**
 * Starts the server and the fake DOM for one test file. `env` sets settings (the agent's pauses are short by
 * default). Every page opened is closed by `close()`, and every agent stopped.
 */
export async function startApp(env: Record<string, string> = {}, opts: AppOptions = {}): Promise<App> {
  // A project of its own, entered: the pages are its working copies, and the working directory is what says which
  // project the server is in (`test/project-dir.ts`).
  const P = projectDir("solip-dom-");
  const root = P.root;
  const docs = P.docs;
  P.enter();
  const settings: Record<string, string> = { AGENT_SETTLE_MS: "30", AGENT_GAP_MS: "30", AGENT_WAIT_MS: "600000", ...env };
  const before = Object.fromEntries(Object.keys(settings).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settings);

  const natives = Object.fromEntries(NATIVE.map((k) => [k, (globalThis as any)[k]]));
  await import("../../src/plugins");
  const { apiRoutes } = await import("../../src/server/routes");
  const { setEngines } = await import("../../src/server/agent/engines");
  const model = new ScriptedEngine();
  const oldEngines = setEngines(opts.engines ? await opts.engines(root) : [model.engine]);
  const server = Bun.serve({ port: 0, routes: { ...apiRoutes(), ...opts.routes } as any, fetch: () => new Response("Not found", { status: 404 }) });
  const base = `http://localhost:${server.port}`;

  GlobalRegistrator.register({ url: `${base}/`, settings: { navigator: { userAgent: "Mozilla/5.0 (Macintosh)" } } as any });
  for (const k of NATIVE) (globalThis as any)[k] = natives[k];
  // The page asks for `/api/...`, as from its own origin.
  const requests: string[] = [];
  const blocked = new Set<string>();
  globalThis.fetch = ((input: any, init?: any) => {
    const path = new URL(String(input?.url ?? input), base).pathname;
    requests.push(path);
    if (init?.method === "PUT" && blocked.has(path)) return Promise.reject(new TypeError("Failed to fetch"));
    return natives.fetch(typeof input === "string" && input.startsWith("/") ? base + input : input, init);
  }) as typeof fetch;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  // React warns about every update outside `act`; here they all are, as in a browser.
  const consoleError = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { if (typeof a[0] === "string" && /not wrapped in act|HydrateFallback/.test(a[0])) return; errors.push(a.map(String).join(" ")); consoleError(...a); };
  window.addEventListener("error", (e) => errors.push(String((e as ErrorEvent).error ?? (e as ErrorEvent).message)));
  const consoleWarn = console.warn;
  console.warn = (...a: unknown[]) => { if (typeof a[0] === "string" && /HydrateFallback/.test(a[0])) return; consoleWarn(...a); };

  const { parseFile } = await import("../../src/shared/docfile");
  const pages: PageView[] = [];
  const mounted: { close(): Promise<void> }[] = [];

  const until: App["until"] = async (what, ok, ms = 6000, detail) => {
    const t = Date.now();
    while (!(await ok())) {
      if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}${detail ? `\n${detail()}` : ""}`);
      await sleep(15);
    }
  };
  const app: App = {
    root, docs, base, model, until, errors, requests,
    blockSaves: (id, on = true) => { if (on) blocked.add(`/api/pages/${id}`); else blocked.delete(`/api/pages/${id}`); },
    write: (id, markdown) => { writeFileSync(join(docs, `${id}.md`), markdown); pageChanged(id); },
    file: (id) => readFileSync(join(docs, `${id}.md`), "utf8"),
    body: (id) => parseFile(app.file(id)).markdown,
    records: (id) => parseFile(app.file(id)).block.tasks ?? {},
    async open(id) {
      const p = await openPage(app, id);
      pages.push(p);
      return p;
    },
    async mount(node) {
      const { createRoot } = await import("react-dom/client");
      const el = document.createElement("div");
      document.body.append(el);
      const r = createRoot(el);
      r.render(node);
      let closed = false;
      const view = { el, async close() { if (closed) return; closed = true; r.unmount(); el.remove(); await sleep(30); } };
      mounted.push(view);
      return view;
    },
    async close() {
      for (const p of pages.splice(0)) await p.close();
      for (const m of mounted.splice(0)) await m.close();
      const { stopAllPages } = await import("../../src/server/agent/pageAgents");
      const { closeChats } = await import("../../src/server/chat");
      await stopAllPages("test over");
      await closeChats("test over");
      server.stop(true);
      setEngines(oldEngines);
      console.error = consoleError;
      console.warn = consoleWarn;
      await GlobalRegistrator.unregister();
      for (const k of NATIVE) (globalThis as any)[k] = natives[k];
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      P.done();
    },
  };
  return app;
}

// ---------------------------------------------------------------- a page, as the writer has it

export interface PageView {
  id: string;
  el: HTMLElement;
  editor: Editor;
  /** The page's markdown as the editor holds it. */
  readonly markdown: string;
  /** The text the writer sees (the editor's DOM). */
  readonly text: string;
  /** What the status bar says. */
  readonly status: string;
  /** What the top bar says of saving: "Saved", "Unsaved changes", "Saving…", "Can't save, retrying…". */
  readonly saveLabel: string;
  /** The banners under the top bar, as text. */
  readonly banners: string[];
  $(sel: string): HTMLElement | null;
  $$(sel: string): HTMLElement[];
  /** Puts the caret at the end of `text` (or its start), as a click there would. */
  caret(text: string, at?: "end" | "start", nth?: number): void;
  select(text: string, nth?: number): void;
  /** Types at the caret. */
  type(text: string): void;
  typeAfter(anchor: string, text: string): void;
  replace(old: string, text: string): void;
  remove(text: string): void;
  /** Deletes task `task` (its point node, or its range's mark), as the writer's Backspace would. */
  removeMarker(task: string): void;
  /** A key, as ProseMirror's keymap reads it: "Mod-.", "Mod-Alt-y", "Enter", "Escape". */
  press(key: string, target?: Element): void;
  click(target: string | Element): void;
  /** Types `value` into a text box (a React-controlled one too), as the writer's typing would. */
  fill(box: HTMLTextAreaElement | HTMLInputElement, value: string): void;
  /** A button anywhere in the document (the side card and dialogs live outside the page), by its text or label. */
  button(label: string | RegExp): HTMLButtonElement | null;
  /** Waits until the page has saved everything the writer typed. */
  saved(): Promise<void>;
  until(what: string, ok: () => boolean, ms?: number): Promise<void>;
  close(): Promise<void>;
}

/** A key, as ProseMirror's keymap reads it: "Mod-.", "Mod-Alt-y", "Enter", "Escape". */
export function pressKey(target: EventTarget, key: string) {
  const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
  const parts = key.split("-");
  const name = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "Mod" ? (mac ? "Meta" : "Ctrl") : p)));
  target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, metaKey: mods.has("Meta"), ctrlKey: mods.has("Ctrl"), altKey: mods.has("Alt"), shiftKey: mods.has("Shift") }));
}
/** What a real click sends: some controls act on mousedown (the status bar keeps the editor's focus that way). */
export function clickOn(t: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  (t as HTMLElement).click();
}
/** Types `value` into a text box (a React-controlled one too), as the writer's typing would. */
export function fillBox(box: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = box instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openPage(app: App, id: string): Promise<PageView> {
  const { createRoot } = await import("react-dom/client");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const { Sheet, sheetLoader } = await import("../../src/app/pages/Sheet");
  const { docToMarkdown, docText } = await import("../../src/shared/docfile");
  const router = createMemoryRouter([{ path: "/d/*", element: <Sheet />, loader: sheetLoader }], { initialEntries: [`/d/${id}`] });
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  root.render(<RouterProvider router={router} />);
  await app.until(`page ${id} to load`, () => !!(el.querySelector(".ProseMirror") as any)?.editor);
  const editor = (el.querySelector(".ProseMirror") as any).editor as Editor;
  // happy-dom keeps no real DOM selection: ProseMirror reading it back (on selectionchange, once the view has focus)
  // would put the caret at the top of the page. The caret is the editor state's, set as the writer's clicks would.
  const observer = (editor.view as any).domObserver;
  observer.disconnectSelection();
  observer.connectSelection = () => {};
  // The page is ready when the editor is: its autofocus (a timer after mount, then a frame) has put the caret where a
  // fresh page has it. A writer can't click before that; a test that did would lose its caret to it.
  await app.until(`page ${id}'s editor to start`, () => (editor as any).isInitialized === true);
  await sleep(40);

  const find = (text: string, nth = 0) => {
    const dt = docText(editor.state.doc);
    let i = -1;
    for (let k = 0; k <= nth; k++) i = dt.text.indexOf(text, i + 1);
    if (i < 0) throw new Error(`"${text}" is not in the page:\n${dt.text}`);
    return { from: dt.toPos(i)!, to: dt.toPos(i + text.length)! };
  };
  const dispatch = (f: (tr: Editor["state"]["tr"]) => void) => { const tr = editor.state.tr; f(tr); editor.view.dispatch(tr); };
  let closed = false;
  const view: PageView = {
    id, el, editor,
    get markdown() { return docToMarkdown(editor.state.doc); },
    get text() { return editor.view.dom.textContent ?? ""; },
    get status() { return el.querySelector(".statusbar")?.textContent ?? ""; },
    get saveLabel() { return el.querySelector(".topbar .save")?.textContent ?? ""; },
    get banners() { return [...el.querySelectorAll(".banner")].map((b) => b.textContent ?? ""); },
    $: (sel) => el.querySelector(sel) as HTMLElement | null,
    $$: (sel) => [...el.querySelectorAll(sel)] as HTMLElement[],
    caret(text, at = "end", nth = 0) { const r = find(text, nth); dispatch((tr) => tr.setSelection(TextSelection.create(tr.doc, at === "end" ? r.to : r.from))); editor.view.focus(); },
    select(text, nth = 0) { const r = find(text, nth); dispatch((tr) => tr.setSelection(TextSelection.create(tr.doc, r.from, r.to))); editor.view.focus(); },
    type(text) { dispatch((tr) => tr.insertText(text)); },
    typeAfter(anchor, text) { view.caret(anchor); view.type(text); },
    replace(old, text) { const r = find(old); dispatch((tr) => tr.insertText(text, r.from, r.to)); },
    removeMarker(task) {
      const tr = editor.state.tr;
      let done = false;
      editor.state.doc.descendants((node, pos) => {
        if (done) return false;
        if (node.attrs?.id === task && node.type.name === "markerPoint") { tr.delete(pos, pos + node.nodeSize); done = true; }
        const m = node.marks?.find((mk) => mk.type.name === "markerRange" && mk.attrs.id === task);
        if (m) tr.removeMark(pos, pos + node.nodeSize, m.type);
      });
      editor.view.dispatch(tr);
    },
    remove(text) { const r = find(text); dispatch((tr) => tr.delete(r.from, r.to)); },
    press(key, target = editor.view.dom) { pressKey(target, key); },
    click(target) {
      const t = typeof target === "string" ? el.querySelector(target) ?? [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === target || b.getAttribute("aria-label") === target) : target;
      if (!t) throw new Error(`nothing to click: ${target}`);
      clickOn(t);
    },
    fill: fillBox,
    button: (label) => ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => { const t = b.textContent?.trim() ?? "", a = b.getAttribute("aria-label") ?? "", ti = b.title ?? ""; return typeof label === "string" ? t === label || a === label : label.test(t) || label.test(a) || label.test(ti); }) ?? null,
    saved: () => app.until(`page ${id} to save`, () => view.saveLabel === "Saved" && app.body(id).trim() === docToMarkdown(editor.state.doc).trim(), 6000, () => `status: ${view.status}\neditor:\n${docToMarkdown(editor.state.doc)}\ndisk:\n${app.body(id)}`),
    until: (what, ok, ms) => app.until(what, ok, ms, () => `editor:\n${view.markdown}\ndisk:\n${app.file(id)}\nbanners: ${view.banners.join(" | ")}`),
    async close() {
      if (closed) return;
      closed = true;
      root.unmount();
      el.remove();
      await sleep(30); // the streams see the abort
    },
  };
  return view;
}
