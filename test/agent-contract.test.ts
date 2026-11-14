// The agent loop's contract, engine aside: what a run's reply does to the page, what the loop
// passes an engine, that every agent it starts is closed, how kept agents wait and snooze, and that a kind's own rules
// hold through a run. An in-memory engine stands in for Pi, so these hold for any engine and survive the loop moving
// out of the stream. Each reply is written once, as a `Reply`, and sent as the text envelope (`asText`); the tool
// path will send the same table.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "./outside";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "../src/plugins";
import { agentStream, openAgents, stopAgents, systemPrompt } from "../src/server/agent";
import { resetRuntime } from "../src/server/runtime";
import { stopAllPages } from "../src/server/agent/pageAgents";
import type { AgentEngine, AgentSession, RunOptions, RunResult, StartOptions } from "../src/server/agent/engine";
import { callReplyTool, REPLY_TOOLS } from "../src/server/agent/replyTools";
import { setEngines } from "../src/server/agent/engines";
import type { Reply } from "../src/server/suggest";
import { parseFile, type TaskRecord } from "../src/shared/docfile";
import { registerPlugin, unregisterPlugin } from "../src/shared/plugin";
import { registerTaskTypeServer, unregisterTaskTypeServer } from "../src/server/taskTypes";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "solip-contract-")));
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT;
const restoreProject = () => { if (wasProject === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT; else process.env.SOLIPSIST_PROJECT_ROOT = wasProject; };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const projectRoot = dir;
const docs = join(dir, ".solipsist", "pages");
mkdirSync(docs, { recursive: true });
const page = (id: string) => join(docs, `${id}.md`);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV = ["AGENT_COST_LIMIT_USD", "AGENT_GAP_MS", "AGENT_SETTLE_MS", "AGENT_WAIT_MS", "AGENT_MAX_WAITING", "AGENT_RUN_TIMEOUT_MS", "AGENT_CONCURRENCY", "AGENT_MAX_RUNS", "AGENT_SINGLE_AGENT"];
let saved: Record<string, string | undefined> = {};
/** The engines before the test set its own; `undefined` while it hasn't. */
let oldEngines: AgentEngine[] | null | undefined;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.SOLIPSIST_PROJECT_ROOT = projectRoot;
  process.env.AGENT_GAP_MS = "20";
  process.env.AGENT_SETTLE_MS = "20";
});
afterEach(async () => {
  // A page's agents outlive its stream: each test's are turned off after it.
  await stopAllPages("test over");
  restoreProject();
  resetRuntime();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  if (oldEngines !== undefined) setEngines(oldEngines);
  oldEngines = undefined;
});

/** A reply as the text envelope of `protocol.md`. */
export function asText(r: Reply): string {
  if (r.kind === "decline") return `I won't.\n\n<decline>${r.note}</decline>`;
  const note = r.note ? `\n<note>${r.note}</note>` : "";
  if (r.kind === "answer") return `<answer>\n${r.answer}\n</answer>${note}`;
  const s = r.suggestion !== undefined ? `<suggestion mode="${r.mode}" place="${r.place}">\n${r.suggestion}\n</suggestion>\n` : "";
  const edits = (r.edits ?? []).map((e) => `<edit>\n<before>\n${e.before}\n</before>\n<after>\n${e.after}\n</after>\n</edit>\n`).join("");
  return `Done.\n\n${s}${edits}${note}`;
}

/** A reply as the reply tool call that gives it (`replyTools.ts`). */
export function asToolCall(r: Reply): { tool: string; params: Record<string, unknown> } {
  if (r.kind === "decline") return { tool: "decline", params: { reason: r.note } };
  if (r.kind === "answer") return { tool: "answer", params: { answer: r.answer, ...(r.note && { note: r.note }) } };
  return { tool: "suggest", params: { ...(r.suggestion !== undefined && { mode: r.mode, place: r.place, markdown: r.suggestion }), ...(r.edits && { edits: r.edits }), ...(r.note && { note: r.note }) } };
}
/** An agent that gives `r` with a reply tool, checked by the run as Pi's tools are; one the check refuses gives nothing. */
const callingTool = (r: Reply) => (_p: string, _n: number, opts?: RunOptions): RunResult => {
  const { tool, params } = asToolCall(r);
  const got = callReplyTool(REPLY_TOOLS.find((t) => t.name === tool)!, params, opts?.check);
  return { ok: true, result: "", ...("reply" in got && { reply: got.reply }) };
};

/**
 * An engine whose agents answer with `answer(prompt, run)`. `keeps`: its agents have a session id, so the loop keeps
 * them (as Pi's). It logs what it was given and how many of its agents are open.
 */
function fakeEngine(answer: (prompt: string, run: number, opts?: RunOptions) => RunResult | Promise<RunResult>, o: { keeps?: boolean; dies?: boolean } = {}) {
  const log = { starts: [] as StartOptions[], prompts: [] as string[], open: 0, closed: 0 };
  let runs = 0, sessions = 0;
  const engine: AgentEngine = {
    name: "fake", title: "Fake", chats: o.keeps, models: () => [{ id: "m", title: "M" }], unavailable: () => null,
    async start(opts): Promise<AgentSession> {
      log.starts.push(opts);
      log.open++;
      let closed = false;
      let die: (why: string) => void = () => {};
      const died = new Promise<string>((r) => { die = r; });
      const sessionId = o.keeps ? (opts.resume ?? `s${++sessions}`) : undefined;
      return {
        ...(sessionId && { sessionId, resumed: !!opts.resume }),
        history: () => [],
        died,
        async run(prompt, runOpts) {
          log.prompts.push(prompt);
          const n = ++runs;
          if (o.dies) { die("it died"); return new Promise<RunResult>(() => {}); }
          return answer(prompt, n, runOpts);
        },
        async close() { if (!closed) { closed = true; log.open--; log.closed++; } },
      };
    },
  };
  const before = setEngines([engine]);
  if (oldEngines === undefined) oldEngines = before;
  return log;
}
/** The writer turns the page's agents off. */
const turnOff = (id: string) => stopAgents(Object.assign(new Request("http://x/", { method: "POST" }), { params: { id } }));
const replying = (r: Reply | string) => (): RunResult => ({ ok: true, result: typeof r === "string" ? r : asText(r) });

/** The agent stream of page `id`, read as text, with a way to wait for the `times`th event of a kind. */
function stream(id: string) {
  const ac = new AbortController();
  const res = agentStream(Object.assign(new Request("http://x/?model=fake:m", { signal: ac.signal }), { params: { id } }), { timeout() {} });
  const r = res.body!.getReader();
  let text = "";
  const count = (event: string) => text.split(`event: ${event}\n`).length - 1;
  const events = (event: string) => text.split(`event: ${event}\ndata: `).slice(1).map((s) => JSON.parse(s.slice(0, s.indexOf("\n"))));
  return {
    get text() { return text; },
    count,
    events,
    async until(event: string, times = 1, ms = 5_000) {
      const t = Date.now();
      while (count(event) < times) {
        if (Date.now() - t > ms) throw new Error(`no ${times}× ${event} in:\n${text}`);
        const got = await Promise.race([r.read(), wait(ms).then(() => null)]);
        if (!got || got.done) throw new Error(`the stream ended before ${times}× ${event}:\n${text}`);
        text += new TextDecoder().decode(got.value);
      }
    },
    /** Reads what comes in for `ms`. */
    async drain(ms: number) {
      const end = Date.now() + ms;
      for (let left; (left = end - Date.now()) > 0;) {
        const got = await Promise.race([r.read(), wait(left).then(() => null)]);
        if (!got || got.done) return;
        text += new TextDecoder().decode(got.value);
      }
    },
    stop: () => ac.abort(),
  };
}
const record = (id: string, task = "abc"): TaskRecord => parseFile(readFileSync(page(id), "utf8")).block.tasks![task]!;
const body = (id: string) => parseFile(readFileSync(page(id), "utf8")).markdown;
let n = 0;
const fresh = (src: string) => { const id = `c${n++}`; writeFileSync(page(id), src); return id; };
/** Waits until `ok()` holds. */
const until = async (ok: () => boolean, what: string) => { for (const t = Date.now(); !ok(); await wait(10)) if (Date.now() - t > 2000) throw new Error(what); };
const settled = async (log: { open: number }) => { for (const t = Date.now(); log.open > 0; await wait(10)) if (Date.now() - t > 2000) throw new Error(`${log.open} agent(s) still open`); };

describe("what a run's reply does to the page", () => {
  const TABLE = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
  /** Every kind of reply: the page, the task, the reply, and what the record and body must be after it. */
  const cases: { name: string; src: string; reply: Reply; outcome: "suggested" | "declined"; body: string; rec: Partial<TaskRecord> }[] = [
    {
      name: "a suggestion at a point",
      src: "Plan: <!-- gen:abc --> end.\n", reply: { kind: "suggestion", mode: "at", place: "inline", suggestion: "the *plan*", note: "Filled." },
      outcome: "suggested", body: "Plan: <!-- gen:abc:sug --> end.", rec: { status: "suggested", mode: "at", place: "inline", suggestion: "the *plan*", note: "Filled." },
    },
    {
      name: "a rewrite of a range, as blocks",
      src: "<!-- sel:abc -->Old words.<!-- /sel:abc -->\n", reply: { kind: "suggestion", mode: "replace", place: "blocks", suggestion: "New one.\n\nNew two." },
      outcome: "suggested", body: "<!-- sel:abc:sug -->Old words.<!-- /sel:abc:sug -->", rec: { status: "suggested", mode: "replace", place: "blocks", suggestion: "New one.\n\nNew two.", saw: "Old words." },
    },
    {
      name: "edits to other blocks only",
      src: `<!-- sel:abc "remove the table" -->Below.<!-- /sel:abc -->\n\n${TABLE}\n`, reply: { kind: "suggestion", edits: [{ before: TABLE, after: "" }], note: "Removed it." },
      outcome: "suggested", body: `<!-- sel:abc:sug "remove the table" -->Below.<!-- /sel:abc:sug -->\n\n${TABLE}`, rec: { status: "suggested", edits: [{ before: TABLE, after: "" }], note: "Removed it." },
    },
    {
      name: "an answer",
      src: `<!-- sel:abc "is this right?" -->Water boils at 90°C.<!-- /sel:abc -->\n`, reply: { kind: "answer", answer: "No: 100°C at sea level." },
      outcome: "suggested", body: `<!-- sel:abc:sug "is this right?" -->Water boils at 90°C.<!-- /sel:abc:sug -->`, rec: { status: "suggested", answer: "No: 100°C at sea level." },
    },
    {
      name: "a decline",
      src: "Plan: <!-- gen:abc --> end.\n", reply: { kind: "decline", note: "Nothing fits here." },
      outcome: "declined", body: "Plan: <!-- gen:abc:sug --> end.", rec: { status: "declined", note: "Nothing fits here." },
    },
  ];
  for (const c of cases) for (const via of ["text", "tools"] as const) {
    test(`${c.name} (${via}): ${c.outcome}, in the record, the body untouched but for the state`, async () => {
      const log = fakeEngine(via === "text" ? replying(c.reply) : callingTool(c.reply));
      const id = fresh(c.src);
      const s = stream(id);
      try {
        await s.until("end");
        expect(s.events("end")[0]).toMatchObject({ ok: true, outcome: c.outcome, task: "abc" });
        expect(body(id)).toBe(c.body);
        expect(record(id)).toMatchObject(c.rec);
        if (c.reply.kind !== "suggestion" || c.reply.suggestion === undefined) expect(record(id).suggestion).toBeUndefined();
        expect(log.starts[0]!.replyTools).toBe(true);
      } finally { s.stop(); }
      await settled(log);
    });
  }

  test("a reply that can't be used is tried again, and declined on the third, saying why", async () => {
    const log = fakeEngine(replying("I did it, honest."));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("end", 3);
      expect(s.events("end").map((e) => e.outcome)).toEqual(["failed", "failed", "declined"]);
      expect(body(id)).toBe("Plan: <!-- gen:abc:sug --> end.");
      expect(record(id)).toMatchObject({ status: "declined", note: expect.stringContaining("no <suggestion>") });
      await s.drain(150);
      expect(s.count("start")).toBe(3);
    } finally { s.stop(); }
    await settled(log);
  });

  test("a tool call the run's check refuses never reaches the page: the run fails as an envelope's would", async () => {
    const log = fakeEngine(callingTool({ kind: "suggestion", mode: "replace", place: "inline", suggestion: "x" }));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("end");
      expect(s.events("end")[0]).toMatchObject({ ok: false, outcome: "failed" });
      expect(record(id).suggestion).toBeUndefined();
    } finally { s.stop(); }
    await settled(log);
  });

  test("a mode the kind doesn't allow is refused (a plugin's own rules hold through a run)", async () => {
    registerPlugin({ taskType: "tst", shape: "range", title: "Test" });
    registerTaskTypeServer({ taskType: "tst", modes: ["replace"] });
    try {
      const log = fakeEngine(replying({ kind: "suggestion", mode: "after", place: "inline", suggestion: "x" }));
      const id = fresh("<!-- tst:abc -->Words.<!-- /tst:abc -->\n");
      const s = stream(id);
      try {
        await s.until("end", 3);
        expect(record(id)).toMatchObject({ status: "declined", note: expect.stringMatching(/mode/) });
        expect(log.prompts[0]).toContain('<task-type name="tst" shape="range">');
      } finally { s.stop(); }
      await settled(log);
    } finally { unregisterPlugin("tst"); unregisterTaskTypeServer("tst"); }
  });
});

describe("what the loop gives an engine", () => {
  test("the page, its image folder, the project, a scratch folder, the model and the protocol; the prompt names the placeholder", async () => {
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("end");
      const o = log.starts[0]!;
      expect(o).toMatchObject({ id, file: resolve(page(id)), images: resolve(projectRoot, ".solipsist", "images", id), root: projectRoot, model: "m", system: systemPrompt() });
      expect(o.resume).toBeUndefined();
      expect(o.system.length).toBeGreaterThan(1000);
      expect(existsSync(o.images)).toBe(true);
      expect(existsSync(o.scratch)).toBe(true);
      expect(log.prompts[0]).toContain("Your task this run: the gen task abc, marked `<!-- gen:abc:ack -->`");
      expect(log.prompts[0]).toContain(`<page-file path="${resolve(page(id))}">`);
    } finally { s.stop(); }
    await settled(log);
    await until(() => !existsSync(log.starts[0]!.scratch), "the scratch folder is still there");
  });

  test("an engine that keeps conversations: the protocol is in the system prompt and in no message, the record names the session, and an ask again after a snooze resumes it", async () => {
    process.env.AGENT_WAIT_MS = "50";
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }), { keeps: true });
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("snooze");
      expect(log.prompts[0]).not.toContain("<protocol>"); // it is the system prompt's
      expect(record(id).agent).toEqual({ engine: "fake", model: "m", session: "s1" });
      expect(log.open).toBe(0);
      writeFileSync(page(id), readFileSync(page(id), "utf8").replace("gen:abc:sug", "gen:abc"));
      await s.until("end", 2);
      expect(log.starts[1]!.resume).toBe("s1");
      expect(log.starts[1]!.system).toBe(systemPrompt()); // a resumed agent is given the protocol again
      expect(log.prompts[1]).not.toContain("<protocol>");
    } finally { s.stop(); }
    await settled(log);
  });
});

describe("single-agent mode", () => {
  /** The page's agent as its file records it (`block.agent.solo`). */
  const solo = (id: string) => parseFile(readFileSync(page(id), "utf8")).block.agent?.solo;

  test("every placeholder is a turn of one conversation: one agent, one run at a time, and a short prompt after the first", async () => {
    process.env.AGENT_SINGLE_AGENT = "true";
    process.env.AGENT_CONCURRENCY = "3"; // ignored: the one agent takes its turns one at a time
    process.env.AGENT_WAIT_MS = "60000";
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }), { keeps: true });
    const id = fresh("One <!-- gen:abc -->. Two <!-- gen:def -->. Three <!-- gen:ghi -->.\n");
    const s = stream(id);
    try {
      await s.until("end", 3);
      // One agent for the three of them, and never two runs at once.
      expect(log.starts.length).toBe(1);
      expect(log.prompts.length).toBe(3);
      expect(s.events("start").map((e) => e.task)).toEqual(["abc", "def", "ghi"]);
      expect(log.open).toBe(1);
      // The first run is told everything; the turns after it only what is new.
      expect(log.prompts[0]).toContain("<page-file");
      for (const prompt of log.prompts.slice(1)) {
        expect(prompt).not.toContain("<page-file");
        expect(prompt).not.toContain("<task-type name=");
        expect(prompt).toContain("Next, on the same page");
      }
      expect(log.prompts[1]).toContain("gen:def");
      // Recorded, so a turn after it has snoozed is the same conversation.
      expect(solo(id)).toEqual({ engine: "fake", model: "m", session: "s1" });
      expect(record(id, "ghi").agent).toEqual({ engine: "fake", model: "m", session: "s1" });
    } finally { s.stop(); }
    // It waits for more work; turned off, it leaves nothing open.
    await turnOff(id);
    await settled(log);
  });

  test("it snoozes when idle and the next placeholder takes its conversation up again", async () => {
    process.env.AGENT_SINGLE_AGENT = "true";
    process.env.AGENT_WAIT_MS = "50";
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }), { keeps: true });
    const id = fresh("One <!-- gen:abc -->.\n");
    const s = stream(id);
    try {
      await s.until("snooze");
      expect(log.open).toBe(0); // it is closed, its conversation on disk
      expect(solo(id)).toMatchObject({ session: "s1" });
      writeFileSync(page(id), readFileSync(page(id), "utf8").replace("One", "Two <!-- gen:def -->. One"));
      await s.until("end", 2);
      expect(log.starts.length).toBe(2);
      expect(log.starts[1]!.resume).toBe("s1"); // the same conversation, not a fresh agent
      expect(solo(id)).toMatchObject({ session: "s1" });
      expect(log.prompts[1]).toContain("<page-file"); // its first turn since: told the page afresh
    } finally { s.stop(); }
    await settled(log);
  });

  test("with an engine that keeps no conversation, each run gets its own agent as usual", async () => {
    process.env.AGENT_SINGLE_AGENT = "true";
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }));
    const id = fresh("One <!-- gen:abc -->. Two <!-- gen:def -->.\n");
    const s = stream(id);
    try {
      await s.until("end", 2);
      expect(log.starts.length).toBe(2);
      expect(solo(id)).toBeUndefined();
    } finally { s.stop(); }
    await settled(log);
  });
});

describe("every agent the loop starts is closed", () => {
  test("after a run that worked, one that failed, and one whose agent died", async () => {
    let i = 0;
    const log = fakeEngine(() => (i++ === 0 ? { ok: false, result: "", error: "boom" } : { ok: true, result: asText({ kind: "decline", note: "no" }) }));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("end", 2);
      expect(s.events("end").map((e) => e.ok)).toEqual([false, true]);
      await settled(log);
      expect(log.closed).toBe(2);
    } finally { s.stop(); }

    const dying = fakeEngine(() => ({ ok: true, result: "" }), { dies: true });
    const id2 = fresh("Plan: <!-- gen:abc --> end.\n");
    const s2 = stream(id2);
    try {
      await s2.until("end");
      expect(s2.events("end")[0]).toMatchObject({ ok: false, error: "it died" });
      await until(() => body(id2) === "Plan: <!-- gen:abc --> end.", `not waiting again: ${body(id2)}`);
    } finally { s2.stop(); }
    await settled(dying);
  });

  test("after a run that timed out", async () => {
    process.env.AGENT_RUN_TIMEOUT_MS = "100";
    const log = fakeEngine(() => new Promise<RunResult>(() => {}));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    try {
      await s.until("end");
      expect(s.events("end")[0]).toMatchObject({ ok: false, error: expect.stringContaining("Timed out") });
      await settled(log);
    } finally { s.stop(); }
  });

  test("when the agents are turned off mid-run, and with agents waiting: none left open, the run's ack reset", async () => {
    process.env.AGENT_WAIT_MS = "60000";
    let release: (r: RunResult) => void = () => {};
    let i = 0;
    const log = fakeEngine(() => (i++ === 0 ? { ok: true, result: asText({ kind: "decline", note: "no" }) } : new Promise<RunResult>((r) => { release = r; })), { keeps: true });
    const id = fresh("A <!-- gen:abc --> and B.\n");
    const s = stream(id);
    try {
      await s.until("wait");
      writeFileSync(page(id), readFileSync(page(id), "utf8").replace("B.", "B <!-- gen:def -->."));
      await s.until("start", 2);
      for (const t = Date.now(); !body(id).includes("gen:def:ack"); await wait(10)) if (Date.now() - t > 2000) throw new Error("no ack");
      await turnOff(id);
    } finally { s.stop(); }
    await settled(log);
    release({ ok: true, result: "" });
    for (const t = Date.now(); body(id).includes(":ack"); await wait(10)) if (Date.now() - t > 2000) throw new Error(`ack left: ${body(id)}`);
    expect(body(id)).toContain("<!-- gen:def -->");
    expect(openAgents()).not.toContain(id);
  });
});

test("an agent whose close hangs doesn't keep its placeholder spinning: the ack is reset when the agents are turned off", async () => {
  const log = fakeEngine(() => new Promise<RunResult>(() => {}));
  // Its agents never finish closing (a model call that ignores the abort).
  const start = log.starts;
  const engine = setEngines(null)!.at(0)!;
  setEngines([{ ...engine, start: async (o) => ({ ...(await engine.start(o)), close: () => new Promise<void>(() => {}) }) }]);
  const id = fresh("Plan: <!-- gen:abc --> end.\n");
  const s = stream(id);
  try {
    await s.until("start");
    await until(() => body(id).includes("gen:abc:ack"), "no ack");
    await turnOff(id);
  } finally { s.stop(); }
  await until(() => body(id) === "Plan: <!-- gen:abc --> end.", `still acknowledged: ${body(id)}`);
  expect(start).toHaveLength(1);
});

test("the agents' scratch folder is gone once they stop, even when an agent's close hangs,", async () => {
  const log = fakeEngine(() => new Promise<RunResult>(() => {}));
  const engine = setEngines(null)!.at(0)!;
  setEngines([{ ...engine, start: async (o) => ({ ...(await engine.start(o)), close: () => new Promise<void>(() => {}) }) }]);
  const id = fresh("Plan: <!-- gen:abc --> end.\n");
  const s = stream(id);
  try {
    await s.until("start");
    const scratch = log.starts[0]!.scratch;
    expect(existsSync(scratch)).toBe(true);
  } finally { s.stop(); }
  await stopAllPages("test over");
  expect(existsSync(log.starts[0]!.scratch)).toBe(false);
});

test("AGENT_MAX_RUNS holds across pages: a page waits, saying so, until another page's run ends", async () => {
  process.env.AGENT_MAX_RUNS = "1";
  const releases: ((r: RunResult) => void)[] = [];
  const log = fakeEngine(() => new Promise<RunResult>((r) => { releases.push(r); }));
  const one = fresh("One <!-- gen:abc --> here.\n");
  const a = stream(one);
  try {
    await a.until("start");
    const two = fresh("Two <!-- gen:abc --> here.\n");
    const b = stream(two);
    try {
      await b.until("skip");
      expect(b.events("skip").at(-1)).toMatchObject({ reason: "busy" });
      expect(b.count("start")).toBe(0);
      releases[0]!({ ok: true, result: asText({ kind: "decline", note: "no" }) });
      await b.until("start");
      expect(log.starts).toHaveLength(2);
      releases[1]!({ ok: true, result: asText({ kind: "decline", note: "no" }) });
      await b.until("end");
    } finally { b.stop(); }
  } finally { a.stop(); }
  await settled(log);
});

describe("kept agents and scheduling", () => {
  test("past AGENT_MAX_WAITING, the one waiting longest snoozes", async () => {
    process.env.AGENT_WAIT_MS = "60000";
    process.env.AGENT_MAX_WAITING = "1";
    process.env.AGENT_CONCURRENCY = "1";
    const log = fakeEngine(replying({ kind: "decline", note: "no" }), { keeps: true });
    const id = fresh("A <!-- gen:abc --> and B <!-- gen:def -->.\n");
    const s = stream(id);
    try {
      await s.until("wait", 2);
      await s.until("snooze");
      expect(s.events("snooze")[0]).toMatchObject({ task: "abc" });
      expect(log.open).toBe(1);
      await turnOff(id);
    } finally { s.stop(); }
    await settled(log);
  });

  test("once every placeholder has its suggestion, the loop sends nothing more, however long it waits", async () => {
    const log = fakeEngine(replying({ kind: "suggestion", mode: "at", place: "inline", suggestion: "x" }));
    const id = fresh("A <!-- gen:abc --> and B <!-- gen:def -->.\n");
    const s = stream(id);
    try {
      await s.until("end", 2);
      await s.drain(300);
      expect(s.count("start")).toBe(2);
      expect(log.prompts).toHaveLength(2);
    } finally { s.stop(); }
    await settled(log);
  });
});

test("the loop's view of a page is parsed again only when the file changes", async () => {
  const { pageView } = await import("../src/server/agent/page");
  const id = fresh("A <!-- gen:abc --> here.\n");
  const first = pageView(id);
  expect(pageView(id)).toBe(first);
  expect(first.pending.map((t) => t.id)).toEqual(["abc"]);
  writeFileSync(page(id), "A <!-- gen:abc --> and <!-- gen:def --> here.\n");
  const next = pageView(id);
  expect(next).not.toBe(first);
  expect(next.pending.map((t) => t.id)).toEqual(["abc", "def"]);
});

describe("the page's agents outlive its tab", () => {
  test("closing the tab mid-run: the run finishes and its suggestion lands, then the agents stop, nothing left to do", async () => {
    let release: (r: RunResult) => void = () => {};
    const log = fakeEngine(() => new Promise<RunResult>((r) => { release = r; }));
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    await s.until("start");
    s.stop();
    await wait(100);
    expect(openAgents()).toContain(id);
    expect(log.open).toBe(1);
    release({ ok: true, result: asText({ kind: "suggestion", mode: "at", place: "inline", suggestion: "done unseen" }) });
    await until(() => record(id)?.suggestion === "done unseen", "no suggestion");
    await until(() => !openAgents().includes(id), "the agents never stopped");
    await settled(log);
  });

  test("a tab that opens mid-run is told the run's start and steps first, then follows it live", async () => {
    let release: (r: RunResult) => void = () => {};
    let step: (s: { kind: "tool"; text: string }) => void = () => {};
    const log = fakeEngine(() => new Promise<RunResult>((r) => { release = r; }));
    const engine = setEngines(null)!.at(0)!;
    setEngines([{ ...engine, start: async (o) => { step = (s) => o.onStep(s); return engine.start(o); } }]);
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const first = stream(id);
    await first.until("start");
    step({ kind: "tool", text: "read the page" });
    first.stop();
    const second = stream(id);
    try {
      await second.until("step");
      expect(second.text.indexOf("event: hello")).toBeLessThan(second.text.indexOf("event: start"));
      expect(second.events("start")[0]).toMatchObject({ run: 1, task: "abc" });
      expect(second.events("step")[0]).toMatchObject({ run: 1, text: "read the page" });
      step({ kind: "tool", text: "thinking it over" });
      await second.until("step", 2);
      release({ ok: true, result: asText({ kind: "decline", note: "no" }) });
      await second.until("end");
    } finally { second.stop(); }
    await settled(log);
  });

  test("a kept agent outlives its tab, waits, says when it finished, snoozes; then the agents stop", async () => {
    process.env.AGENT_WAIT_MS = "200";
    const log = fakeEngine(replying({ kind: "decline", note: "no" }), { keeps: true });
    const id = fresh("Plan: <!-- gen:abc --> end.\n");
    const s = stream(id);
    await s.until("wait");
    const waitEvent = s.events("wait")[0];
    expect(waitEvent.finishedAt).toBeGreaterThan(Date.now() - 5000);
    s.stop();
    expect(openAgents()).toContain(id);
    await until(() => log.open === 0, "the agent never snoozed");
    await until(() => !openAgents().includes(id), "the agents never stopped");
    // A tab opening now hears the agent is snoozed, and when it finished.
    const again = stream(id);
    try {
      await again.until("hello");
      const hello = again.events("hello")[0];
      expect(hello.agents).toEqual({ abc: "snoozed" });
      expect(hello.finished.abc).toBe(Date.parse(record(id).finished!));
      // And which Solipsist serves it, for the status bar.
      const { versionInfo, versionLine } = await import("../src/server/version");
      expect([hello.version, hello.build]).toEqual([versionInfo().version, versionLine()]);
    } finally { again.stop(); }
  });

  test("AGENT_COST_LIMIT_USD: once reached, no new run starts anywhere, and the page says why", async () => {
    process.env.AGENT_COST_LIMIT_USD = "0.01";
    const log = fakeEngine(() => ({ ok: true, result: asText({ kind: "decline", note: "no" }), costUsd: 0.02 }));
    const id = fresh("One <!-- gen:abc --> here.\n");
    const s = stream(id);
    try {
      await s.until("end");
      writeFileSync(page(id), "One <!-- gen:abc:sug --> here, two <!-- gen:def --> there.\n" + readFileSync(page(id), "utf8").slice(readFileSync(page(id), "utf8").indexOf("<!-- solip-comments")));
      await s.until("skip");
      await until(() => s.events("skip").some((e) => e.reason === "cost"), `no cost skip in ${s.text}`);
      await s.drain(300);
      expect(s.count("start")).toBe(1);
      expect(body(id)).toContain("<!-- gen:def -->");
    } finally { s.stop(); }
    await settled(log);
  });
});
