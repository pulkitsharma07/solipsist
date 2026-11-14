// `runOnce` (`src/server/agent/runOnce.ts`): one run on one agent, the part that is the same whoever asked for it.
// `PageAgents.launch` is its only caller today, and `agent-contract.test.ts` covers it through the page's loop; what is
// tested here is the seam itself, so the next caller (work triggered by something other than a marker) inherits the
// same promises rather than rediscovering them.
//
// The tests say what a caller may rely on — which phases it is told, when it gets the agent back, how a failure is
// reported, and what the budget is told — and not how any of it is arranged inside.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEngine, AgentSession, RunResult, StartOptions } from "../src/server/agent/engine";
import { runOnce, type RunPhase, type RunRequest } from "../src/server/agent/runOnce";
import { counters, unmeteredRuns } from "../src/server/agent/budget";
import { resetRuntime } from "../src/server/runtime";

const ENV = ["AGENT_COST_LIMIT_USD", "AGENT_COST_LIMIT_DAY_USD", "AGENT_COST_LIMIT_MONTH_USD", "AGENT_MAX_UNMETERED_RUNS_DAY", "SOLIPSIST_LOG"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "run-once-"));
  resetRuntime();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  resetRuntime();
});

/** An engine whose one agent answers with `answer`. `keeps`: its agents keep a conversation, so one may be handed back. */
function fakeEngine(answer: (prompt: string) => RunResult | Promise<RunResult>, o: { keeps?: boolean; failsToStart?: string; reportsCost?: boolean } = {}) {
  const log = { starts: [] as StartOptions[], prompts: [] as string[], open: 0, closed: 0 };
  /** Resolves the agent's `died`, for a run whose agent dies under it. */
  let die: (why: string) => void = () => {};
  const engine: AgentEngine = {
    name: "fake", title: "Fake", chats: o.keeps, reportsCost: o.reportsCost ?? true, confined: true,
    models: () => [{ id: "m", title: "M" }], unavailable: () => null,
    async start(opts): Promise<AgentSession> {
      if (o.failsToStart) throw new Error(o.failsToStart);
      log.starts.push(opts);
      log.open++;
      let closed = false;
      const died = new Promise<string>((r) => { die = r; });
      return {
        ...(o.keeps && { sessionId: opts.resume ?? "s1", resumed: !!opts.resume }),
        died,
        async run(prompt) { log.prompts.push(prompt); return answer(prompt); },
        async close() { if (!closed) { closed = true; log.open--; log.closed++; } },
      };
    },
  };
  return { engine, log, die: (why: string) => die(why) };
}

/** A request with everything a run needs, and the phases it was told. `over` replaces any of it. */
function request(engine: AgentEngine, over: Partial<RunRequest> = {}) {
  const images = join(dir, "images", "pg");
  const phases: RunPhase["at"][] = [];
  const steps: string[] = [];
  const req: RunRequest = {
    id: "pg",
    choice: { engine, model: "m" },
    prompt: () => "Do the task.",
    workspace: () => ({ file: join(dir, "pg.md"), images, root: dir, scratch: join(dir, "scratch") }),
    timeoutMs: 30_000,
    onStep: (s) => steps.push(s.kind),
    onPhase: (p) => void phases.push(p.at),
    stopped: () => false,
    ...over,
  };
  mkdirSync(join(dir, "scratch"), { recursive: true });
  return { req, phases, steps, images };
}

const ok = (result = "done", costUsd?: number): RunResult => ({ ok: true, result, ...(costUsd !== undefined && { costUsd }) });

test("a run that works on an agent that keeps its conversation hands the agent back, and is never dropped", async () => {
  const f = fakeEngine(() => ok("done", 0.01), { keeps: true });
  const { req, phases } = request(f.engine);
  const report = await runOnce(req);
  expect(report.res).toMatchObject({ ok: true, result: "done" });
  // Handed back, so the caller may keep it waiting for the writer's next word.
  expect(report.session).toBeDefined();
  expect(report.session!.sessionId).toBe("s1");
  expect(report.aborted).toBeUndefined();
  expect(phases).toEqual(["starting", "started"]);
  expect(f.log.open).toBe(1); // left open for the caller, which owns it from here
});

test("an agent that keeps no conversation is dropped even when its run works: there is nothing to come back to", async () => {
  const f = fakeEngine(() => ok(), { keeps: false });
  const { req, phases } = request(f.engine);
  const report = await runOnce(req);
  expect(report.res.ok).toBe(true);
  expect(report.session).toBeUndefined();
  expect(phases).toEqual(["starting", "started", "dropped"]);
});

test("a run that fails drops its agent, whatever the engine keeps", async () => {
  const f = fakeEngine(() => ({ ok: false, result: "", error: "the model refused" }), { keeps: true });
  const { req, phases } = request(f.engine);
  const report = await runOnce(req);
  expect(report.res).toMatchObject({ ok: false, error: "the model refused" });
  expect(report.session).toBeUndefined();
  expect(phases).toEqual(["starting", "started", "dropped"]);
});

test("an agent handed in is reused: no agent is started, and the caller hears `reuse`", async () => {
  const f = fakeEngine(() => ok("again", 0), { keeps: true });
  const first = await runOnce(request(f.engine).req);
  const reuse = first.session!;
  const { req, phases } = request(f.engine, { reuse });
  const report = await runOnce(req);
  expect(report.res.result).toBe("again");
  expect(phases).toEqual(["reuse"]);
  expect(f.log.starts).toHaveLength(1); // the first run's; this one started none
});

test("a conversation on disk is taken up again: the engine is asked to resume it", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  const { req } = request(f.engine, { resume: "earlier-session" });
  const report = await runOnce(req);
  expect(f.log.starts[0]!.resume).toBe("earlier-session");
  expect(report.session!.resumed).toBe(true);
});

test("given up on while the agent was starting: the agent is closed, nothing is run, and the caller is told to stop", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  let prompts = 0;
  // Stopped from the moment the agent is up — the caller turned the page's agents off while it was starting.
  const { req, phases } = request(f.engine, {
    stopped: () => f.log.starts.length > 0,
    prompt: () => { prompts++; return "Do the task."; },
  });
  const report = await runOnce(req);
  expect(report.aborted).toBe(true);
  expect(report.res.ok).toBe(false);
  // Closed here, since the caller never heard of it: an abandoned agent would go on holding a process.
  expect(f.log.open).toBe(0);
  expect(f.log.closed).toBe(1);
  expect(report.session).toBeUndefined();
  // No prompt was built and no run was sent, so nothing was spent and nothing is owed to the budget.
  expect(prompts).toBe(0);
  expect(f.log.prompts).toEqual([]);
  expect(counters().day.spent).toBe(0);
  expect(unmeteredRuns()).toBe(0);
  // It never got as far as being dropped: there was nothing the caller had been given to drop.
  expect(phases).toEqual(["starting", "started"]);
});

test("an engine that can't start an agent fails the run, saying why, and leaves nothing open", async () => {
  const f = fakeEngine(() => ok(), { keeps: true, failsToStart: "no key for this engine" });
  const { req, phases } = request(f.engine);
  const report = await runOnce(req);
  expect(report.res.ok).toBe(false);
  expect(report.res.error).toContain("no key for this engine");
  expect(report.session).toBeUndefined();
  expect(f.log.open).toBe(0);
  // Nothing was ever handed to the caller, so there is nothing for it to drop.
  expect(phases).toEqual(["starting"]);
});

test("an agent that dies under its run ends it with what went wrong", async () => {
  const f = fakeEngine(() => new Promise<RunResult>(() => {}), { keeps: true });
  const { req } = request(f.engine);
  const running = runOnce(req);
  // Once the run is in flight, the agent dies of its own accord.
  while (!f.log.prompts.length) await new Promise((r) => setTimeout(r, 5));
  f.die("the process stopped");
  const report = await running;
  expect(report.res).toMatchObject({ ok: false, error: "the process stopped" });
  expect(report.session).toBeUndefined();
});

test("a run that takes longer than it is given is stopped and counted as failed, saying how long it had", async () => {
  const f = fakeEngine(() => new Promise<RunResult>(() => {}), { keeps: true });
  const { req } = request(f.engine, { timeoutMs: 30 });
  const report = await runOnce(req);
  expect(report.res.ok).toBe(false);
  expect(report.res.error).toContain("Timed out after");
  expect(report.session).toBeUndefined();
});

test("a run that says what it cost goes to the dollar limits; one that says nothing is counted instead", async () => {
  const metered = fakeEngine(() => ok("done", 0.25), { keeps: true });
  await runOnce(request(metered.engine).req);
  expect(counters().day.spent).toBeCloseTo(0.25, 6);
  expect(unmeteredRuns()).toBe(0);

  // The same run from an engine that reports nothing: no figure can cover it, so it is counted (`agent/budget.ts`).
  const silent = fakeEngine(() => ok("done"), { keeps: true, reportsCost: false });
  const report = await runOnce(request(silent.engine).req);
  expect(report.costUnknown).toBe(true);
  expect(counters().day.spent).toBeCloseTo(0.25, 6); // unchanged
  expect(unmeteredRuns()).toBe(1);
});

test("a cost that is nonsense is treated as no cost at all, not as nothing spent", async () => {
  const f = fakeEngine(() => ({ ok: true, result: "done", costUsd: Number.NaN }), { keeps: true });
  const report = await runOnce(request(f.engine).req);
  // Nobody knows what it cost, so it is counted rather than passed over: `spend` could do nothing with it.
  expect(report.costUnknown).toBe(true);
  expect(unmeteredRuns()).toBe(1);
  expect(counters().day.spent).toBe(0);
});

test("the run's check reaches the engine, so a reply that can't be used is caught while the agent can still fix it", async () => {
  let given: unknown;
  const f = fakeEngine(() => ok(), { keeps: true });
  const engine: AgentEngine = { ...f.engine, async start(o) { const a = await f.engine.start(o); return { ...a, async run(p, opts) { given = opts?.check; return a.run(p, opts); } }; } };
  const check = () => "that block isn't in the page";
  await runOnce(request(engine, { check }).req);
  expect(given).toBe(check);
});

test("a phase the caller handles without pausing costs the run no pause: the prompt goes as soon as the agent is up", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  let sentByThen: boolean | undefined;
  const { req } = request(f.engine, {
    onPhase: (p) => {
      if (p.at !== "started") return;
      // Anything queued here must find the prompt already sent. While the run awaited every phase, work could land
      // in this gap — one page's run saw another's agent started but not yet working, and took its slot.
      void Promise.resolve().then(() => { sentByThen = f.log.prompts.length > 0; });
    },
  });
  await runOnce(req);
  expect(sentByThen).toBe(true);
});

test("the one phase the run does wait on is `starting`, so an agent being closed in its place is gone first", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  const order: string[] = [];
  const { req } = request(f.engine, {
    onPhase: (p) => {
      if (p.at !== "starting") { order.push(p.at); return; }
      // The caller asks to be waited for by handing back a promise; until it settles, no agent is started.
      return new Promise<void>((r) => setTimeout(() => { order.push("freed"); r(); }, 20));
    },
  });
  await runOnce(req);
  expect(order[0]).toBe("freed");
  expect(order[1]).toBe("started");
});

test("the image folder is made before the agent starts, since the agent may write in it but not create it", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  const { req, images } = request(f.engine);
  let existedAtStart = false;
  const engine: AgentEngine = { ...f.engine, async start(o) { existedAtStart = existsSync(images); return f.engine.start(o); } };
  await runOnce({ ...req, choice: { engine, model: "m" } });
  expect(existedAtStart).toBe(true);
});

test("the workspace and the prompt are only asked for when they are needed: a reused agent needs neither folder nor page", async () => {
  const f = fakeEngine(() => ok(), { keeps: true });
  const first = await runOnce(request(f.engine).req);
  let asked = 0;
  const { req } = request(f.engine, { reuse: first.session!, workspace: () => { asked++; throw new Error("the workspace was built for a reused agent"); } });
  const report = await runOnce(req);
  // A scratch folder made for an agent that is already running would be left behind for nothing.
  expect(asked).toBe(0);
  expect(report.res.ok).toBe(true);
});
