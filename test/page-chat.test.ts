// The page-wide chat: an agent that knows the page, outlives its window, snoozes when left alone, and is taken up again.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFileSync } from "./outside";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEngine, StartOptions } from "../src/server/agent/engine";
import { setEngines } from "../src/server/agent/engines";
import { emptyBlock, parseFile, serializeFile } from "../src/shared/docfile";
import { chatForget, chatSay, chatStream, chatWindows, closeChats, openChats } from "../src/server/chat";
import { onPageChat, pageChatStatus, type PageChatStatus } from "../src/server/agent/pageChatStatus";
import { writeSettings } from "../src/server/agent/settings";
import type { ChatEvent, ChatMessage } from "../src/shared/chat";

const P = projectDir("solip-pichat-");
// Entered in `beforeEach`, not here: every test file in the process shares one working directory, and a file
// that changed it while the files were being loaded would be overruled by the next one's.
beforeEach(() => P.enter());
afterAll(() => P.done()); // put the project back: the files of a run share the environment

test("the chat starts on the engine and model the page is on (its saved choice), told its own name; a model it can't use falls back to an engine that chats", async () => {
  const started: { engine: string; model: string; system: string }[] = [];
  const mk = (name: string, chats: boolean): AgentEngine => ({
    name, title: name.toUpperCase(), chats, models: () => [{ id: "a", title: "A" }, { id: "b", title: "B" }], unavailable: () => null,
    async start(o) { started.push({ engine: name, model: o.model, system: o.system }); return { died: new Promise<string>(() => {}), history: () => [], close: async () => {}, run: async () => ({ ok: true, result: "" }) }; },
  });
  const old = setEngines([mk("one", true), mk("two", true), mk("nochat", false)]);
  try {
    const open = async (saved?: string) => {
      writeFileSync(join(P.docs, "note.md"), serializeFile("Hi.\n", { ...emptyBlock(), ...(saved && { agent: { model: saved } }) }));
      const ac = new AbortController();
      const res = await chatStream(Object.assign(new Request("http://x/api/pages/note/chat/page", { signal: ac.signal }), { params: { id: "note", target: "page" } }), { timeout() {} });
      ac.abort();
      await Bun.sleep(20);
      return res.status;
    };
    expect(await open("two:b")).toBe(200);
    expect(started.at(-1)).toMatchObject({ engine: "two", model: "b" });
    expect(started.at(-1)!.system).toContain("You are TWO");
    expect(started.at(-1)!.system).toContain("<suggestion"); // an engine without the reply tools is told the envelope
    expect(await open()).toBe(200); // no choice: the first that chats
    expect(started.at(-1)).toMatchObject({ engine: "one", model: "a" });
    expect(await open("nochat:a")).toBe(200); // an engine that can't chat
    expect(started.at(-1)).toMatchObject({ engine: "one", model: "a" });
    expect(await open("gone:z")).toBe(200);
    expect(started.at(-1)).toMatchObject({ engine: "one" });
  } finally {
    setEngines(old);
  }
});

const req = (method: string, body?: object, signal?: AbortSignal) =>
  Object.assign(new Request("http://x/api/pages/note/chat/page", { method, ...(body && { body: JSON.stringify(body) }), ...(signal && { signal }) }), { params: { id: "note", target: "page" } });
const say = (text: string) => chatSay(req("POST", { text }));
const until = async (ok: () => boolean, what: string) => { for (let i = 0; i < 300 && !ok(); i++) await Bun.sleep(10); if (!ok()) throw new Error(`timed out waiting for ${what}`); };
/** Reads a chat stream's events as they come. */
function events(res: Response) {
  const got: ChatEvent[] = [];
  void (async () => {
    const r = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (let buf = ""; ;) {
      const { value, done } = await r.read().catch(() => ({ value: "", done: true }));
      if (done) return;
      buf += value;
      for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
        const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
        if (data) got.push(JSON.parse(data.slice(6)));
      }
    }
  })();
  return got;
}
const fresh = (text = "Hi.\n") => writeFileSync(join(P.docs, "note.md"), serializeFile(text, emptyBlock()));
const saved = () => parseFile(readFileSync(join(P.docs, "note.md"), "utf8")).block.agent?.chat;

/** An engine whose agents keep their conversation (by session id), and whose replies wait for `release` when asked to. */
function keeping() {
  const log = { started: [] as StartOptions[], prompts: [] as string[], closed: 0 };
  const stored = new Map<string, ChatMessage[]>();
  let gate: (() => void) | null = null;
  let n = 0;
  const engine: AgentEngine = {
    name: "fake", title: "Fake", chats: true, replyTools: true, models: () => [{ id: "m", title: "M" }, { id: "n", title: "N" }], unavailable: () => null,
    async start(o) {
      log.started.push(o);
      const sessionId = o.resume && stored.has(o.resume) ? o.resume : `s${++n}`;
      const history = stored.get(sessionId) ?? [];
      stored.set(sessionId, history);
      return {
        sessionId, died: new Promise<string>(() => {}), history: () => [...history], close: async () => { log.closed++; },
        abort: async () => { gate?.(); },
        run: async (p) => {
          log.prompts.push(p);
          history.push({ id: `u${history.length}`, role: "user", blocks: [{ type: "text", text: p }] } as ChatMessage);
          if (p.includes("slow")) await new Promise<void>((r) => { gate = r; });
          const result = p.includes("propose") ? '<suggestion mode="at" place="blocks">\nAdded.\n</suggestion>' : "Hi.";
          history.push({ id: `a${history.length}`, role: "assistant", blocks: [{ type: "text", text: result }] } as ChatMessage);
          return { ok: true, result };
        },
      };
    },
  };
  return { engine, log, release: () => gate?.() };
}

afterEach(async () => { await closeChats("test"); delete process.env.AGENT_WAIT_MS; });

test("opens an agent told about the page and says things to it; a second window joins the same chat", async () => {
  fresh();
  const { engine, log } = keeping();
  const old = setEngines([engine]);
  try {
    const ac = new AbortController();
    const res = await chatStream(req("GET", undefined, ac.signal), { timeout() {} });
    expect(res.status).toBe(200);
    expect(log.started).toHaveLength(1);
    expect(log.started[0]!.system).toContain("note.md");
    expect(log.started[0]!.system).toContain("`suggest` tool"); // it may propose changes as suggestions, with the reply tools
    expect(log.started[0]!.system).not.toContain("<suggestion"); // not the envelope: this engine has the tools
    expect(log.started[0]!.replyTools).toBe(true);
    expect(log.started[0]!.system).toMatch(/Never edit the page or any other file yourself/);
    expect(openChats()).toEqual(["note/page"]);
    expect(saved()).toEqual({ engine: "fake", model: "m", session: "s1" }); // recorded, to be taken up again

    const ac2 = new AbortController();
    expect((await chatStream(req("GET", undefined, ac2.signal), { timeout() {} })).status).toBe(200);
    expect(log.started).toHaveLength(1); // the same agent
    expect(chatWindows("note", "page")).toBe(2);
    ac2.abort();

    expect((await say("what is this about?")).status).toBe(202);
    await until(() => log.prompts.length === 1, "the first prompt");
    expect(log.prompts[0]).toContain("note.md");
    expect(log.prompts[0]).toContain("<chat>\nwhat is this about?\n</chat>");
    expect((await say("")).status).toBe(400);
    for (let i = 0; i < 200 && (await say("again")).status === 409; i++) await Bun.sleep(10);
    await until(() => log.prompts.length === 2, "the second prompt");
    expect(log.prompts[1]).not.toContain("opened this chat");
    ac.abort();
  } finally {
    setEngines(old);
  }
});

test("closing the chat leaves the reply going: its suggestion still goes on the page, and opening it again shows it where it is", async () => {
  fresh();
  const { engine, log, release } = keeping();
  const old = setEngines([engine]);
  try {
    const ac = new AbortController();
    await chatStream(req("GET", undefined, ac.signal), { timeout() {} });
    expect((await say("slow, then propose something")).status).toBe(202);
    await until(() => log.prompts.length === 1, "the reply to start");
    ac.abort(); // the writer closes the chat mid-reply
    await Bun.sleep(20);
    expect(log.closed).toBe(0);
    expect(openChats()).toEqual(["note/page"]);

    const back = events(await chatStream(req("GET"), { timeout() {} }));
    await until(() => back.length > 0, "the history");
    expect(back[0]).toMatchObject({ t: "history", busy: true, model: "fake:m" });
    expect((back[0] as Extract<ChatEvent, { t: "history" }>).messages).toHaveLength(1); // the writer's message, the reply on its way
    expect((await say("more")).status).toBe(409); // still answering

    release();
    await until(() => back.some((e) => e.t === "busy" && !e.busy), "the reply to end");
    expect(back.some((e) => e.t === "revised")).toBe(true);
    const { markdown, block } = parseFile(readFileSync(join(P.docs, "note.md"), "utf8"));
    expect(Object.values(block.tasks ?? {})).toMatchObject([{ status: "suggested", suggestion: "Added." }]);
    expect(markdown).not.toContain("Added.");
  } finally {
    setEngines(old);
  }
});

test("left alone it snoozes after the wait, and the next open takes its conversation up again; New chat forgets it", async () => {
  fresh();
  process.env.AGENT_WAIT_MS = "50";
  const { engine, log } = keeping();
  const old = setEngines([engine]);
  try {
    const ac = new AbortController();
    await chatStream(req("GET", undefined, ac.signal), { timeout() {} });
    await say("hello");
    await until(() => log.prompts.length === 1, "the reply");
    for (let i = 0; i < 200 && (await say("x")).status !== 202; i++) await Bun.sleep(10); // a second message, so the history has 4
    ac.abort();
    await until(() => openChats().length === 0, "the snooze");
    expect(log.closed).toBe(1);

    const back = events(await chatStream(req("GET"), { timeout() {} }));
    await until(() => back.length > 0, "the history");
    expect(log.started.at(-1)!.resume).toBe("s1");
    expect((back[0] as Extract<ChatEvent, { t: "history" }>).messages).toHaveLength(4);
    await say("and now?");
    await until(() => log.prompts.length === 3, "the reply");
    expect(log.prompts[2]).not.toContain("opened this chat"); // it was told already

    expect((await chatForget(req("DELETE"))).status).toBe(204);
    expect(openChats()).toEqual([]);
    expect(saved()).toBeUndefined();
    const again = events(await chatStream(req("GET"), { timeout() {} }));
    await until(() => again.length > 0, "the history");
    expect(log.started.at(-1)!.resume).toBeUndefined();
    expect((again[0] as Extract<ChatEvent, { t: "history" }>).messages).toEqual([]);
    expect(saved()?.session).toBe("s2");
  } finally {
    setEngines(old);
  }
});

test("a change of the page's model starts a new chat on it; a reply in flight on the old one is stopped", async () => {
  fresh();
  const { engine, log } = keeping();
  const old = setEngines([engine]);
  try {
    await chatStream(req("GET"), { timeout() {} });
    await say("slow");
    await until(() => log.prompts.length === 1, "the reply to start");
    await writeSettings("note", { model: "fake:n" });
    const back = events(await chatStream(req("GET"), { timeout() {} }));
    await until(() => back.length > 0, "the history");
    expect(log.closed).toBe(1);
    expect(log.started.at(-1)).toMatchObject({ model: "n" });
    expect(log.started.at(-1)!.resume).toBeUndefined();
    expect(back[0]).toMatchObject({ busy: false, messages: [], model: "fake:n" });
    expect(saved()).toEqual({ engine: "fake", model: "n", session: "s2" });
  } finally {
    setEngines(old);
  }
});

import { taskStates } from "../src/shared/docfile";
import { suggestOnPage } from "../src/server/suggest";
import { projectDir } from "./project-dir";

const page = "# Plan\n\nIntro text.\n\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n\nEnd.\n";

test("a change the agent proposes becomes a suggestion on a point at the end of the page, with its edits", () => {
  const reply = '<edit><before>\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n</before><after></after></edit>\n<suggestion mode="at" place="blocks">\nAdded paragraph.\n</suggestion>\n<note>Dropped the table.</note>';
  const r = suggestOnPage(page, reply);
  expect(r.error).toBeUndefined();
  const { markdown, block } = parseFile(r.file!);
  expect(taskStates(markdown).get(r.id!)).toBe("sug");
  expect(markdown).toContain("| Web | 3 Sep |"); // nothing changed in the page yet
  expect(block.tasks![r.id!]).toMatchObject({ type: "gen", status: "suggested", mode: "at", place: "blocks", suggestion: "Added paragraph.", note: "Dropped the table.", edits: [{ after: "" }] });
});

test("conversation changes nothing; a broken envelope says why", () => {
  expect(suggestOnPage(page, "It is about a plan.")).toEqual({});
  expect(suggestOnPage(page, "<note>Just a note.</note>")).toEqual({});
  expect(suggestOnPage(page, "<edit><before>Not in the page</before><after>x</after></edit>").error).toMatch(/Edit 1/);
  expect(suggestOnPage(page, "<decline>No.</decline>")).toEqual({});
});

test("the page is told what the chat's agent is doing: up, open, working, a reply while closed, snoozed, gone", async () => {
  fresh();
  process.env.AGENT_WAIT_MS = "60";
  const { engine, log, release } = keeping();
  const old = setEngines([engine]);
  const told: PageChatStatus[] = [];
  const off = onPageChat("note", (s) => told.push(s));
  try {
    expect(pageChatStatus("note")).toEqual({ state: "none" });
    const ac = new AbortController();
    await chatStream(req("GET", undefined, ac.signal), { timeout() {} });
    expect(pageChatStatus("note")).toEqual({ state: "open" });
    await say("slow");
    await until(() => told.at(-1)?.state === "working", "working");
    ac.abort(); // closed mid-reply: still working
    await Bun.sleep(10);
    expect(pageChatStatus("note")).toEqual({ state: "working" });
    release();
    await until(() => told.at(-1)?.state === "waiting", "the reply to end");
    expect(told.at(-1)).toEqual({ state: "waiting", unread: true });
    await until(() => told.at(-1)?.state === "snoozed", "the snooze");
    expect(told.at(-1)).toEqual({ state: "snoozed", unread: true }); // still not seen
    await chatStream(req("GET"), { timeout() {} });
    expect(pageChatStatus("note")).toEqual({ state: "open" }); // opened: seen
    await chatForget(req("DELETE"));
    expect(told.at(-1)).toEqual({ state: "none" });
    expect(told.map((s) => s.state)).toEqual(["open", "working", "waiting", "snoozed", "open", "none"]); // nothing in between
    expect(log.closed).toBe(2);
  } finally {
    off();
    setEngines(old);
  }
});

test("a message steered in just as the reply ends (the engine says no run is in flight) becomes a reply of its own", async () => {
  fresh();
  const prompts: string[] = [];
  let release: () => void = () => {};
  const engine: AgentEngine = {
    name: "fake", title: "Fake", chats: true, models: () => [{ id: "m", title: "M" }], unavailable: () => null,
    async start() {
      return {
        sessionId: "s1", died: new Promise<string>(() => {}), history: () => [], close: async () => {},
        // As if the run had just ended when the message came: it is not taken in.
        steer: async () => { release(); return false; },
        run: async (p) => { prompts.push(p); if (prompts.length === 1) await new Promise<void>((r) => { release = r; }); return { ok: true, result: "Hi." }; },
      };
    },
  };
  const old = setEngines([engine]);
  try {
    await chatStream(req("GET"), { timeout() {} });
    expect((await say("first")).status).toBe(202);
    await until(() => prompts.length === 1, "the first reply");
    const second = await say("second, mid-reply");
    expect(second.status).toBe(202);
    expect(await second.json()).toEqual({ ok: true }); // not steered: a reply of its own
    await until(() => prompts.length === 2, "the second reply");
    expect(prompts[1]).toContain("second, mid-reply");
  } finally {
    setEngines(old);
  }
});

test("the page chat gives its result with the reply tools: each call is checked against the page during the reply, and a suggestion goes at the end of the page", async () => {
  fresh("# Plan\n\nIntro text.\n");
  const checks: (string | null)[] = [];
  const engine: AgentEngine = {
    name: "fake", title: "Fake", chats: true, replyTools: true, models: () => [{ id: "m", title: "M" }], unavailable: () => null,
    async start() {
      return {
        sessionId: "s1", died: new Promise<string>(() => {}), history: () => [], close: async () => {},
        run: async (_p, opts) => {
          checks.push(opts!.check!({ kind: "suggestion", edits: [{ before: "Not in the page.", after: "x" }] }));
          const good = { kind: "suggestion" as const, mode: "at" as const, place: "blocks" as const, suggestion: "Added.", edits: [{ before: "Intro text.", after: "Intro, shorter." }], note: "Tidied." };
          checks.push(opts!.check!(good));
          checks.push(opts!.check!({ kind: "answer", answer: "It is a plan." }));
          return { ok: true, result: "", reply: good };
        },
      };
    },
  };
  const old = setEngines([engine]);
  try {
    const back = events(await chatStream(req("GET"), { timeout() {} }));
    expect((await say("tidy it")).status).toBe(202);
    await until(() => back.some((e) => e.t === "busy" && !e.busy), "the reply");
    expect(checks[0]).toMatch(/Edit 1/);
    expect(checks.slice(1)).toEqual([null, null]);
    expect(back).toContainEqual({ t: "revised", created: true });
    const { markdown, block } = parseFile(readFileSync(join(P.docs, "note.md"), "utf8"));
    expect(markdown).toContain("Intro text."); // nothing changed in the page until the writer accepts
    expect(Object.values(block.tasks ?? {})).toMatchObject([{ status: "suggested", suggestion: "Added.", note: "Tidied.", edits: [{ after: "Intro, shorter." }] }]);
  } finally {
    setEngines(old);
  }
});

test("New chat is the page's only: a task's chat has no DELETE", async () => {
  const r = await chatForget(Object.assign(new Request("http://x/", { method: "DELETE" }), { params: { id: "note", target: "abcde" } }));
  expect(r.status).toBe(400);
});
