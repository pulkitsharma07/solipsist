import { isTaskId } from "../../shared/ids";
import { chatMessage, PAGE_CHAT, type ChatEvent } from "../../shared/chat";
import { config } from "../config";
import { choiceOf } from "../agent/engines";
import { listen } from "../agent/bus";
import { spend } from "../agent/budget";
import { providePageChatStatus } from "../agent/pageChatStatus";
import { readSettings } from "../agent/settings";
import type { RunResult } from "../agent/engine";
import { taskReply, type AnyReply } from "../suggest";
import { validId } from "../files";
import { log } from "../log";
import { pageChatUnread, pageSource } from "./page";
import type { ChatAgent, ChatSource, RunWatch } from "./source";
import { taskSource } from "./task";

/**
 * The chat channel, one for every chat: `/api/pages/:id/chat/:target`, where `target` is a task's id (the chat behind
 * its suggestion, `task.ts`) or `page` (the page-wide chat, `page.ts`). The two differ only in their source: where the
 * agent comes from, where it goes back to, and where what it gives goes. Everything else is here, once:
 *
 * - `GET` (an event stream) opens the chat or joins it: the conversation so far, then everything the agent streams
 *   (`agent/bus.ts`), and what the server adds (`busy`, `revised`, `warning`). Opened while a run is on the task, it
 *   looks in on it (`watching`) and takes the agent once the run ends.
 * - `POST` `{ text }` says something; mid-reply it is steered in (`AgentSession.steer`) when the engine can.
 * - `POST …/stop` stops the reply in flight. `DELETE` (the page's only) is New chat: the conversation is forgotten.
 * - Closing a window leaves a reply going (what it gives still goes on the page); the agent stays while a window is
 *   open or a reply runs, then for the source's `keepMs` (the page's: `agent.wait_ms`; a task's: none, the page's loop
 *   keeps it), and then goes back (`giveBack`).
 */

interface Chat {
  id: string;
  target: string;
  source: ChatSource;
  /** Undefined while the chat only looks in on a run (`watch`). */
  agent?: ChatAgent;
  watch?: RunWatch;
  offWatch?: () => void;
  /** The windows open on it (their event streams). A reply goes on with none. */
  windows: Set<(e: ChatEvent) => void>;
  /** The reply in flight, if any. */
  running?: Promise<void>;
  /** Whether the agent was told what the chat is for (the first message says it). */
  told: boolean;
  /** Gives the agent back, once it has been idle and unwatched for the source's `keepMs`. */
  timer?: ReturnType<typeof setTimeout>;
  closed?: boolean;
}
const chats = new Map<string, Chat>();
/** A chat being opened, so two windows opening at once share one agent. */
const starting = new Map<string, Promise<Chat | Response>>();
const key = (id: string, target: string) => `${id}/${target}`;
const send = (chat: Chat, e: ChatEvent) => { for (const w of chat.windows) w(e); };

providePageChatStatus((id) => {
  const chat = chats.get(key(id, PAGE_CHAT));
  const state = chat ? (chat.running ? "working" : chat.windows.size ? "open" : "waiting") : readSettings(id).saved.chat ? "snoozed" : "none";
  return { state, ...(pageChatUnread(id) && { unread: true }) };
});

const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
type Req = Request & { params: Record<string, string> };
/** The page and the chat a request is for: `:target` is a task's id or `page`. */
function targetOf(req: Req): { id: string; target: string; source: () => ChatSource } | null {
  const id = req.params.id!, target = req.params.target!;
  if (!validId(id)) return null;
  if (target === PAGE_CHAT) return { id, target, source: () => pageSource(id) };
  return isTaskId(target) ? { id, target, source: () => taskSource(id, target) } : null;
}
const what = (target: string) => (target === PAGE_CHAT ? "page" : "request");

const historyOf = (chat: Chat): ChatEvent => chat.agent
  ? { t: "history", messages: chat.agent.session.history?.() ?? [], busy: !!chat.running, model: choiceOf(chat.agent.ref.engine, chat.agent.ref.model), steers: !!chat.agent.session.steer }
  : { t: "history", messages: chat.watch?.history() ?? [], busy: true, watching: true };

/** The chat is over: a reply in flight is stopped, and the agent goes back to its source. */
async function close(chat: Chat, reason: string) {
  if (chat.closed) return;
  chat.closed = true;
  if (chats.get(key(chat.id, chat.target)) === chat) chats.delete(key(chat.id, chat.target));
  clearTimeout(chat.timer);
  chat.offWatch?.();
  if (chat.running) { await chat.agent?.session.abort?.().catch(() => {}); await chat.running; }
  if (chat.agent) await chat.source.giveBack(chat.agent, reason);
  chat.source.notify?.("changed");
}

/** No window and nothing in flight: the agent goes back, at once or after the source's `keepMs`. Anything else: it stays. */
function release(chat: Chat) {
  clearTimeout(chat.timer);
  chat.timer = undefined;
  if (chat.windows.size || chat.running || chat.closed) return;
  // Only looking in on a run: the run is the page's, and the chat is over.
  if (!chat.agent) { void close(chat, "closed"); return; }
  const ms = chat.source.keepMs();
  if (ms > 0) chat.timer = setTimeout(() => void close(chat, "snoozed"), ms);
  else void close(chat, "closed");
}

/** Looking in on a run: when it ends, the agent it kept is the chat's. */
function awaitRun(chat: Chat, watch: RunWatch) {
  chat.watch = watch;
  chat.offWatch = watch.onEnd(async (run) => {
    chat.offWatch?.();
    chat.offWatch = undefined;
    const got = await chat.source.lend();
    if (chat.closed) { if ("agent" in got) await chat.source.giveBack(got.agent, "closed"); return; }
    if (!("agent" in got)) {
      send(chat, { t: "warning", message: run.error ? `The run failed: ${run.error}` : "watch" in got ? `Another run started on this ${what(chat.target)}.` : got.refused.message });
      send(chat, { t: "busy", busy: false });
      return;
    }
    chat.agent = got.agent;
    chat.told = !!got.told;
    chat.watch = undefined;
    send(chat, historyOf(chat));
  });
}

/** The chat on `target`, live (joined) or opened now. */
async function open(id: string, target: string, source: () => ChatSource): Promise<Chat | Response> {
  const k = key(id, target);
  const live = chats.get(k);
  if (live?.agent && live.source.stale?.(live.agent)) await close(live, "model changed");
  else if (live) return live;
  const pending = starting.get(k);
  if (pending) return pending;
  const p = (async (): Promise<Chat | Response> => {
    const s = source();
    const got = await s.lend();
    if ("refused" in got) return fail(got.refused.status, got.refused.code, got.refused.message);
    const chat: Chat = { id, target, source: s, windows: new Set(), told: false };
    if ("agent" in got) { chat.agent = got.agent; chat.told = !!got.told; }
    else awaitRun(chat, got.watch);
    chats.set(k, chat);
    return chat;
  })().finally(() => starting.delete(k));
  starting.set(k, p);
  return p;
}

/** One window on the chat: the conversation so far, then everything it streams. Closing it leaves the chat going. */
function attach(req: Req, chat: Chat) {
  const enc = new TextEncoder();
  let end = () => {};
  const stream = new ReadableStream({
    start(c) {
      const window = (e: ChatEvent) => { try { c.enqueue(enc.encode(`event: chat\ndata: ${JSON.stringify(e)}\n\n`)); } catch {} };
      chat.windows.add(window);
      clearTimeout(chat.timer);
      chat.timer = undefined;
      const off = listen(chat.id, chat.target, window);
      const ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch {} }, 15_000);
      let ended = false;
      end = () => {
        if (ended) return;
        ended = true;
        off();
        clearInterval(ping);
        chat.windows.delete(window);
        release(chat);
        chat.source.notify?.("changed");
        try { c.close(); } catch {}
      };
      req.signal.addEventListener("abort", end);
      chat.source.notify?.("seen");
      window(historyOf(chat));
    },
    cancel() { end(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}

/** `GET /api/pages/:id/chat/:target`: opens the chat, or joins it, as an event stream. */
export async function chatStream(req: Req, server: { timeout(r: Request, s: number): void }) {
  const t = targetOf(req);
  if (!t) return fail(400, "bad_id", "Invalid page or request.");
  const got = await open(t.id, t.target, t.source);
  if (got instanceof Response) return got;
  if (got.closed) return fail(409, "closed", "The chat closed as it opened. Try again.");
  server.timeout(req, 0);
  return attach(req, got);
}

/** `POST /api/pages/:id/chat/:target` `{ text }`: what the writer says. The reply streams to every window. */
export async function chatSay(req: Req) {
  const t = targetOf(req);
  const chat = t && chats.get(key(t.id, t.target));
  if (!t || !chat) return fail(404, "not_open", `No chat is open on this ${what(t?.target ?? "")}.`);
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > config().chat.max_message_chars) return fail(400, "bad_text", `Say something (at most ${config().chat.max_message_chars} characters).`);
  if (!chat.agent) return fail(409, "busy", "The agent is still on its run: you can write once it is done.");
  const agent = chat.agent, source = chat.source;
  // Mid-reply: the agent takes it in after its current step, and its reply answers it too.
  if (chat.running) {
    if (!agent.session.steer) return fail(409, "busy", "The agent is still answering.");
    if (await agent.session.steer(chatMessage(text))) {
      log(`${source.log}.steer`, source.fields);
      return Response.json({ ok: true, steered: true }, { status: 202 });
    }
    await chat.running; // it ended just now: the message is a reply of its own
    // Read again: another message may have started a reply while this one waited.
    if ((chat as { running?: Promise<void> }).running) return fail(409, "busy", "The agent is still answering.");
  }
  if (chat.closed) return fail(404, "not_open", `No chat is open on this ${what(t.target)}.`);
  // The first message says what the chat is for. The rest of the instructions are in the agent's system prompt.
  const prompt = chatMessage(text, chat.told ? "" : source.intro());
  chat.told = true;
  clearTimeout(chat.timer);
  chat.timer = undefined;
  send(chat, { t: "busy", busy: true });
  source.onBusy?.(true);
  chat.running = (async () => {
    await Promise.resolve(); // `running` is set before the source is told
    source.notify?.("changed");
    // A chat has a task's tools, never a reading's: a `comment` call here is a tool the agent shouldn't have.
    const check = (r: AnyReply) => { const t = taskReply(r); return t ? source.check(t) : "There is no `comment` tool here."; };
    const res = await agent.session.run(prompt, { check }).catch((e: any): RunResult => ({ ok: false, result: "", error: String(e?.message ?? e) }));
    spend(res.costUsd);
    log(`${source.log}.reply`, { ...source.fields, ok: res.ok, costUsd: res.costUsd, watched: chat.windows.size > 0, ...(res.reply && { tool: res.reply.kind }), ...(!res.ok && { error: res.error }) });
    const reply = taskReply(res.reply) ?? res.result;
    if (res.ok && reply) for (const e of await source.apply(reply)) send(chat, e);
    else if (!res.ok && res.error && !/abort/i.test(res.error)) send(chat, { t: "warning", message: res.error });
    chat.running = undefined;
    send(chat, { t: "busy", busy: false });
    source.onBusy?.(false);
    if (res.ok && !chat.windows.size && !chat.closed) source.notify?.("unseen");
    release(chat);
    source.notify?.("changed");
  })();
  return Response.json({ ok: true }, { status: 202 });
}

/** `POST /api/pages/:id/chat/:target/stop`: stops the reply in flight. Looking in on a run, it doesn't stop the run: that is the page's. */
export async function chatStop(req: Req) {
  const t = targetOf(req);
  const chat = t && chats.get(key(t.id, t.target));
  if (!chat) return fail(404, "not_open", `No chat is open on this ${what(t?.target ?? "")}.`);
  await chat.agent?.session.abort?.().catch(() => {});
  return new Response(null, { status: 204 });
}

/** `DELETE /api/pages/:id/chat/page`: New chat. The agent is closed and its conversation forgotten; the next open starts afresh. */
export async function chatForget(req: Req) {
  const t = targetOf(req);
  if (!t) return fail(400, "bad_id", "Invalid page.");
  const source = t.source();
  if (!source.forget) return fail(400, "not_page", "Only the page's chat can be started afresh.");
  const k = key(t.id, t.target);
  await starting.get(k);
  await source.forget();
  const chat = chats.get(k);
  if (chat) await close(chat, "new chat");
  source.notify?.("changed");
  return new Response(null, { status: 204 });
}

/** Closes every chat (the server stopping): agents go back, conversations stay recorded to be taken up again. */
export async function closeChats(reason: string) {
  await Promise.all([...chats.values()].map((chat) => close(chat, reason)));
}

/** The chats open now, as `page/target` (tests). */
export const openChats = () => [...chats.keys()];
/** How many windows look at a chat (tests). */
export const chatWindows = (id: string, target: string) => chats.get(key(id, target))?.windows.size ?? 0;
