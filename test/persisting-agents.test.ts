// Persisting agents: a Pi agent is kept after its run, waits, snoozes with its
// conversation on disk, and is woken by an ask again; the chat hands its conversation to pi-web (a stub here), and a
// suggestion the agent makes there replaces the one on the card. Pi runs on its scripted `faux` model with a scratch
// config directory, never ~/.pi.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { stopAllPages } from "../src/server/agent/pageAgents";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "./outside";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStep } from "../src/server/agent/engine";
import type { ChatEvent } from "../src/shared/chat";
import type { AgentEngine } from "../src/server/agent/engine";
import { setEngines } from "../src/server/agent/engines";
import { cmdEngine as fakeEngine } from "../src/server/agent/engines/cmd";
import { piEngine, piSessionDir, piSessionFile } from "../src/server/agent/engines/pi";
import { finishRun, reviseSuggestion } from "../src/server/suggest";
import { parseFile, serializeFile, emptyBlock, type TaskAgent } from "../src/shared/docfile";

const dir = mkdtempSync(join(tmpdir(), "solip-persist-test-"));
// A page's agents outlive its stream: each test's are turned off after it.
afterEach(() => { restoreProject(); return stopAllPages("test over"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT;
const restoreProject = () => { if (wasProject === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT; else process.env.SOLIPSIST_PROJECT_ROOT = wasProject; };
let n = 0;
function place() {
  const base = join(dir, `t${n++}`);
  const p = { root: base, docs: join(base, ".solipsist", "pages"), scratch: join(base, "scratch"), agentDir: join(base, "pi") };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  return p;
}
async function scripted(agentDir: string, responses: (() => any)[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const seen: any[] = [];
  faux.setResponses(responses.map((f) => (ctx: any) => { seen.push(ctx); return f(); }));
  return { engine: piEngine({ agentDir: () => agentDir, runtime: async () => runtime, model: () => faux.getModel() }), seen };
}
const say = (s: string) => () => fauxAssistantMessage(fauxText(s));
const tool = (name: string, args: Record<string, any>) => () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const envelope = (s: string) => `Done.\n\n<suggestion mode="at" place="inline">\n${s}\n</suggestion>`;
/** The text of the user messages the model was sent, last one last. */
const userTexts = (ctx: any) => (ctx.messages as any[]).filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PI = { engine: "pi", model: "acme/acme-small-5.5", session: "s-1" } satisfies TaskAgent;

describe("the record (suggest.ts)", () => {
  const NOW = new Date("2026-10-31T10:00:00.000Z");
  const acked = (body: string, record: object = {}) => serializeFile(body, { ...emptyBlock(), tasks: { abc: { type: "gen", created_by: "writer", created: NOW.toISOString(), status: "ack", ...record } } });

  test("a run whose agent is kept records it with the result; a later run without one keeps the record's", () => {
    const src = acked("Plan <!-- gen:abc:ack --> end.");
    const f = finishRun(src, { id: "abc", taskType: "gen" }, "Plan <!-- gen:abc:ack --> end.", { reply: envelope("x"), agent: PI }, NOW);
    expect(parseFile(f.file!).block.tasks!.abc!.agent).toEqual(PI);
    const again = finishRun(acked("Plan <!-- gen:abc:ack --> end.", { agent: PI }), { id: "abc", taskType: "gen" }, "Plan <!-- gen:abc:ack --> end.", { reply: envelope("y") }, NOW);
    expect(parseFile(again.file!).block.tasks!.abc!.agent).toEqual(PI);
  });

  test("reviseSuggestion: a suggestion from the chat replaces the proposal, the body untouched; talk, a decline or a placeholder not at :sug change nothing", () => {
    const body = "Plan <!-- gen:abc:sug --> end.";
    const src = serializeFile(body, { ...emptyBlock(), tasks: { abc: { type: "gen", created_by: "writer", created: NOW.toISOString(), status: "suggested", mode: "at", place: "inline", suggestion: "old", note: "first", agent: PI } } });
    const r = reviseSuggestion(src, { id: "abc", taskType: "gen" }, `Sure.\n${envelope("*new*")}\n<note>shorter</note>`, NOW);
    const after = parseFile(r.file!);
    expect(after.markdown).toBe(body);
    expect(after.block.tasks!.abc).toMatchObject({ status: "suggested", suggestion: "*new*", note: "shorter", agent: PI, finished: NOW.toISOString() });
    expect(reviseSuggestion(src, { id: "abc", taskType: "gen" }, "Why did I do that? Because.")).toEqual({});
    expect(reviseSuggestion(src, { id: "abc", taskType: "gen" }, "<decline>no</decline>")).toEqual({});
    expect(reviseSuggestion(src.replace(":sug", ""), { id: "abc", taskType: "gen" }, envelope("x"))).toEqual({});
    // A declined one becomes a suggestion.
    const declined = src.replace('"status": "suggested"', '"status": "declined"');
    expect(parseFile(reviseSuggestion(declined, { id: "abc", taskType: "gen" }, envelope("now")).file!).block.tasks!.abc!.status).toBe("suggested");
    // One that can't be used says why, and changes nothing.
    expect(reviseSuggestion(src, { id: "abc", taskType: "gen" }, '<suggestion mode="replace" place="inline">x</suggestion>')).toMatchObject({ error: expect.stringContaining('mode="at"') });
  });
});

describe("the Pi engine keeps its conversation", () => {
  test("a closed agent's session is resumed with its history; one that is gone starts afresh, and says so", async () => {
    const p = place();
    const { engine, seen } = await scripted(p.agentDir, [say("one"), say("two"), say("three")]);
    const o = { id: "pg", file: join(p.docs, "pg.md"), images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "THE-PROTOCOL" };
    const a = await engine.start({ ...o, onStep: () => {} });
    expect(a.sessionId).toBeString();
    expect(a.resumed).toBe(false);
    await a.run("FIRST PROMPT");
    await a.close();
    expect(piSessionFile(p.agentDir, p.root, a.sessionId!)).toStartWith(piSessionDir(p.agentDir, p.root));

    const steps: AgentStep[] = [];
    const b = await engine.start({ ...o, resume: a.sessionId, onStep: (s) => steps.push(s) });
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.resumed).toBe(true);
    expect(steps[0]?.text).toContain("(resumed)");
    await b.run("SECOND PROMPT");
    expect(userTexts(seen[1]).join()).toContain("FIRST PROMPT");
    // The system prompt (the protocol) is given again to a resumed agent, so it need not be repeated in a message.
    const system = (ctx: any) => JSON.stringify(ctx.messages.filter((m: any) => m.role === "system"));
    expect(system(seen[0])).toContain("THE-PROTOCOL");
    expect(system(seen[1])).toContain("THE-PROTOCOL");
    await b.close();

    steps.length = 0;
    const c = await engine.start({ ...o, resume: "nope", onStep: (s) => steps.push(s) });
    expect(c.resumed).toBe(false);
    expect(c.sessionId).not.toBe("nope");
    expect(steps.some((s) => s.kind === "error" && s.text.includes("gone"))).toBe(true);
    await c.run("THIRD");
    expect(userTexts(seen[2]).join()).not.toContain("FIRST PROMPT");
    await c.close();
  });
});

/** The agent stream of page `id`, read as text, with a way to wait for the `count`th event of a kind. */
async function stream(id: string, model = "pi:acme/acme-small-5.5") {
  const { agentStream } = await import("../src/server/agent");
  const ac = new AbortController();
  const req = Object.assign(new Request(`http://x/?model=${model}`, { signal: ac.signal }), { params: { id } });
  const r = agentStream(req, { timeout() {} }).body!.getReader();
  let text = "";
  const count = (event: string) => text.split(`event: ${event}\n`).length - 1;
  return {
    get text() { return text; },
    count,
    async until(event: string, times = 1, ms = 10_000) {
      const t = Date.now();
      while (count(event) < times) {
        if (Date.now() - t > ms) throw new Error(`no ${times}× ${event} in:\n${text}`);
        const { value, done } = await r.read();
        if (done) throw new Error(`the stream ended: ${text}`);
        text += new TextDecoder().decode(value);
      }
    },
    stop: () => ac.abort(),
  };
}

/** A fake engine that keeps its conversation: it gives `reply` for every run, and records how it was started. */
function keeper(name: string, reply: string) {
  const starts: { model: string; resume?: string }[] = [];
  let off: string | null = null;
  const engine: AgentEngine = {
    name, title: name.toUpperCase(), chats: true, models: () => [{ id: "m", title: "M" }], unavailable: () => off,
    async start(o) {
      starts.push({ model: o.model, ...(o.resume && { resume: o.resume }) });
      const sessionId = o.resume ?? `${name}-${starts.length}`;
      return { sessionId, resumed: !!o.resume, died: new Promise<string>(() => {}), history: () => [], close: async () => {}, run: async () => ({ ok: true, result: reply }) };
    },
  };
  return { engine, starts, setOff: (why: string | null) => { off = why; } };
}

describe("an engine per page", () => {
  afterEach(() => { delete process.env.AGENT_WAIT_MS; delete process.env.AGENT_SETTLE_MS; });

  test("the page's engine can change while an agent sleeps: an ask again goes on with the agent's own engine, a new placeholder uses the page's", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_WAIT_MS = "100";
    process.env.AGENT_SETTLE_MS = "50";
    const file = join(p.docs, "swap.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    const a = keeper("alpha", envelope("from alpha"));
    const b = keeper("beta", envelope("from beta"));
    const old = setEngines([a.engine, b.engine]);
    const s = await stream("swap", "alpha:m");
    const { setAgentModel } = await import("../src/server/agent");
    const post = (body: object) => setAgentModel(Object.assign(new Request("http://x/", { method: "POST", body: JSON.stringify(body) }), { params: { id: "swap" } }));
    try {
      await s.until("snooze");
      expect(parseFile(readFileSync(file, "utf8")).block.tasks!.abc!.agent).toMatchObject({ engine: "alpha", session: "alpha-1" });
      // The page moves to beta: saved in its file.
      expect((await post({ model: "beta:m" })).status).toBe(200);
      expect(parseFile(readFileSync(file, "utf8")).block.agent).toEqual({ model: "beta:m" });
      // Ask again: alpha's agent is woken with its session, not beta started.
      writeFileSync(file, readFileSync(file, "utf8").replace("gen:abc:sug", "gen:abc"));
      await s.until("end", 2);
      expect(a.starts).toEqual([{ model: "m" }, { model: "m", resume: "alpha-1" }]);
      expect(b.starts).toEqual([]);
      expect(s.text).toMatch(/event: start\ndata: [^\n]*"engine":"alpha"[^\n]*\n\n[\s\S]*event: start\ndata: [^\n]*"engine":"alpha"/);
      // A new task goes to the page's engine.
      await s.until("snooze", 2);
      writeFileSync(file, readFileSync(file, "utf8").replace("end.", "end. <!-- gen:xyz -->"));
      await s.until("end", 3);
      expect(b.starts).toEqual([{ model: "m" }]);
      expect(s.text).toMatch(/event: start\ndata: [^\n]*"task":"xyz"[^\n]*"engine":"beta"/);
      // Alpha can't run now: an ask again on its task starts a fresh agent on the page's engine.
      await s.until("snooze", 3);
      a.setOff("no key");
      writeFileSync(file, readFileSync(file, "utf8").replace("gen:abc:sug", "gen:abc"));
      await s.until("end", 4);
      expect(a.starts).toHaveLength(2);
      expect(b.starts).toEqual([{ model: "m" }, { model: "m" }]); // fresh: no resume
      expect(parseFile(readFileSync(file, "utf8")).block.tasks!.abc!.agent).toMatchObject({ engine: "beta" });
    } finally {
      s.stop();
      setEngines(old);
    }
  });
});

describe("the agent loop keeps Pi agents", () => {
  afterEach(() => { delete process.env.AGENT_WAIT_MS; });

  test("after its run the agent waits, then snoozes; an ask again resumes its conversation, and the protocol is in its system prompt, not repeated in a message", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_GAP_MS = "50";
    process.env.AGENT_SETTLE_MS = "50";
    process.env.AGENT_WAIT_MS = "300";
    const file = join(p.docs, "keep.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    const { engine, seen } = await scripted(p.agentDir, [say(envelope("first")), say(envelope("second"))]);
    const old = setEngines([fakeEngine, engine]);
    const s = await stream("keep");
    try {
      await s.until("wait");
      expect(s.text).toMatch(/event: wait\ndata: .*"task":"abc".*"until":\d+/);
      // Whose agent it is, for the pill's mark: on the run's start, its wait, and (below) its snooze.
      expect(s.text).toMatch(/event: start\ndata: .*"task":"abc".*"engine":"pi"/);
      expect(s.text).toMatch(/event: wait\ndata: .*"engine":"pi"/);
      const record = parseFile(readFileSync(file, "utf8")).block.tasks!.abc!;
      const session = record.agent?.session;
      expect(record.agent).toMatchObject({ engine: "pi", model: "acme/acme-small-5.5", session: expect.any(String) });
      // The protocol is in the system prompt, which every start gives (a resumed agent too), and in no message.
      const system = (ctx: any) => JSON.stringify(ctx.messages.filter((m: any) => m.role === "system"));
      const opening = "The writer of a page left a **task**";
      expect(system(seen[0])).toContain(opening);
      expect(system(seen[0])).not.toContain("Without the tools"); // Pi has the reply tools: no envelope
      expect(userTexts(seen[0]).join()).not.toContain("<protocol>");
      await s.until("snooze");
      expect(s.text).toMatch(/event: snooze\ndata: .*"engine":"pi"/);

      // Ask again: the task waits again; its run wakes the snoozed conversation.
      writeFileSync(file, readFileSync(file, "utf8").replace("gen:abc:sug", "gen:abc"));
      await s.until("end", 2);
      expect(s.text).toContain("(resumed)");
      expect(system(seen[1])).toContain(opening); // the woken conversation has it too
      expect(userTexts(seen[1]).join()).not.toContain("<protocol>");
      const after = parseFile(readFileSync(file, "utf8")).block.tasks!.abc!;
      expect(after.suggestion).toBe("second");
      expect(after.agent!.session).toBe(session!);
    } finally {
      s.stop();
      setEngines(old);
    }
  });

  test("an ask again while the agent waits goes to that same agent; accepting the suggestion snoozes it", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_WAIT_MS = "60000";
    const file = join(p.docs, "same.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    const { engine } = await scripted(p.agentDir, [say(envelope("first")), say(envelope("second"))]);
    const old = setEngines([fakeEngine, engine]);
    const s = await stream("same");
    try {
      await s.until("wait");
      writeFileSync(file, readFileSync(file, "utf8").replace("gen:abc:sug", "gen:abc"));
      await s.until("wait", 2);
      expect(s.count("step") && s.text.split('"kind":"init"').length - 1).toBe(1); // no second start
      // Accepted: the task leaves the page, and its agent has nothing more to do.
      writeFileSync(file, readFileSync(file, "utf8").replace(" <!-- gen:abc:sug -->", " second"));
      await s.until("snooze");
    } finally {
      s.stop();
      setEngines(old);
    }
  });

  test("an engine without conversations keeps no agent: no wait, nothing recorded", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    const file = join(p.docs, "plain.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    const old = process.env.AGENT_CMD;
    process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `read line; printf '%s\\n' '{"type":"result","result":"<suggestion mode=\\"at\\" place=\\"inline\\">x</suggestion>","is_error":false}'; read line`]);
    const s = await stream("plain", "fake:small");
    try {
      await s.until("end");
      await wait(100);
      expect(s.count("wait")).toBe(0);
      expect(parseFile(readFileSync(file, "utf8")).block.tasks!.abc!.agent).toBeUndefined();
    } finally {
      s.stop();
      if (old === undefined) delete process.env.AGENT_CMD; else process.env.AGENT_CMD = old;
    }
  });
});

/** A chat stream on `task`, read as chat events, with a way to wait for one. */
async function chat(id: string, task: string) {
  const { chatStream } = await import("../src/server/chat");
  const ac = new AbortController();
  const res = await chatStream(Object.assign(new Request("http://x/", { signal: ac.signal }), { params: { id, target: task } }), { timeout() {} });
  if (!res.ok) return { ok: false as const, status: res.status, body: (await res.json()) as any };
  const r = res.body!.getReader();
  const events: ChatEvent[] = [];
  let buf = "";
  return {
    ok: true as const,
    status: res.status,
    events,
    async until(pred: (e: ChatEvent) => boolean, ms = 10_000) {
      const t = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t > ms) throw new Error(`not seen in: ${JSON.stringify(events).slice(0, 2000)}`);
        const { value, done } = await r.read();
        if (done) throw new Error("the chat stream ended");
        buf += new TextDecoder().decode(value);
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
          const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    },
    close: () => ac.abort(),
  };
}
const talk = async (id: string, task: string, text: string) => {
  const { chatSay } = await import("../src/server/chat");
  return chatSay(Object.assign(new Request("http://x/", { method: "POST", body: JSON.stringify({ text }) }), { params: { id, target: task } }));
};

describe("Pi's stream for a chat that opens mid-run", () => {
  test("the reply streaming now is in the history, and a tool call with no result yet is running", async () => {
    const { piStreamer, piHistory } = await import("../src/server/agent/engines/pi");
    const s = piStreamer(() => {});
    s({ type: "message_start", message: { role: "assistant" } });
    s({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Half a " } });
    s({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "thought" } });
    expect(s.partial()).toMatchObject({ role: "assistant", streaming: true, blocks: [{ type: "text", text: "Half a thought" }] });
    s({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Half a thought" }] } });
    expect(s.partial()).toBeNull();
    const called = [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] }];
    expect(piHistory(called, true)[0]!.blocks[0]).toMatchObject({ type: "tool", running: true });
    expect(piHistory(called)[0]!.blocks[0]).not.toHaveProperty("running");
  });
});

describe("the chat", () => {
  afterEach(() => { delete process.env.AGENT_WAIT_MS; });

  test("borrows the waiting agent: its conversation, then the reply streaming in (text, a tool call and its result, what it cost), a new suggestion onto the card, and the agent back to waiting when it closes", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_SETTLE_MS = "50";
    process.env.AGENT_WAIT_MS = "60000";
    const file = join(p.docs, "talk.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    const { engine, seen } = await scripted(p.agentDir, [say(envelope("first")), tool("read", { path: file }), say(`Longer, then.\n${envelope("a much longer one")}`)]);
    const old = setEngines([fakeEngine, engine]);
    const page = await stream("talk");
    try {
      await page.until("wait");
      const c = await chat("talk", "abc");
      if (!c.ok) throw new Error(`chat refused: ${c.status}`);
      const history = (await c.until((e) => e.t === "history")) as Extract<ChatEvent, { t: "history" }>;
      expect(history.model).toBe("pi:acme/acme-small-5.5");
      expect(history.messages.map((m) => m.role)).toEqual(["task", "assistant"]);
      expect(JSON.stringify(history.messages[1]!.blocks)).toContain("first");
      await page.until("chat");

      expect((await talk("talk", "abc", "make it longer")).status).toBe(202);
      // Mid-reply, Pi takes it in after its current step (steering): the same reply reads it.
      const again = await talk("talk", "abc", "again");
      expect(again.status).toBe(202);
      await c.until((e) => e.t === "busy" && !e.busy);
      const kinds = c.events.map((e) => e.t);
      expect(kinds).toContain("delta");
      expect(kinds).toContain("revised");
      expect(c.events.find((e) => e.t === "message" && e.message.role === "user")).toMatchObject({ message: { blocks: [{ type: "text", text: "make it longer" }] } });
      const tool = c.events.find((e) => e.t === "tool") as Extract<ChatEvent, { t: "tool" }>;
      expect(tool.tool).toMatchObject({ name: "read", brief: file, running: true });
      expect(c.events.find((e) => e.t === "tool_result")).toMatchObject({ toolId: tool.tool.id, isError: false, result: expect.stringContaining("Plan:") });
      const done = c.events.filter((e): e is Extract<ChatEvent, { t: "message" }> => e.t === "message" && e.message.role === "assistant" && !e.message.streaming);
      expect(done.at(-1)!.message.stats).toMatchObject({ model: expect.any(String), ms: expect.any(Number) });
      // The writer's words go in tags, the first time with what the chat is for.
      const sent = userTexts(seen.at(-1)).find((t) => t.includes("make it longer"))!;
      expect(userTexts(seen.at(-1)).at(-1)).toContain("again"); // the steered message reached the model too
      expect(sent).toContain("opened a chat with you about task abc");
      expect(sent).toContain("<chat>");
      expect(parseFile(readFileSync(file, "utf8")).block.tasks!.abc!.suggestion).toBe("a much longer one");
      expect(parseFile(readFileSync(file, "utf8")).markdown).toContain("<!-- gen:abc:sug -->");

      c.close();
      await page.until("chat_end");
      await page.until("wait", 2); // back to waiting
      const { openChats } = await import("../src/server/chat");
      expect(openChats()).toEqual([]);
    } finally {
      page.stop();
      setEngines(old);
    }
  });

  test("opened during the placeholder's first run, it looks in: the run so far, nothing to say yet; once the run ends it has the agent, and can talk", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_SETTLE_MS = "50";
    process.env.AGENT_WAIT_MS = "60000";
    const file = join(p.docs, "first.md");
    writeFileSync(file, "Plan: <!-- gen:abc --> end.\n");
    // The run takes a while: a tool call that sleeps, then its answer.
    const { engine } = await scripted(p.agentDir, [tool("bash", { command: "sleep 1" }), say(envelope("first")), say("Because it fits.")]);
    const old = setEngines([fakeEngine, engine]);
    const page = await stream("first");
    try {
      await page.until("start");
      expect(page.text).toContain('"chat":true');
      // Once the agent is on its tool call (a chat may open earlier too, and sees the run from where it is).
      for (const t = Date.now(); !page.text.includes('"name":"bash"'); ) { if (Date.now() - t > 10_000) throw new Error("no tool call"); await page.until("step", page.count("step") + 1); }
      const c = await chat("first", "abc");
      if (!c.ok) throw new Error(`chat refused: ${c.status} ${JSON.stringify(c.body)}`);
      const look = (await c.until((e) => e.t === "history")) as Extract<ChatEvent, { t: "history" }>;
      expect(look).toMatchObject({ watching: true, busy: true });
      expect((await talk("first", "abc", "why?")).status).toBe(409); // nothing to say until the run ends
      // The run streams in, then the chat gets the agent the run kept.
      const mine = (await c.until((e) => e.t === "history" && !e.watching)) as Extract<ChatEvent, { t: "history" }>;
      expect(mine).toMatchObject({ busy: false, model: "pi:acme/acme-small-5.5" });
      expect(mine.messages.map((m) => m.role)).toEqual(["task", "assistant", "assistant"]);
      // The tool call was made before the chat opened (in what it saw first, running); its result came live.
      expect(look.messages.at(-1)!.blocks).toContainEqual(expect.objectContaining({ type: "tool", name: "bash", running: true }));
      expect(c.events.some((e) => e.t === "tool_result")).toBe(true);
      expect(parseFile(readFileSync(file, "utf8")).block.tasks!.abc!.suggestion).toBe("first");
      await page.until("chat"); // the page sees it in the chat now

      expect((await talk("first", "abc", "why?")).status).toBe(202);
      await c.until((e) => e.t === "busy" && !e.busy);
      expect(c.events.map((e) => (e.t === "delta" ? e.delta : "")).join("")).toContain("Because it fits.");
      c.close();
      await page.until("chat_end");
    } finally {
      page.stop();
      setEngines(old);
    }
  });

  test("a chat that closes while it looks in leaves the run alone, and the agent waits as usual", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_SETTLE_MS = "50";
    process.env.AGENT_WAIT_MS = "60000";
    writeFileSync(join(p.docs, "peek.md"), "Plan: <!-- gen:abc --> end.\n");
    const { engine } = await scripted(p.agentDir, [tool("bash", { command: "sleep 0.5" }), say(envelope("done"))]);
    const old = setEngines([fakeEngine, engine]);
    const page = await stream("peek");
    try {
      await page.until("start");
      const c = await chat("peek", "abc");
      if (!c.ok) throw new Error(`chat refused: ${c.status}`);
      await c.until((e) => e.t === "history");
      c.close();
      await page.until("end");
      expect(page.text).toContain('"outcome":"suggested"');
      await page.until("wait");
      expect(page.count("chat")).toBe(0);
    } finally {
      page.stop();
      setEngines(old);
    }
  });

  test("wakes a snoozed conversation from disk when no page stream is open, and closes it after; refuses where no agent was kept; a second window joins it", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    const { engine, seen } = await scripted(p.agentDir, [say("earlier"), say("Hello again.")]);
    const old = setEngines([fakeEngine, engine]);
    const { root } = await import("../src/server/runtime");
    try {
      const first = await engine.start({ id: "nap", file: join(p.docs, "nap.md"), images: join(p.docs, "images"), root: root(), scratch: p.scratch, model: "m", system: "", onStep: () => {} });
      await first.run("THE ORIGINAL TASK");
      await first.close();
      const record = (agent?: TaskAgent) => ({ type: "gen", created_by: "writer" as const, created: "2026-10-31T10:00:00.000Z", status: "suggested" as const, mode: "at" as const, place: "inline" as const, suggestion: "x", ...(agent && { agent }) });
      writeFileSync(join(p.docs, "nap.md"), serializeFile("Plan: <!-- gen:abc:sug --> <!-- gen:nop:sug --> end.", { ...emptyBlock(), tasks: { abc: record({ ...PI, model: "m", session: first.sessionId! }), nop: record() } }));

      expect(await chat("nap", "nop")).toMatchObject({ status: 409, body: { error: { code: "no_agent" } } });
      const c = await chat("nap", "abc");
      if (!c.ok) throw new Error(`chat refused: ${c.status}`);
      const history = (await c.until((e) => e.t === "history")) as Extract<ChatEvent, { t: "history" }>;
      expect(history.messages[0]).toMatchObject({ role: "task", blocks: [{ text: "THE ORIGINAL TASK" }] });
      // A second window joins the same chat, conversation and all (a closed one left a reply going, say).
      const second = await chat("nap", "abc");
      if (!second.ok) throw new Error(`second window refused: ${second.status}`);
      expect(((await second.until((e) => e.t === "history")) as Extract<ChatEvent, { t: "history" }>).messages[0]).toMatchObject({ role: "task" });
      second.close();
      await talk("nap", "abc", "hi");
      await c.until((e) => e.t === "busy" && !e.busy);
      expect(userTexts(seen[1]).join()).toContain("THE ORIGINAL TASK");
      expect(c.events.some((e) => e.t === "revised")).toBe(false); // no suggestion in the reply: nothing changes
      c.close();
      await wait(50);
      const again = await chat("nap", "abc"); // closed and given back: it can open again
      expect(again.status).toBe(200);
      if (again.ok) again.close();
    } finally {
      setEngines(old);
    }
  });

  test("a placeholder being chatted about gets no run, until the chat ends", async () => {
    const p = place();
    process.env.SOLIPSIST_PROJECT_ROOT = p.root;
    process.env.AGENT_SETTLE_MS = "50";
    const file = join(p.docs, "hold.md");
    const { engine } = await scripted(p.agentDir, [say("earlier"), say(envelope("x"))]);
    const old = setEngines([fakeEngine, engine]);
    const { takeAgent, giveBack } = await import("../src/server/agent");
    const { root } = await import("../src/server/runtime");
    try {
      const first = await engine.start({ id: "hold", file, images: join(p.docs, "images"), root: root(), scratch: p.scratch, model: "m", system: "", onStep: () => {} });
      await first.run("task");
      await first.close();
      writeFileSync(file, serializeFile("Plan: <!-- gen:abc --> end.", { ...emptyBlock(), tasks: { abc: { type: "gen", created_by: "writer", created: "2026-10-31T10:00:00.000Z", status: "pending", agent: { ...PI, model: "m", session: first.sessionId! } } } }));
      const lent = await takeAgent("hold", "abc");
      if (typeof lent === "string" || "error" in lent) throw new Error(String(lent));
      const s = await stream("hold");
      await s.until("skip");
      expect(s.count("start")).toBe(0);
      await giveBack("hold", "abc", lent);
      await s.until("end");
      s.stop();
    } finally {
      setEngines(old);
    }
  });
});

describe("Pi's events as chat events (piStreamer, piHistory)", () => {
  const usage = (output: number) => ({ input: 10, output, cost: { total: 0.001 } });
  test("text streams by delta, a tool call shows once written and its result once run; a reply that came whole has no rate", async () => {
    const { piStreamer } = await import("../src/server/agent/engines/pi");
    const out: ChatEvent[] = [];
    const feed = piStreamer((e) => out.push(e));
    feed({ type: "message_start", message: { role: "user", content: "<chat>\nhi\n</chat>" } });
    feed({ type: "message_start", message: { role: "assistant" } });
    feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
    feed({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "t1", name: "bash", arguments: { command: "ls" } } } });
    await wait(300);
    feed({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hel" }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], usage: usage(30), model: "m", stopReason: "toolUse" } });
    feed({ type: "tool_execution_end", toolCallId: "t1", result: { content: [{ type: "text", text: "a.md" }] }, isError: false, durationMs: 4.6 });
    feed({ type: "message_start", message: { role: "assistant" } });
    feed({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], usage: usage(5), model: "m", stopReason: "stop" } });
    expect(out.map((e) => e.t)).toEqual(["message", "message", "delta", "tool", "message", "tool_result", "message", "message"]);
    expect(out[0]).toMatchObject({ message: { role: "user", blocks: [{ text: "hi" }] } });
    expect(out[3]).toMatchObject({ block: 1, tool: { name: "bash", brief: "ls", running: true } });
    const first = (out[4] as Extract<ChatEvent, { t: "message" }>).message.stats!;
    expect(first.tokensPerSec).toBeGreaterThan(0);
    expect(first.tokensPerSec).toBeLessThan(200); // 30 tokens over at least 0.3 s
    expect(out[5]).toMatchObject({ toolId: "t1", result: "a.md", durationMs: 5 });
    expect((out[7] as Extract<ChatEvent, { t: "message" }>).message.stats).toMatchObject({ output: 5, costUsd: 0.001 });
    expect((out[7] as Extract<ChatEvent, { t: "message" }>).message.stats!.tokensPerSec).toBeUndefined();
  });

  test("the history: the writer's words apart from Solipsist's prompts, each tool call with its result, an error kept", async () => {
    const { piHistory } = await import("../src/server/agent/engines/pi");
    const h = piHistory([
      { role: "user", content: "You are working on the page", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/a.md" } }], usage: usage(3), model: "m", stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "Plan" }], isError: false, timestamp: 3 },
      { role: "user", content: [{ type: "text", text: "intro\n<chat>\nshorter\n</chat>" }], timestamp: 4 },
      { role: "assistant", content: [], usage: usage(0), model: "m", stopReason: "error", errorMessage: "429", timestamp: 5 },
    ]);
    expect(h.map((m) => m.role)).toEqual(["task", "assistant", "user", "assistant"]);
    expect(h[1]!.blocks[0]).toMatchObject({ type: "tool", name: "read", brief: "/a.md", result: "Plan", isError: false });
    expect(h[2]!.blocks).toEqual([{ type: "text", text: "shorter" }]);
    expect(h[3]!.error).toBe("429");
  });
});
