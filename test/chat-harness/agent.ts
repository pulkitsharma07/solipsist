// A fake agent behind the chat modal's endpoints (the ones `src/server/chat/` serves), sending the events Pi's stream
// becomes (`piStreamer`), so the modal can be tried on every kind of reply without a model. `server.ts` serves it to a
// browser (`test/e2e/chat.e2e.ts`); `test/e2e-dom/chat-stream.dom.tsx` puts the same routes in the fake DOM's server.
import type { ChatBlock, ChatEvent, ChatMessage } from "../../src/shared/chat";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How fast the fake streams: 0.2 is five times faster. */
let speed = 1;
const pause = (ms: number) => wait(ms * speed);

let n = 0;
const id = () => `m${++n}`;
const tool = (name: string, brief: string, args: object): Extract<ChatBlock, { type: "tool" }> =>
  ({ type: "tool", id: `t${++n}`, name, brief, args: JSON.stringify(args, null, 2) });
/** A call to one of Solipsist's own tools (`replyTools.ts`), as an engine marks it: the chat shows it as the result. */
const replyTool = (name: string, args: object): Extract<ChatBlock, { type: "tool" }> =>
  ({ ...tool(name, "", args), reply: true });
const stats = { model: "deepseek/deepseek-flash", input: 5400, output: 180, costUsd: 0.00042, ms: 2100, tokensPerSec: 64 };

const TASK = "<protocol>\nThe reply envelope, modes and rules…\n</protocol>\n\nFill placeholder abc in /docs/plan.md.\n\n" + "The page:\n\n# Plan\n\nThe rollout <!-- gen:abc --> went well.\n".repeat(6);

/** The conversation a chat opens on, by its task. */
function history(taskId: string): ChatMessage[] {
  const task: ChatMessage = { id: id(), role: "task", blocks: [{ type: "text", text: TASK }], at: Date.now() };
  const first: ChatMessage = { id: id(), role: "assistant", blocks: [{ type: "text", text: '<suggestion mode="at" place="inline">\nquietly\n</suggestion>' }], at: Date.now(), stats };
  if (taskId !== "long") return [task, first];
  const out = [task, first];
  for (let i = 1; i <= 12; i++) {
    out.push({ id: id(), role: "user", blocks: [{ type: "text", text: `Question ${i}: can you check the page again and say why?` }], at: Date.now() });
    const t = { ...tool("bash", `grep -n rollout /docs/plan.md # ${i}`, { command: `grep -n rollout /docs/plan.md` }), result: "3:The rollout went well.\n".repeat(i), durationMs: 20 + i };
    out.push({ id: id(), role: "assistant", blocks: [{ type: "thinking", text: `They ask ${i}. Let me look.` }, t], at: Date.now(), stats });
    out.push({ id: id(), role: "assistant", blocks: [{ type: "text", text: `Answer ${i}. ${"The page says the rollout went well, so a calm word fits. ".repeat(i % 4 + 1)}` }], at: Date.now(), stats });
  }
  return out;
}

interface Chat { send(e: ChatEvent): void; running?: Promise<void>; stopped: boolean }
const chats = new Map<string, Chat>();

/** One streamed reply: a message that starts empty, its deltas, and the whole message at its end, as Pi sends. */
async function reply(chat: Chat, parts: (ChatBlock | { pause: number })[], end: Partial<ChatMessage> = {}) {
  const m: ChatMessage = { id: id(), role: "assistant", blocks: [], at: Date.now(), streaming: true };
  const started = Date.now();
  chat.send({ t: "message", message: m });
  const blocks: ChatBlock[] = [];
  const tools: Extract<ChatBlock, { type: "tool" }>[] = [];
  for (const p of parts) {
    if (chat.stopped) break;
    if ("pause" in p) { await pause(p.pause); continue; }
    const i = blocks.length;
    if (p.type === "tool") {
      await pause(300);
      blocks.push(p);
      tools.push(p);
      chat.send({ t: "tool", id: m.id, block: i, tool: { ...p, running: true } });
      continue;
    }
    blocks.push({ type: p.type, text: "" });
    for (const word of p.text.match(/\S+\s*|\s+/g) ?? []) {
      if (chat.stopped) break;
      (blocks[i] as { text: string }).text += word;
      chat.send({ t: "delta", id: m.id, block: i, kind: p.type, delta: word });
      await pause(25);
    }
  }
  const output = Math.round(blocks.reduce((k, b) => k + (b.type === "tool" ? b.args.length : b.text.length), 0) / 4);
  const done: ChatMessage = { ...m, ...end, streaming: false, blocks: blocks.map((b) => (b.type === "tool" ? { ...b, running: true } : b)), stats: { ...stats, output, ms: Date.now() - started }, ...(chat.stopped && { error: "Request was aborted" }) };
  chat.send({ t: "message", message: done });
  return chat.stopped ? [] : tools;
}

/** Runs tools the model asked for: each result after a while. */
async function run(chat: Chat, tools: Extract<ChatBlock, { type: "tool" }>[], results: Record<string, { result: string; isError?: boolean; ms?: number }>) {
  for (const t of tools) {
    const r = results[t.id] ?? { result: "ok" };
    await pause(r.ms ?? 400);
    chat.send({ t: "tool_result", toolId: t.id, result: chat.stopped ? "aborted" : r.result, isError: chat.stopped || !!r.isError, durationMs: Math.round((r.ms ?? 400) * speed) });
  }
}

const LONG = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long answer, long enough to wrap once the modal is narrow, about the rollout.`).join("\n");
const CODE = "Here is the script:\n\n```ts\nconst page = await read('/docs/plan.md');\nfor (const line of page.split('\\n')) {\n  if (line.includes('rollout')) console.log(line);\n}\n```\n\nIt prints the lines that mention it.";

/** What the agent does with what the writer said, by a word in it. */
async function answer(chat: Chat, text: string) {
  const say = (s: string): ChatBlock => ({ type: "text", text: s });
  const think = (s: string): ChatBlock => ({ type: "thinking", text: s });
  const w = text.toLowerCase();
  if (w.includes("tools")) {
    const a = tool("read", "/docs/plan.md", { path: "/docs/plan.md" });
    const b = tool("bash", "ls -la /docs", { command: "ls -la /docs" });
    const c = tool("grep", "rollout", { pattern: "rollout", path: "/docs" });
    const used = await reply(chat, [think("Three things to check."), a, b, c]);
    await run(chat, used, { [a.id]: { result: "# Plan\n\nThe rollout went well.\n".repeat(20) }, [b.id]: { result: "total 8\n-rw-r--r-- plan.md", ms: 700 }, [c.id]: { result: "grep: /docs: Is a directory", isError: true, ms: 200 } });
    if (!chat.stopped) await reply(chat, [say("Read the page, listed the folder; the grep failed but the page was enough."), say('<suggestion mode="at" place="inline">\nsmoothly\n</suggestion>')]);
    if (!chat.stopped) chat.send({ t: "revised" });
  } else if (w.includes("tool")) {
    const b = tool("bash", "ls /", { command: "ls /" });
    const used = await reply(chat, [think("They want me to list the root."), say("Let me look."), b]);
    await run(chat, used, { [b.id]: { result: "Applications\nLibrary\nSystem\nUsers\nVolumes\nbin\netc\nusr", ms: 600 } });
    if (!chat.stopped) await reply(chat, [say("The root has the usual folders: Applications, Library, System, Users.")]);
  } else if (w.includes("long")) await reply(chat, [say(LONG)]);
  else if (w.includes("code")) await reply(chat, [say(CODE)]);
  else if (w.includes("think")) await reply(chat, [think("Hmm. ".repeat(80) + "Right."), say("Thought about it: keep it.")]);
  else if (w.includes("slow")) await reply(chat, [say("Slow ".repeat(800))]);
  else if (w.includes("suggest")) { await reply(chat, [say('Here is another:\n\n<suggestion mode="at" place="inline">\nsteadily\n</suggestion>\n\n<note>Calmer.</note>')]); chat.send({ t: "revised" }); }
  else if (w.includes("bad")) { await reply(chat, [say('<suggestion mode="nope">x</suggestion>')]); chat.send({ t: "warning", message: "Your new suggestion can't be used: mode must be at, replace or after" }); }
  else if (w.includes("error")) { await reply(chat, [say("Starting…")], { error: "OpenRouter: 429 rate limited" }); chat.send({ t: "warning", message: "OpenRouter: 429 rate limited" }); }
  else if (w.includes("decline")) await reply(chat, [say("<decline>Nothing on the page says what goes here.</decline>")]);
  else if (w.includes("reply")) {
    // The result given with Solipsist's own tools: one call the page refuses, then the one that counts, then an answer.
    const bad = replyTool("suggest", { mode: "after", place: "inline", markdown: "smoothly" });
    const used = await reply(chat, [say("Let me put that on the card."), bad]);
    await run(chat, used, { [bad.id]: { result: "A point placeholder's result goes `at`, not `after`.", isError: true, ms: 200 } });
    if (chat.stopped) return;
    const good = replyTool("suggest", { mode: "at", place: "inline", markdown: "smoothly", note: "Shorter, as asked.", edits: [{ before: "The rollout went well.", after: "The rollout went smoothly." }] });
    const kept = await reply(chat, [good]);
    await run(chat, kept, { [good.id]: { result: "ok", ms: 200 } });
    if (chat.stopped) return;
    chat.send({ t: "revised" });
    const asked = replyTool("answer", { answer: "Yes: the page says it went well, so a calm word fits.", note: "Nothing put in the page." });
    const done = await reply(chat, [asked]);
    await run(chat, done, { [asked.id]: { result: "ok", ms: 150 } });
  }
  else await reply(chat, [say(`You said: ${text}. Nothing to change.`)]);
}

const fail = (status: number, message: string) => Response.json({ error: { code: "x", message } }, { status });
type Req = Request & { params: Record<string, string> };
/** As the app's server reads it: `:target`, a task's id or `page`. */
const targetOf = (req: Req) => req.params.target!;

const chatRoute = {
      GET: (req: Req, srv: any) => {
        const task = targetOf(req);
        if (task === "gone") return fail(409, "This suggestion has no agent to chat with.");
        if (chats.has(task)) return fail(409, "A chat is already open on this placeholder.");
        srv.timeout(req, 0);
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(c) {
            const chat: Chat = { stopped: false, send: (e) => { try { c.enqueue(enc.encode(`event: chat\ndata: ${JSON.stringify(e)}\n\n`)); } catch {} } };
            chats.set(task, chat);
            req.signal.addEventListener("abort", () => { chat.stopped = true; chats.delete(task); try { c.close(); } catch {} });
            chat.send({ t: "history", messages: history(task), busy: false, model: "pi:~deepseek/deepseek-flash-latest" });
          },
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      },
      POST: async (req: Req) => {
        const chat = chats.get(targetOf(req));
        if (!chat) return fail(404, "No chat is open on this placeholder.");
        if (chat.running) return fail(409, "The agent is still answering.");
        const { text } = (await req.json()) as { text: string };
        chat.stopped = false;
        chat.send({ t: "message", message: { id: id(), role: "user", blocks: [{ type: "text", text }], at: Date.now() } });
        chat.send({ t: "busy", busy: true });
        chat.running = answer(chat, text).finally(() => { chat.running = undefined; chat.send({ t: "busy", busy: false }); });
        return Response.json({ ok: true }, { status: 202 });
      },
    };
const chatStop = {
      POST: (req: Req) => {
        const chat = chats.get(targetOf(req));
        if (chat) chat.stopped = true;
        return new Response(null, { status: 204 });
      },
    };

/** The chat channel and the routes before it, by path. */
export function chatRoutes(pace = 1) {
  speed = pace;
  return {
    // The one chat channel: `:target` is a task's id or `page`, as the app's server has it (`src/server/chat/index.ts`).
    "/api/pages/:id/chat/:target": {
      ...chatRoute,
      // New chat: the fake keeps no conversation, so there is nothing to forget.
      DELETE: () => new Response(null, { status: 204 }),
    },
    "/api/pages/:id/chat/:target/stop": chatStop,
  };
}
