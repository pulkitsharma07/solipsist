// A reading is a job of the page's agents, not a thing of its own. What that has to
// mean, and what this pins: the writer watches it on the page's stream step by step; it takes a run slot and says so
// when there is none; one at a time per page; and stopping the page's agents stops it. Before this it ran straight
// off the route, so its steps went nowhere and nothing could stop it.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/plugins";
import { resetRuntime } from "../src/server/runtime";
import { stopAllPages, pageAgents, REVIEW } from "../src/server/agent/pageAgents";
import { setEngines } from "../src/server/agent/engines";
import { callReplyTool, REVIEW_TOOLS } from "../src/server/agent/replyTools";
import type { AgentEngine, AgentSession, RunOptions, RunResult } from "../src/server/agent/engine";
import type { AnyReply } from "../src/server/suggest";
import { emptyBlock, serializeFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-review-loop-");
afterAll(() => P.done());
const docs = P.docs;
mkdirSync(docs, { recursive: true });

const ENV = ["AGENT_SETTLE_MS", "AGENT_GAP_MS", "AGENT_CONCURRENCY", "SOLIPSIST_PREFERRED_MODELS"];
let saved: Record<string, string | undefined> = {};
let oldEngines: AgentEngine[] | null | undefined;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  P.enter();
  process.env.AGENT_SETTLE_MS = "20";
  process.env.AGENT_GAP_MS = "20";
  process.env.SOLIPSIST_PREFERRED_MODELS = "fake:m";
});
afterEach(async () => {
  await stopAllPages("test over");
  resetRuntime();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  if (oldEngines !== undefined) setEngines(oldEngines);
  oldEngines = undefined;
});

const PAGE = "# Notes\n\nThe deadline is the end of Q3 for all teams.\n";
const page = (id: string) => { writeFileSync(join(docs, `${id}.md`), serializeFile(PAGE, emptyBlock())); return id; };

const GOOD = {
  quote: "The deadline is the end of Q3 for all teams.",
  title: "Fiscal or calendar: which Q3 is this?",
  gloss: "which Q3?",
  description: "Both teams read this and they keep different calendars.",
  score: 8,
};

/** A fake engine whose run reports two steps before it answers, so there is progress to watch. */
function fakeReader(o: { hang?: boolean } = {}) {
  const tool = REVIEW_TOOLS.find((t) => t.name === "comment")!;
  const log = { open: 0, runs: 0 };
  let release: (() => void) | undefined;
  const engine: AgentEngine = {
    name: "fake", title: "Fake", models: () => [{ id: "m", title: "M" }], unavailable: () => null, replyTools: true,
    async start(opts): Promise<AgentSession> {
      log.open++;
      return {
        died: new Promise<string>(() => {}),
        async run(_prompt: string, runOpts?: RunOptions): Promise<RunResult> {
          log.runs++;
          opts.onStep({ kind: "tool", text: "Read the page", name: "read" });
          opts.onStep({ kind: "text", text: "Looking at the Q3 claim" });
          if (o.hang) await new Promise<void>((r) => { release = r; });
          const r = callReplyTool(tool, { comments: [GOOD] }, runOpts?.check as ((x: AnyReply) => string | null) | undefined);
          return "reply" in r ? { ok: true, result: "", reply: r.reply, costUsd: 0.001 } : { ok: false, result: "", error: r.error };
        },
        async close() { log.open--; },
      };
    },
  };
  const before = setEngines([engine]);
  if (oldEngines === undefined) oldEngines = before;
  return { log, go: () => release?.() };
}

/** The page's agent stream, read as text, with a wait for the nth event of a kind. */
async function stream(id: string) {
  const { agentStream } = await import("../src/server/agent");
  const ac = new AbortController();
  const req = Object.assign(new Request("http://x/?model=fake:m", { signal: ac.signal }), { params: { id } });
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

describe("a review on the page's agents", () => {
  test("the writer watches it on the page's stream, step by step", async () => {
    const id = page("a");
    fakeReader();
    const s = await stream(id);
    await s.until("hello");

    const out = await pageAgents(id)!.read();
    expect(out.error).toBeUndefined();
    expect(out.placed).toHaveLength(1);

    await s.until("end");
    // The run is announced, its steps arrive as it works, and it is named a review rather than a task.
    expect(s.text).toContain(`"task":"${REVIEW}"`);
    expect(s.text).toContain("Read the page");
    expect(s.text).toContain("Looking at the Q3 claim");
    expect(s.count("start")).toBeGreaterThanOrEqual(1);
    expect(s.text).toContain('"outcome":"read"');
    expect(s.text).toContain("1 question(s) in the margin");
    s.stop();
  });

  test("its agent is closed, and it keeps no conversation", async () => {
    const id = page("b");
    const { log } = fakeReader();
    const s = await stream(id);
    await s.until("hello");

    await pageAgents(id)!.read();
    await pageAgents(id)!.read();
    expect(log.runs).toBe(2);
    expect(log.open).toBe(0); // a fresh agent each time, and none left behind
    s.stop();
  });

  test("one at a time: a second asks the writer to wait", async () => {
    const id = page("c");
    const { go } = fakeReader({ hang: true });
    const s = await stream(id);
    await s.until("hello");

    const first = pageAgents(id)!.read();
    const second = await pageAgents(id)!.read();
    expect(second.error).toContain("being read already");
    expect(second.placed).toHaveLength(0);

    go();
    expect((await first).placed).toHaveLength(1);
    s.stop();
  });

  test("it takes a run slot: a review waits while the page's one run is working", async () => {
    const id = "d";
    // A pending request, so the loop starts a run of its own and fills the page's only slot.
    writeFileSync(join(docs, "d.md"), serializeFile("# Notes\n\nThe deadline is <!-- gen:abc --> for all teams.\n", emptyBlock()));
    process.env.AGENT_CONCURRENCY = "1";
    const { go } = fakeReader({ hang: true });
    const s = await stream(id);
    await s.until("start"); // the task's run is in flight and holding the slot

    const out = await pageAgents(id)!.read();
    expect(out.error).toContain("busy");
    expect(out.placed).toHaveLength(0);

    go();
    s.stop();
  });

  test("stopping the page's agents stops the review", async () => {
    const id = page("e");
    const { go } = fakeReader({ hang: true });
    const s = await stream(id);
    await s.until("hello");

    const reading = pageAgents(id)!.read();
    const stopping = pageAgents(id)!.stop("the writer stopped the agents");
    go();
    await stopping;
    const out = await reading;
    // Nothing was placed, and the run did not come back claiming success.
    expect(out.placed).toHaveLength(0);
    s.stop();
  });

  test("a page nobody has open is read by an agent of its own", async () => {
    const id = page("f");
    fakeReader();
    expect(pageAgents(id)).toBeUndefined(); // no stream, so no page agents to hand it to

    const { reviewPage } = await import("../src/server/review");
    const out = await reviewPage(id);
    expect(out.error).toBeUndefined();
    expect(out.placed).toHaveLength(1);
  });
});
