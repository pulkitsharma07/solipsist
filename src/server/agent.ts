import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { versionInfo, versionLine } from "./version";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskAgent } from "../shared/docfile";
import type { ChatMessage } from "../shared/chat";
import type { AgentSession } from "./agent/engine";
import { engineOffers, engines, modelCatalog, modelList, parseChoice, warmEngines } from "./agent/engines";
import { publish } from "./agent/bus";
import { costLimit, spentUsd } from "./agent/budget";
import { asChoice, concurrency, gapMs, imagesDir, instructions, maxRuns, pageFile, recordedAgent, recordedFinish, singleAgent, waitMs } from "./agent/page";
import { agentEngines, agentStates, chatting, markChatting, onRunEnd, PageAgents, pageAgents, runningPages, unmarkChatting } from "./agent/pageAgents";
import { onSettings, readSettings, writeSettings } from "./agent/settings";
import { onPageChat, pageChatStatus } from "./agent/pageChatStatus";
import { pageHash, pendingTasks } from "./agent/page";
import { config } from "./config";
import { canSaveKey, checkKey, forgetKey, keyProblem, saveKey } from "./keyStore";
import { notLocal, type Peer } from "./local";
import { readModifyWrite, validId, withLock } from "./files";
import { scheduleButton } from "./suggest";
import { log, why } from "./log";
import { onPageChanged, root, runtime } from "./runtime";

export {
  kindPromptFile, pageFile, pendingKinds, pendingTasks, promptFor, protocolFile, recordedAgent, systemPrompt,
  type Target,
} from "./agent/page";

export const openAgents = runningPages;

/** Tells the page's agent stream, if one is open, something that happened outside its runs (the chat). */
export const tellPage = (id: string, event: string, data: object) => pageAgents(id)?.say(event, { run: 0, ...data });

/**
 * The run in flight on task `task`, for a chat to look in on before the agent is its own: the conversation so
 * far, and a way to hear when the run ends (`onEnd`, with its error if it failed; the returned function stops
 * listening). Null when no run is on it, or its agent keeps no conversation to show.
 */
export function watchRun(id: string, task: string): { history(): ChatMessage[]; onEnd(f: (end: { error?: string }) => void): () => void } | null {
  const r = pageAgents(id)?.running(task);
  if (!r || (r.session && !r.session.history)) return null;
  return { history: () => r.session?.history?.() ?? [], onEnd: (f) => onRunEnd(id, task, f) };
}

export interface ChatAgent { session: AgentSession; ref: TaskAgent }

/**
 * Lends task `task`'s agent to the chat: the one kept waiting, or its conversation woken from disk. Until
 * `giveBack`, no run is sent to the task. "working" while a run is on it; an error when no agent was kept.
 */
export async function takeAgent(id: string, task: string): Promise<ChatAgent | "working" | { error: string }> {
  if (chatting(id).has(task)) return { error: "A chat on this request is open already." };
  const got = pageAgents(id)?.take(task) ?? null;
  if (got === "working") return "working";
  markChatting(id, task);
  log("chat.open", { page: id, task, agent: got ? "waiting" : "from disk" });
  tellPage(id, "chat", { task });
  if (got) return got;
  const ref = recordedAgent(id, task);
  const engine = ref && engines().find((e) => e.name === ref.engine);
  if (!ref || !engine) { unmarkChatting(id, task); pageAgents(id)?.chatEnded(task); tellPage(id, "chat_end", { task }); log("chat.refused", { page: id, task, reason: "no agent kept" }); return { error: "No agent was kept for this suggestion: its engine can't keep a conversation, or it isn't set up now." }; }
  const scratch = mkdtempSync(join(tmpdir(), "solip-agent-chat-"));
  try {
    mkdirSync(imagesDir(id), { recursive: true });
    const session = await engine.start({ id, file: pageFile(id), images: imagesDir(id), root: root(), scratch, model: ref.model, ...instructions(engine), resume: ref.session, onStep: () => {}, onStream: (e) => publish(id, task, e) });
    // Its scratch directory goes with it.
    const owned: AgentSession = { ...session, close: () => session.close().finally(() => rmSync(scratch, { recursive: true, force: true })) };
    return { session: owned, ref: { ...ref, session: session.sessionId ?? ref.session } };
  } catch (e: any) {
    rmSync(scratch, { recursive: true, force: true });
    unmarkChatting(id, task);
    pageAgents(id)?.chatEnded(task);
    tellPage(id, "chat_end", { task });
    log("chat.error", { page: id, task, message: `couldn't wake the agent: ${why(e)}` });
    return { error: `The agent couldn't be woken: ${e?.message ?? e}` };
  }
}

/** The chat on `task` has ended: its agent waits again in the page's loop, or snoozes if the page has none running. */
export async function giveBack(id: string, task: string, a: ChatAgent) {
  unmarkChatting(id, task);
  const page = pageAgents(id);
  log("chat.close", { page: id, task, agent: page ? "waits again" : "snoozed" });
  tellPage(id, "chat_end", { task, ...(recordedFinish(id, task) && { finishedAt: recordedFinish(id, task) }) });
  if (page) page.adopt(task, a.session, a.ref);
  else await a.session.close().catch(() => {});
  page?.nudge();
}


const reject = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/**
 * `POST /api/pages/:id/agent` `{ model?, on? }`: changes the page's agent settings, which are kept in its file
 * (`agent/settings.ts`). A model change (maybe of engine) never cuts a run short: runs in flight finish on the old
 * one, and the next starts on the new. `on: false` stops the page's agents (the run in flight stops, waiting agents
 * snooze); `on: true` lets the next stream start them.
 */
/**
 * `POST /api/pages/:id/tasks/:task/schedule` `{ every }`: how often the button of a request runs on its own, page open
 * or not (ms, one of `BUTTON_EVERY`), or `null` for only when pressed. Kept in the request's record.
 */
export async function setButtonSchedule(req: Request & { params: Record<string, string> }) {
  const id = req.params.id!, task = req.params.task!;
  if (!validId(id)) return reject(400, "bad_id", "Invalid document id.");
  const body = (await req.json().catch(() => null)) as { every?: unknown } | null;
  const every = body?.every;
  if (every !== null && typeof every !== "number") return reject(400, "bad_request", "Expected { every: number | null }.");
  const r = await withLock(id, () => readModifyWrite(id, (src) => {
    if (src === null) return { result: { error: "No such document." } as { error?: string } };
    const f = scheduleButton(src, task, every);
    return { file: f.file, result: f };
  }));
  if (r.error) return reject(400, "bad_schedule", r.error);
  log("button.schedule", { page: id, task, every });
  return Response.json({ ok: true, every });
}

export async function setAgentModel(req: Request & { params: Record<string, string> }) {
  const id = req.params.id!;
  if (!validId(id)) return reject(400, "bad_id", "Invalid document id.");
  const body = (await req.json().catch(() => null)) as { model?: unknown; on?: unknown } | null;
  const patch: { on?: boolean; model?: string } = {};
  if (body?.model !== undefined) {
    // The writer is choosing: every engine's lists are read first, so one of the models offered — including one found
    // by the picker's search, which is not on the shortlist — is accepted, and anything else is refused here.
    await warmEngines();
    const c = parseChoice(body.model);
    if (!c) return reject(400, "bad_model", `No engine has the model ${JSON.stringify(body.model)}.`);
    // Its engine's own reason first: more use to the writer than a list of what is offered instead.
    const why = c.engine.unavailable();
    if (why) return reject(400, "unavailable", why);
    if (!engineOffers(c.engine, c.model)) return reject(400, "bad_model", `${c.engine.title} does not offer the model ${JSON.stringify(c.model)}.`);
    patch.model = c.choice;
  }
  if (body?.on !== undefined) {
    if (typeof body.on !== "boolean") return reject(400, "bad_request", "`on` must be true or false.");
    patch.on = body.on;
  }
  if (!Object.keys(patch).length) return reject(400, "bad_request", "Expected { model?, on? }.");
  const s = await writeSettings(id, patch);
  if (!s) return reject(404, "not_found", "No such document.");
  const page = pageAgents(id);
  if (page && patch.on === false) await page.stop("turned off by the writer");
  else if (page && patch.model) {
    page.model = s.model;
    page.nudge();
    log("agents.model", { page: id, model: page.model, by: "writer" });
  }
  return Response.json({ on: s.on, model: s.model });
}

/**
 * `GET /api/agent/models`: what the model picker offers. `models` is the shortlist it shows at a glance (the writer's
 * preferred models, then each engine's own); `catalog` is every model every engine could run, which the picker
 * searches — for Pi, every model the writer's own Pi has credentials for. Read when the picker is first opened, since
 * the catalog is far longer than the page stream's hello wants to carry.
 */
export async function getModels() {
  await warmEngines();
  return Response.json({ models: modelList(), catalog: modelCatalog() });
}

/** Whether any engine can run now: with none, a page asks for a key (`ConnectModel`). */
const noEngine = () => engines().every((e) => !!e.unavailable());

/**
 * `POST /api/agent/key` `{ key }`: the OpenRouter key the writer pasted, checked with OpenRouter and kept
 * (`keyStore.ts`: the keychain, or a file only they can read). Local only, like the settings. Every page's agents are
 * nudged, since a request may have been waiting for a model.
 */
export async function saveOpenRouterKey(req: Request, srv?: Peer) {
  const refused = notLocal(req, srv);
  if (refused) return refused;
  if (!canSaveKey()) return reject(400, "off", "Saving a key is turned off (pi.key_store: off). Set SOLIPSIST_OPENROUTER_KEY instead.");
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  const problem = keyProblem(key);
  if (problem) return reject(400, "bad_key", problem);
  const verdict = await checkKey(key);
  if (verdict === "refused") return reject(400, "refused", "OpenRouter didn't accept that key. Check you copied all of it, or make a new one.");
  let kept: Awaited<ReturnType<typeof saveKey>>;
  try { kept = await saveKey(key); } catch (e) { return reject(500, "not_saved", `The key couldn't be saved: ${why(e)}`); }
  log("key.save", { place: kept.place, checked: verdict });
  await warmEngines().catch(() => {});
  for (const id of runningPages()) pageAgents(id)?.nudge();
  return Response.json({ place: kept.place, ...(kept.file && { file: kept.file }), checked: verdict === "ok", noEngine: noEngine() });
}

/** `DELETE /api/agent/key`: forgets the saved key (`solipsist forget-key` does the same from a terminal). */
export async function forgetOpenRouterKey(req: Request, srv?: Peer) {
  const refused = notLocal(req, srv);
  if (refused) return refused;
  const had = await forgetKey();
  if (had) log("key.forget", {});
  return Response.json({ forgotten: had, noEngine: noEngine() });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * The agent stream of one open tab (`?model=` picks the model): it starts the page's agents (`PageAgents`), or joins
 * them if they are already working (the tab closed and opened again), and reports every start, step and end, each
 * with its run's number, after what is in flight now. Closing the stream leaves the agents working: they stop once
 * nothing is left to do, or on `POST …/agent/stop`.
 */
export function agentStream(req: Request & { params: Record<string, string> }, server: { timeout(r: Request, s: number): void }) {
  const id = req.params.id!;
  if (!validId(id)) return Response.json({ error: { code: "bad_id", message: "Invalid document id." } }, { status: 400 });
  server.timeout(req, 0);
  // The page's settings are in its file: whether its agents are on, and their model. Off, there are no agents to join
  // or start, and the stream only waits to hear them turned on.
  const settings = readSettings(id);
  // A page with no model of its own may be started on one by the stream (`?model=`: tests and other clients; the page
  // itself no longer sends it). Once the page has one in its file, that is the choice.
  const asked = new URL(req.url).searchParams.get("model");
  if (!settings.saved.model && asked && parseChoice(asked)) settings.model = asChoice(asked);
  let page = pageAgents(id);
  if (settings.on) {
    if (!page) {
      page = new PageAgents(id, settings.model);
      page.start();
    } else if (settings.model !== page.model) {
      // Changed since (from another tab, or by hand): from the next run on, a run in flight keeps its model.
      page.model = settings.model;
      page.nudge();
    }
  }
  const agents = page;

  const enc = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream({
    start(c) {
      const send = (event: string, data: object) => { try { c.enqueue(enc.encode(frame(event, { at: Date.now(), ...data }))); } catch {} };
      const ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch {} }, 15_000);
      let stopped = false;
      let off = () => {};
      // What the page-wide chat's agent is doing, for the chat button: told whether the page's agents are on or not.
      const offChat = onPageChat(id, (s) => send("pichat", s));
      stop = () => {
        if (stopped) return;
        stopped = true;
        off();
        offChat();
        clearInterval(ping);
        try { c.close(); } catch {}
      };
      req.signal.addEventListener("abort", stop);
      const { agents: states, finished } = agentStates(id);
      send("hello", { id, version: versionInfo().version, build: versionLine(), noEngine: noEngine(), canSaveKey: canSaveKey(), on: settings.on, model: agents?.model ?? settings.model, models: modelList(), gapMs: gapMs(), concurrency: concurrency(), singleAgent: singleAgent(), maxRuns: maxRuns(), waitMs: waitMs(), agents: states, finished, engines: agentEngines(id), pageChat: pageChatStatus(id), cost: { spentUsd: spentUsd(), limitUsd: costLimit() } });
      if (agents) {
        off = agents.subscribe((event, data) => { send(event, data); if (event === "stopped") stop(); });
        // The page's agents stopped (turned off from another tab, or the server stopping): this stream is done too.
        if (agents.isStopped) stop();
      } else {
        // Turned on: this stream closes, and the tab's next one starts the agents. A model change is only told.
        off = onSettings(id, (s) => { if (s.on) stop(); else send("settings", { on: false, model: s.model }); });
      }
    },
    cancel() { stop(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}

/**
 * `POST /api/pages/:id/agent/stop`: the writer turned the page's agents off (the same as `{ on: false }` above, and
 * kept in the page the same way). Runs in flight stop, and waiting agents snooze.
 */
export async function stopAgents(req: Request & { params: Record<string, string> }) {
  const id = req.params.id!;
  if (validId(id)) await writeSettings(id, { on: false }).catch(() => null);
  const page = pageAgents(id);
  if (page) await page.stop("turned off by the writer");
  return new Response(null, { status: 204 });
}
