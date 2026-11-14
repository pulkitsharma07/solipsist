import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyChatEvent, chatRole, type ChatBlock, type ChatEvent, type ChatMessage } from "../../../shared/chat";
import type { AgentEngine, AgentSession, AgentStep, EngineModel } from "../engine";
import { brief, clip, DETAIL } from "../engine";
import { config } from "../../config";
import { root } from "../../runtime";
import { insideDir } from "./guard";
import { ALL_TOOLS, callReplyTool, toolsOf, type ReplyTool, type Turn } from "../replyTools";
import type { Reply } from "../../suggest";

/** The OpenRouter key (`pi.openrouter_key`). Pi's own login (`/login openrouter`) or `OPENROUTER_API_KEY` work too. */
export const PI_KEY_ENV = "SOLIPSIST_OPENROUTER_KEY";

/**
 * A run's error, said so the writer can fix it: OpenRouter refusing the key (401) names which key it was, since one
 * set here is used instead of Pi's own login.
 */
export function runError(message: string): string {
  if (!/\b401\b/.test(message)) return message;
  return config().pi.openrouter_key
    ? `OpenRouter refused the key in ${PI_KEY_ENV} (pi.openrouter_key): fix it, or remove it to use Pi's own login. (${message})`
    : `OpenRouter refused Pi's key: set ${PI_KEY_ENV}, or log in again with \`pi\` (/login openrouter). (${message})`;
}
/** The tools a Pi agent may use (`pi.tools`); the reply tools are added when the agent gets them. */
export const piTools = () => config().pi.tools;
/** The shortlist the picker offers at a glance (`pi.models`): `<provider>/<model>` ids, the first being the default. */
const piShortlist = () => config().pi.models;
/** The provider a bare model id belongs to: OpenRouter, where Pi's own defaults come from. */
export const PI_PROVIDER = "openrouter";

/** The model a Pi choice names: `<provider>/<model>`, e.g. `openrouter/~deepseek/deepseek-flash-latest`. Undefined when Pi has none. */
export function piModelFor(rt: ModelRuntime, id: string) {
  const slash = id.indexOf("/");
  return slash > 0 ? rt.getModel(id.slice(0, slash), id.slice(slash + 1)) : undefined;
}

/** The vendor a model is grouped under: its name's own prefix ("DeepSeek: DeepSeek Flash"), else its id's, else the provider. */
export const piVendor = (m: { id: string; name?: string; provider?: string }): string => {
  const name = String(m.name ?? "");
  const colon = name.indexOf(":");
  if (colon > 0) return name.slice(0, colon).trim();
  const bare = m.id.replace(/^~/, "");
  const slash = bare.indexOf("/");
  return slash > 0 ? bare.slice(0, slash) : String(m.provider ?? "");
};
/** A model's title in the picker: its own name, without the vendor it is already listed under. */
const piTitle = (m: { id: string; name?: string }): string => {
  const name = String(m.name ?? m.id);
  const colon = name.indexOf(":");
  return (colon > 0 ? name.slice(colon + 1) : name).trim();
};
/** A model id with no catalog entry behind it (Pi is cold, or the writer named one Pi doesn't have), titled from its id. */
const piPlain = (id: string): EngineModel => ({ id, title: id.replace(/^[^/]+\//, "").replace(/^~/, "").replace(/-latest$/, "") });
/** A model of the writer's own Pi as the picker shows it: `<provider>/<model>`, grouped by vendor, with its size and price. */
export const piModel = (m: any): EngineModel => ({
  id: `${m.provider}/${m.id}`,
  title: piTitle(m),
  vendor: piVendor(m),
  ...(typeof m.contextWindow === "number" && { context: m.contextWindow }),
  ...(typeof m.cost?.input === "number" && { inUsd: m.cost.input }),
  ...(typeof m.cost?.output === "number" && { outUsd: m.cost.output }),
});

const text = (content: unknown): string =>
  Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).filter(Boolean).join("\n") : typeof content === "string" ? content : "";

/** Pi's session events as steps for the panel and the margin (null: not worth showing). */
export function piStep(e: any): AgentStep | null {
  if (e.type === "tool_execution_start") {
    const args = JSON.stringify(e.args ?? {});
    return { kind: "tool", text: `${e.toolName} ${clip(args, 200)}`, detail: clip(JSON.stringify(e.args ?? {}, null, 2), DETAIL), name: String(e.toolName), brief: clip(brief(e.args), 200) };
  }
  if (e.type === "tool_execution_end") {
    const body = text(e.result?.content) || (e.isError ? "error" : "");
    return { kind: "tool_result", text: clip(body, 200), detail: clip(body, DETAIL) };
  }
  if (e.type === "message_end" && e.message?.role === "assistant") {
    const said = text(e.message.content).trim();
    return said ? { kind: "text", text: clip(said), detail: clip(said, DETAIL) } : null;
  }
  return null;
}

/** A tool call as the chat shows it: its name, what it is about, its arguments. */
const toolBlock = (c: any): Extract<ChatBlock, { type: "tool" }> => ({
  type: "tool", id: String(c.id), name: String(c.name), brief: clip(brief(c.arguments), 200), args: clip(JSON.stringify(c.arguments ?? {}, null, 2), DETAIL),
  // One of ours (`replyTools.ts`): the chat shows it as the result it gave, not as work it did.
  ...(ALL_TOOLS.some((t) => t.name === String(c.name)) && { reply: true }),
});
/** An assistant message's parts, one block for each part of Pi's (so a streamed part's index is its block's). */
const assistantBlocks = (m: any): ChatBlock[] =>
  (Array.isArray(m.content) ? m.content : []).map((c: any): ChatBlock =>
    c?.type === "toolCall" ? toolBlock(c) : c?.type === "thinking" ? { type: "thinking", text: c.redacted ? "" : String(c.thinking ?? "") } : { type: "text", text: String(c?.text ?? "") });
const stopped = (m: any) => (m.stopReason === "error" || m.stopReason === "aborted" ? String(m.errorMessage ?? m.stopReason) : undefined);
const usageStats = (m: any) => ({ model: m.model, input: m.usage?.input, output: m.usage?.output, costUsd: m.usage?.cost?.total });

/** Pi's conversation as the chat shows it: the writer's words and Solipsist's prompts apart, each tool call with its result. */
export function piHistory(messages: readonly any[], working = false): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, Extract<ChatBlock, { type: "tool" }>>();
  messages.forEach((m, i) => {
    const at = Number(m.timestamp ?? 0);
    if (m.role === "user") {
      const c = chatRole(text(m.content));
      out.push({ id: `h${i}`, role: c.role, blocks: [{ type: "text", text: c.text }], at });
    } else if (m.role === "assistant") {
      const blocks = assistantBlocks(m);
      for (const b of blocks) if (b.type === "tool") tools.set(b.id, b);
      const error = stopped(m);
      out.push({ id: `h${i}`, role: "assistant", blocks, at, stats: usageStats(m), ...(error && { error }) });
    } else if (m.role === "toolResult") {
      const b = tools.get(String(m.toolCallId));
      if (b) Object.assign(b, { result: clip(text(m.content) || (m.isError ? "error" : ""), DETAIL), isError: !!m.isError });
    }
  });
  // Mid-run, a tool call with no result yet is still running.
  if (working) for (const b of tools.values()) if (b.result === undefined) b.running = true;
  return out;
}

/**
 * Pi's session events as chat events, as they stream: each message as it starts, text and thinking as they come, a
 * tool call once written and its result once run, and each reply whole at its end with what it cost and how fast it
 * came (output tokens over the time since it began to stream, when that is long enough to measure).
 */
export function piStreamer(emit: (e: ChatEvent) => void): ((e: any) => void) & { partial(): ChatMessage | null } {
  let n = 0;
  let cur: { id: string; started: number; firstAt?: number } | null = null;
  // The reply streaming now, as far as it has come: Pi adds a message to its own list only at its end, so a chat that
  // opens mid-reply gets it from here.
  let partial: ChatMessage | null = null;
  const send = emit;
  emit = (e) => {
    if (e.t === "message" && e.message.role === "assistant") partial = e.message.streaming ? e.message : null;
    else if (partial && (e.t === "delta" || e.t === "tool") && e.id === partial.id) partial = applyChatEvent([partial], e)[0]!;
    send(e);
  };
  return Object.assign((e: any) => {
    const now = Date.now();
    if (e.type === "message_start" && e.message?.role === "assistant") {
      cur = { id: `s${now}-${n++}`, started: now };
      emit({ t: "message", message: { id: cur.id, role: "assistant", blocks: [], at: now, streaming: true } });
    } else if (e.type === "message_start" && e.message?.role === "user") {
      const c = chatRole(text(e.message.content));
      emit({ t: "message", message: { id: `s${now}-${n++}`, role: c.role, blocks: [{ type: "text", text: c.text }], at: now } });
    } else if (e.type === "message_update" && cur) {
      const a = e.assistantMessageEvent;
      if (a?.type === "text_delta" || a?.type === "thinking_delta") {
        cur.firstAt ??= now;
        emit({ t: "delta", id: cur.id, block: a.contentIndex, kind: a.type === "text_delta" ? "text" : "thinking", delta: String(a.delta) });
      } else if (a?.type === "toolcall_delta") cur.firstAt ??= now;
      else if (a?.type === "toolcall_end") emit({ t: "tool", id: cur.id, block: a.contentIndex, tool: { ...toolBlock(a.toolCall), running: true } });
    } else if (e.type === "message_end" && e.message?.role === "assistant" && cur) {
      const m = e.message;
      const stats = usageStats(m);
      // Only over a stretch long enough to mean something: a reply that came whole (nothing streamed) has no rate.
      const secs = cur.firstAt === undefined ? 0 : (now - cur.firstAt) / 1000;
      const blocks = assistantBlocks(m).map((b) => (b.type === "tool" ? { ...b, running: true } : b));
      const error = stopped(m);
      emit({ t: "message", message: { id: cur.id, role: "assistant", blocks, at: cur.started, stats: { ...stats, ms: now - cur.started, ...(stats.output && secs >= 0.25 && { tokensPerSec: stats.output / secs }) }, ...(error && { error }) } });
      cur = null;
    } else if (e.type === "tool_execution_end") {
      const body = text(e.result?.content) || (e.isError ? "error" : "");
      emit({ t: "tool_result", toolId: String(e.toolCallId), result: clip(body, DETAIL), isError: !!e.isError, ...(typeof e.durationMs === "number" && { durationMs: Math.round(e.durationMs) }) });
    }
  }, { partial: () => partial });
}

/** A question Pi (or one of its extensions) wanted to ask, as an error step: nobody is there to answer it. */
const asked = (what: string, title: string, message?: string): AgentStep => {
  const said = [title, message].filter(Boolean).join("\n");
  return { kind: "error", text: clip(`Pi asked for permission (${what}), which can't be answered here, so it was refused: ${said.replace(/\s+/g, " ")}`), detail: clip(said, DETAIL) };
};

/**
 * Keeps Pi's `write` and `edit` to the agent's own image folder: the page is never written by the agent (it replies
 * with a suggestion), and nothing else in the project is its to change. Bash is not inspected.
 */
export function writeGuard(images: string, cwd: string) {
  const allowed = resolve(images);
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", (e) => {
      if (e.toolName !== "write" && e.toolName !== "edit") return;
      const path = String((e.input as { path?: unknown }).path ?? "");
      if (insideDir(allowed, cwd, path)) return;
      return { block: true, reason: `Writing is allowed only in ${allowed}. The page is not yours to write: reply with a suggestion.` };
    });
  };
}

/**
 * A reply tool (`replyTools.ts`) as Pi's: a call that can't be used is an error the model sees and can fix; one that
 * can is the run's reply, and ends the turn.
 */
export const piReplyTool = (t: ReplyTool, turn: Turn): ToolDefinition => ({
  name: t.name,
  label: t.label,
  description: t.description,
  promptSnippet: t.description,
  parameters: t.parameters,
  async execute(_id, params) {
    const r = callReplyTool(t, params, turn.check);
    if ("error" in r) return { content: [{ type: "text", text: `Not used: ${r.error}` }], details: undefined, isError: true };
    turn.reply = r.reply;
    return { content: [{ type: "text", text: "Done: the writer will see it. Stop here." }], details: undefined, terminate: true };
  },
});

/**
 * The UI Pi's extensions get. Pi runs headless here, so a prompt (a permission check, a choice) can't be answered: it
 * is reported as an error and refused, the way a declined prompt would be. Error notices are reported too.
 */
export function promptRefusingUI(report: (s: AgentStep) => void): ExtensionUIContext {
  const none = () => {};
  return {
    select: async (title: string) => { report(asked("a choice", title)); return undefined; },
    confirm: async (title: string, message: string) => { report(asked("a yes or no", title, message)); return false; },
    input: async (title: string) => { report(asked("an answer", title)); return undefined; },
    editor: async (title: string) => { report(asked("some text", title)); return undefined; },
    custom: async () => { report(asked("an interactive screen", "")); return undefined as any; },
    notify: (message: string, type?: string) => { if (type === "error") report({ kind: "error", text: clip(message), detail: clip(message, DETAIL) }); },
    onTerminalInput: () => none,
    setStatus: none, setWorkingMessage: none, setWorkingVisible: none, setWorkingIndicator: none, setHiddenThinkingLabel: none,
    setWidget: none, setFooter: none, setHeader: none, setTitle: none, pasteToEditor: none, setEditorText: none,
    getEditorText: () => "", addAutocompleteProvider: none, setEditorComponent: none, getEditorComponent: () => undefined,
    theme: undefined as any, getAllThemes: () => [], getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: none,
  } as unknown as ExtensionUIContext;
}

/**
 * Whether Pi may load the project's own `.pi` resources (settings, extensions, MCP servers), decided as the `pi` CLI
 * does: no such resources, a saved decision (`/trust`), or the `defaultProjectTrust` setting. Left at "ask", the CLI
 * would prompt: here that is reported as an error, and the project's resources are left out.
 */
export function projectTrust(cwd: string, agentDir: string, settings: SettingsManager, report: (s: AgentStep) => void): boolean {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const saved = new ProjectTrustStore(agentDir).get(cwd);
  if (saved !== null) return saved;
  const setting = settings.getDefaultProjectTrust();
  if (setting === "always") return true;
  if (setting === "never") return false;
  report(asked("to trust the project folder", `Trust project folder?\n${cwd}`, `Its .pi settings, extensions and MCP servers were not loaded. Run \`pi\` in ${cwd} and trust it, or set defaultProjectTrust.`));
  return false;
}

/** Whether Pi has a login of its own saved, for any provider (`auth.json`, written by `pi`'s `/login`). */
export function piAuthSaved(agentDir: string): boolean {
  try {
    const auth = join(agentDir, "auth.json");
    return existsSync(auth) && Object.keys(JSON.parse(readFileSync(auth, "utf8"))).length > 0;
  } catch { return false; }
}

/** Where Pi keeps the sessions of folder `cwd`, as its CLI does (Pi doesn't export its own function for it). */
export const piSessionDir = (agentDir: string, cwd: string) => join(resolve(agentDir), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

/** The file of Pi session `id` among the sessions Pi keeps for `cwd` (`<time>_<id>.jsonl`), or null. */
export function piSessionFile(agentDir: string, cwd: string, id: string): string | null {
  const dir = piSessionDir(agentDir, cwd);
  try {
    const name = readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`));
    return name ? join(dir, name) : null;
  } catch { return null; }
}

export interface PiOptions {
  /** Pi's config directory. By default Pi's own (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). */
  agentDir?(): string;
  /** The model runtime and model to use (tests pass a fake). By default: Pi's, with the `.env` key for OpenRouter. */
  runtime?(): Promise<ModelRuntime>;
  model?(runtime: ModelRuntime, id: string): any;
}

/**
 * Pi (`@earendil-works/pi-coding-agent`), in this process, configured the way the `pi` CLI would be in the project
 * folder: its global and project settings, extensions, skills, context files, MCP servers and default tools, with no
 * limits added. One session per agent, kept between runs.
 *
 * The models are the writer's own: every one their Pi has credentials for, read from Pi's catalog on disk (never over
 * the network, `allowModelNetwork: false`, so the list is as fresh as their last `pi` refresh). `pi.models` is the
 * shortlist the picker shows at a glance; the rest are there to be searched.
 */
export function piEngine(opts: PiOptions = {}): AgentEngine {
  const agentDir = () => opts.agentDir?.() ?? getAgentDir();
  let shared: Promise<ModelRuntime> | undefined;
  const runtimeFor = (dir: string) => (shared ??= (async () => {
    const rt = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      // Pi's refreshed catalog, where its CLI keeps it: the models the writer actually has.
      modelsStorePath: join(dir, "models-store.json"),
      allowModelNetwork: false,
    });
    const key = config().pi.openrouter_key;
    if (key) await rt.setRuntimeApiKey(PI_PROVIDER, key);
    return rt;
  })().catch((e) => { shared = undefined; throw e; }));
  const runtime = () => (opts.runtime ?? (() => runtimeFor(agentDir())))();

  /** Every model the writer's Pi can run, as the picker shows them. Empty until `warm` has read Pi's catalog. */
  let known: EngineModel[] = [];
  /** Pi's own default model (`defaultProvider`/`defaultModel` in its settings), as a choice id, or null. */
  let piDefault: string | null = null;
  /** What the runtime and the catalog above were read with. */
  let readWith: string | null = null;
  /**
   * Drops the runtime and the catalog when what they were read with has changed — another Pi folder, another key —
   * since a catalog read with a key that is gone would still list models nobody can run. Called wherever they are
   * used, so the next `warm` reads them again.
   */
  const fresh = () => {
    const now = `${agentDir()}\u0000${config().pi.openrouter_key ?? ""}\u0000${process.env.OPENROUTER_API_KEY ?? ""}`;
    if (now === readWith) return;
    readWith = now;
    shared = undefined;
    known = [];
    piDefault = null;
  };
  /** The catalog entry an id (`<provider>/<model>`) names. */
  const found = (id: string) => known.find((m) => m.id === id);
  /** The shortlist: Pi's own default first, then `pi.models`, keeping only what this Pi can actually run. */
  const shortlist = (): EngineModel[] => {
    const picked: EngineModel[] = [];
    const add = (m: EngineModel) => { if (!picked.some((p) => p.id === m.id)) picked.push(m); };
    if (piDefault) {
      const m = found(piDefault);
      if (m) add({ ...m, note: "Pi's own default" });
      else if (!known.length) add({ ...piPlain(piDefault), note: "Pi's own default" });
    }
    for (const id of piShortlist()) {
      const m = found(id);
      if (m) add(m);
      else if (!known.length) add(piPlain(id));
    }
    // Nothing the writer listed is theirs to run: offer the first of what is, rather than an empty picker.
    if (picked.length) return picked;
    return known.length ? known.slice(0, 6) : piShortlist().map(piPlain);
  };
  return {
    name: "pi",
    title: "Pi",
    chats: true,
    replyTools: true,
    reportsCost: true,
    // `write`/`edit` are guarded (`writeGuard`), but `bash` is not: plan 3 item 4, decided 2026-11-07.
    confined: false,
    async warm() {
      fresh();
      const rt = await runtime();
      known = rt.getAvailableSnapshot().map(piModel);
      try {
        const s = SettingsManager.create(root(), agentDir());
        const provider = s.getDefaultProvider();
        const model = s.getDefaultModel();
        piDefault = provider && model ? `${provider}/${model}` : null;
      } catch { piDefault = null; }
    },
    models: () => { fresh(); return shortlist(); },
    catalog: () => { fresh(); return known.length ? known : shortlist(); },
    // Before Pi's catalog is read, anything is taken on trust: `start` says plainly when Pi doesn't have it.
    knows: (model) => { fresh(); return !known.length || !!found(model); },
    unavailable: () => {
      fresh();
      return opts.runtime || config().pi.openrouter_key || process.env.OPENROUTER_API_KEY || known.length || piAuthSaved(agentDir())
        ? null
        : `Set ${PI_KEY_ENV} (in .env or the environment), or log in with \`pi\` (/login openrouter), to use Pi.`;
    },
    async start(o): Promise<AgentSession> {
      fresh();
      const dir = agentDir();
      // Where Solipsist runs, as the `pi` CLI would be: its context files and project `.pi` (trusted) load.
      const cwd = o.root;
      const runtime = await (opts.runtime ?? (() => runtimeFor(dir)))();
      const model = opts.model ? opts.model(runtime, o.model) : piModelFor(runtime, o.model);
      if (!model) throw new Error(`Pi does not know the model ${o.model}.`);
      const settingsManager = SettingsManager.create(cwd, dir);
      // The CLI's built-in extensions; settings can still turn each off (`-builtin:mcp`).
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir: dir, settingsManager,
        // After the writer's own APPEND_SYSTEM.md, if any, not instead of it.
        appendSystemPromptOverride: (base) => (o.system ? [...base, o.system] : base),
        extensionFactories: [
          writeGuard(o.images, cwd),
          { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
          { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
          { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
        ],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => projectTrust(cwd, dir, settingsManager, o.onStep) });
      // Kept in Pi's sessions folder, as the CLI keeps them, so the conversation outlives this agent: a later run, or
      // the chat, picks it up from there.
      const found = o.resume ? piSessionFile(dir, cwd, o.resume) : null;
      if (o.resume && !found) o.onStep({ kind: "error", text: `Pi's session ${o.resume.slice(0, 8)} is gone: starting a new one.` });
      const sessions = piSessionDir(dir, cwd);
      mkdirSync(sessions, { recursive: true });
      const sessionManager = found ? SessionManager.open(found) : SessionManager.create(cwd, sessions);
      const turn: Turn = {};
      const customTools = toolsOf(o.replyTools)?.map((t) => piReplyTool(t, turn));
      const tools = [...piTools(), ...(customTools ?? []).map((t) => t.name)];
      const { session } = await createAgentSession({ cwd, agentDir: dir, modelRuntime: runtime, model, resourceLoader, settingsManager, sessionManager, tools, ...(customTools && { customTools }) });
      let cost = 0;
      const stream = piStreamer(o.onStream ?? (() => {}));
      let working = false;
      const off = session.subscribe((e: any) => {
        if (e.type === "message_end" && e.message?.role === "assistant") cost += Number(e.message.usage?.cost?.total ?? 0);
        const s = piStep(e);
        if (s) o.onStep(s);
        stream(e);
      });
      await session.bindExtensions({
        uiContext: promptRefusingUI(o.onStep),
        onError: (err: any) => o.onStep({ kind: "error", text: clip(`Pi extension ${err?.extensionPath ?? ""}: ${err?.error ?? err}`) }),
      });
      o.onStep({ kind: "init", text: `session ${session.sessionId.slice(0, 8)}${found ? " (resumed)" : ""} · ${o.model}` });
      let closed = false;
      return {
        sessionId: session.sessionId,
        resumed: !!found,
        history: () => { const p = stream.partial(); return [...piHistory(session.messages, working), ...(p ? [p] : [])]; },
        // A message steered in and not yet read goes with the run it was for.
        abort: () => { session.clearQueue(); return session.abort(); },
        async steer(prompt) {
          if (!working) return false;
          await session.steer(prompt);
          return true;
        },
        async run(prompt, runOpts) {
          cost = 0;
          turn.check = runOpts?.check;
          turn.reply = undefined;
          working = true;
          try {
            await session.prompt(prompt);
            // Steered in as the run was ending, after Pi last looked: still queued, and still this run's to answer.
            for (let i = 0; i < 5 && session.pendingMessageCount > 0; i++) {
              const q = session.clearQueue();
              const more = [...q.steering, ...q.followUp];
              if (!more.length) break;
              await session.prompt(more.join("\n\n"));
            }
          } catch (e: any) {
            return { ok: false, result: "", costUsd: cost, error: clip(runError(String(e?.message ?? e))) };
          } finally {
            working = false;
          }
          const last = [...session.messages].reverse().find((m: any) => m.role === "assistant") as any;
          // The whole reply: it carries the run's result. Whoever shows it clips it.
          const said = session.getLastAssistantText() ?? "";
          if (last && (last.stopReason === "error" || last.stopReason === "aborted")) return { ok: false, result: said, costUsd: cost, error: clip(runError(String(last.errorMessage ?? last.stopReason))) };
          // Set by a reply tool during the run, which the narrowing above can't see.
          const reply = turn.reply as Reply | undefined;
          return { ok: true, result: said, ...(reply && { reply }), costUsd: cost };
        },
        // It runs in this process: it only stops when closed.
        died: new Promise<string>(() => {}),
        async close() {
          if (closed) return;
          closed = true;
          off();
          await session.abort().catch(() => {});
          session.dispose();
        },
      };
    },
  };
}
