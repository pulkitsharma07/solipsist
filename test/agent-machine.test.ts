// The agent states of one page's tasks (`src/server/agent/agentMachine.ts`): every state × every event × (single-agent
// mode or not), for one task, then the stories that span tasks (the page's one agent, the cap on waiting agents).
// The table below is the spec: each row says, for one event, what the task's next state is and what happens. A change
// to the machine that isn't also made here fails.
import { describe, expect, test } from "bun:test";
import type { TaskAgent } from "../src/shared/docfile";
import type { AgentSession } from "../src/server/agent/engine";
import {
  PENDING, ready, soloHolder, step, type AgentState, type Config, type Effect, type Event, type Gate, type Kept, type RunLog, type Solo, type Tasks,
} from "../src/server/agent/agentMachine";

/** Sessions are opaque to the machine: named objects, compared by identity. */
const session = (name: string) => ({ name }) as unknown as AgentSession;
const S1 = session("kept"), S2 = session("run's"), S3 = session("chat's"), SN = session("started");
const R1: TaskAgent = { engine: "e", model: "m", session: "x1" };
const R2: TaskAgent = { engine: "e", model: "m", session: "x2" };
const R3: TaskAgent = { engine: "f", model: "n", session: "x3" };
const SOLO: Solo = { told: ["gen"], turns: 2 };
const G: Gate = { until: 0, hash: 7 };
const RL: RunLog = { n: 5, taskType: "gen", model: "e:m", startedAt: 100, said: [] };
const K: Kept = { session: S1, ref: R1, run: 4, until: 900, finishedAt: 400, order: 1 };
const KS: Kept = { ...K, solo: SOLO };
const AT = 1000;
const c = (single: boolean): Config => ({ single, waitMs: 500, maxWaiting: 3, gapMs: 50 });
const CONFIGS = [c(false), c(true)];

/** One of each shape of state a task can be in. */
const STATES: Record<string, AgentState> = {
  pending: PENDING,
  held: { s: "held", gate: G },
  snoozed: { s: "snoozed" },
  "snoozed, gated": { s: "snoozed", gate: G },
  waiting: { s: "waiting", kept: K },
  "waiting, gated": { s: "waiting", gate: G, kept: K },
  "waiting, the page's one": { s: "waiting", gate: G, kept: KS },
  acking: { s: "acking", run: RL },
  "acking, gated, an agent kept": { s: "acking", run: RL, gate: G, kept: K },
  "acking, the page's one kept": { s: "acking", run: RL, kept: KS },
  running: { s: "running", run: RL },
  "running, taken up": { s: "running", run: RL, taken: K },
  "running, the page's one taken up": { s: "running", run: RL, taken: KS },
  "running, an agent": { s: "running", run: RL, session: S2 },
  "running, the page's one": { s: "running", run: RL, session: S1, ref: R1, solo: SOLO },
  "running, dropped": { s: "running", run: RL, session: S2, dropped: true },
  chatting: { s: "chatting" },
  "chatting, gated": { s: "chatting", gate: G },
};

const T = "t";
const EVENTS: Event[] = [
  { type: "launch", task: T, run: RL },
  { type: "ackFailed", task: T, at: AT },
  { type: "ackNothing", task: T },
  { type: "runStart", task: T },
  { type: "choose", task: T, reuse: true },
  { type: "choose", task: T, reuse: false },
  { type: "started", task: T, session: SN },
  { type: "drop", task: T },
  { type: "runEnd", task: T, at: AT, outcome: "suggested", ref: R2, solo: { told: ["gen", "sel"], turns: 3 } },
  { type: "runEnd", task: T, at: AT, outcome: "done", ref: R2, solo: { told: ["gen"], turns: 1 } },
  { type: "runEnd", task: T, at: AT, outcome: "failed", solo: { told: [], turns: 1 } },
  { type: "release", task: T, gate: { until: 0, hash: 9 } },
  { type: "crash", task: T, at: AT },
  { type: "snooze", task: T },
  { type: "seen", ids: new Set([T]) },
  { type: "seen", ids: new Set() },
  { type: "chatOpen", task: T },
  { type: "chatOpen", task: T, recorded: "x1" },
  { type: "chatClose", task: T, at: AT, agent: { session: S3, ref: R3 }, finishedAt: 300 },
  { type: "chatClose", task: T, at: AT, finishedAt: 0 },
  { type: "stop" },
];

type Expected = { reject: string } | { state: AgentState | null; effects?: Effect[] };
const same = (a: AgentState): Expected => ({ state: a });
const isRun = (a: AgentState) => a.s === "acking" || a.s === "running";
const keptOf = (a: AgentState) => (a.s === "waiting" || a.s === "acking" ? a.kept : undefined);
const gateOf = (a: AgentState) => ("gate" in a ? a.gate : undefined);
const withGate = (g: Gate | undefined) => (g ? { gate: g } : {});
const idle = (g: Gate | undefined): AgentState => (g ? { s: "held", gate: g } : PENDING);
const snoozeFx = (k: Kept): Effect[] => [
  { type: "clearTimer", task: T },
  { type: "snooze", session: k.session, data: { run: k.run, task: T, finishedAt: k.finishedAt, engine: k.ref.engine } },
];
/** What snoozing the task's kept agent does, as the timer, `seen` and a chat given back do it. */
function snoozed(a: AgentState): Expected {
  const k = keptOf(a);
  if (!k) return same(a);
  if (a.s === "acking") return { state: { s: "acking", run: a.run, ...withGate(a.gate) }, effects: snoozeFx(k) };
  return { state: { s: "snoozed", ...withGate(gateOf(a)) }, effects: snoozeFx(k) };
}
const keptFx = (k: { run: number; ref: TaskAgent; finishedAt: number }): Effect[] => [
  { type: "setTimer", task: T, ms: 500 },
  { type: "say", event: "wait", data: { run: k.run, task: T, until: AT + 500, engine: k.ref.engine, finishedAt: k.finishedAt } },
];

/** The spec, row by row. */
function expected(a: AgentState, cfg: Config, e: Event): Expected {
  switch (e.type) {
    case "launch":
      if (isRun(a) || a.s === "chatting") return { reject: "busy" };
      return { state: { s: "acking", run: RL, ...withGate(gateOf(a)), ...(keptOf(a) && { kept: keptOf(a) }) } };

    case "ackFailed":
    case "ackNothing": {
      if (a.s !== "acking") return { reject: "not acknowledging" };
      const g = e.type === "ackFailed" ? { until: AT + 50 } : a.gate;
      return { state: a.kept ? { s: "waiting", ...withGate(g), kept: a.kept } : idle(g) };
    }

    case "runStart": {
      if (a.s !== "acking") return { reject: "not acknowledging" };
      if (!a.kept) return { state: { s: "running", run: RL } };
      // Single-agent mode takes only the page's one agent; an agent of the task's own that isn't it snoozes.
      if (cfg.single && !a.kept.solo) return { state: { s: "running", run: RL }, effects: snoozeFx(a.kept) };
      return { state: { s: "running", run: RL, taken: a.kept }, effects: [{ type: "clearTimer", task: T }] };
    }

    case "choose": {
      if (a.s !== "running" || a.session) return { reject: "nothing to choose" };
      if (e.reuse) {
        if (!a.taken) return { reject: "nothing taken" };
        return { state: { s: "running", run: RL, session: a.taken.session, ref: a.taken.ref, ...(a.taken.solo && { solo: a.taken.solo }) } };
      }
      return { state: { s: "running", run: RL }, effects: a.taken ? [{ type: "close", session: a.taken.session }] : [] };
    }

    case "started":
      if (a.s !== "running" || a.session || a.taken) return { reject: "not starting" };
      return { state: { ...a, session: SN } };

    case "drop":
      if (a.s !== "running") return { reject: "no run" };
      return { state: { ...a, solo: undefined, dropped: true }, effects: a.session && !a.dropped ? [{ type: "close", session: a.session }] : [] };

    case "runEnd": {
      if (a.s !== "running") return { reject: "no run" };
      const live = a.session && !a.dropped ? a.session : undefined;
      const inf: Gate = { until: Infinity };
      if (live && e.ref && (cfg.single || e.outcome === "suggested" || e.outcome === "declined")) {
        const k: Kept = { session: live, ref: e.ref, run: 5, finishedAt: AT, until: AT + 500, order: 1, ...(cfg.single && { solo: e.solo }) };
        return { state: { s: "waiting", gate: inf, kept: k }, effects: keptFx(k) };
      }
      return { state: { s: "held", gate: inf }, effects: live ? [{ type: "close", session: live }] : [] };
    }

    case "release":
      if (isRun(a)) return { reject: "running" };
      return { state: a.s === "pending" || a.s === "held" ? { s: "held", gate: e.gate } : { ...a, gate: e.gate } };

    case "crash": {
      const g: Gate = { until: AT + 50 };
      if (a.s === "running") {
        const fx: Effect[] = [];
        if (a.taken) fx.push({ type: "close", session: a.taken.session });
        if (a.session && !a.dropped) fx.push({ type: "close", session: a.session });
        return { state: { s: "held", gate: g }, effects: fx };
      }
      if (a.s === "acking") return { state: a.kept ? { s: "waiting", gate: g, kept: a.kept } : { s: "held", gate: g } };
      return { state: a.s === "pending" || a.s === "held" ? { s: "held", gate: g } : { ...a, gate: g } };
    }

    case "snooze":
      return snoozed(a);

    case "seen": {
      const k = keptOf(a);
      // The page's one agent stays, wherever its task went.
      if (e.ids.has(T) || !k || (cfg.single && k.solo)) return same(a);
      return snoozed(a);
    }

    case "chatOpen": {
      if (a.s === "chatting") return { reject: "open already" };
      if (isRun(a)) return { state: a, effects: [{ type: "working" }] };
      const k = keptOf(a);
      const chat: AgentState = { s: "chatting", ...withGate(gateOf(a)) };
      if (!k) return { state: chat, effects: [{ type: "lend", agent: null }] };
      return { state: chat, effects: [{ type: "clearTimer", task: T }, { type: "lend", agent: { session: k.session, ref: k.ref } }] };
    }

    case "chatClose": {
      if (isRun(a)) return { reject: "running" };
      if (!e.agent) return same(a.s === "chatting" ? idle(a.gate) : a);
      const before = snoozed(a) as { state: AgentState; effects?: Effect[] };
      const k: Kept = { session: S3, ref: R3, run: 0, finishedAt: 300, until: AT + 500, order: 1, ...(cfg.single && { solo: { told: [], turns: 0 } }) };
      return { state: { s: "waiting", ...withGate(gateOf(before.state!)), kept: k }, effects: [...(before.effects ?? []), ...keptFx(k)] };
    }

    case "stop": {
      const fx: Effect[] = [];
      if (a.s === "running" && a.session) fx.push({ type: "close", session: a.session });
      const k = keptOf(a);
      if (k) fx.push({ type: "clearTimer", task: T }, { type: "close", session: k.session });
      return { state: null, effects: fx };
    }
  }
}

const label = (name: string, cfg: Config, e: Event) => `${name} ${cfg.single ? "single" : "per-task"} ${JSON.stringify(e, (_, v) => (v instanceof Set ? [...v] : v))}`;
const one = (a: AgentState): Tasks => new Map([[T, a]]);

describe("every state × event × mode", () => {
  let pairs = 0;
  for (const cfg of CONFIGS) {
    test(`${cfg.single ? "single-agent mode" : "an agent per task"}: ${Object.keys(STATES).length} states × ${EVENTS.length} events`, () => {
      for (const [name, a] of Object.entries(STATES)) {
        for (const e of EVENTS) {
          pairs++;
          const got = step(one(a), cfg, e);
          const want = expected(a, cfg, e);
          const at = label(name, cfg, e);
          if ("reject" in want) {
            expect({ at, ok: got.ok }).toEqual({ at, ok: false });
            continue;
          }
          if (!got.ok) throw new Error(`rejected (${got.reason}): ${at}`);
          expect({ at, state: got.tasks.get(T) ?? null, effects: got.effects }).toEqual({ at, state: want.state, effects: want.effects ?? [] });
        }
      }
    });
  }
  test("the table covered every pair", () => expect(pairs).toBe(CONFIGS.length * Object.keys(STATES).length * EVENTS.length));
});

describe("stories", () => {
  const run = (tasks: Tasks, cfg: Config, ...events: Event[]) => {
    const effects: Effect[][] = [];
    for (const e of events) {
      const r = step(tasks, cfg, e);
      if (!r.ok) throw new Error(`${e.type}: ${r.reason}`);
      tasks = r.tasks;
      effects.push(r.effects);
    }
    return { tasks, effects };
  };
  const single = c(true), perTask = c(false);
  const RN = (n: number): RunLog => ({ ...RL, n });

  test("a run, kept after its suggestion, snoozes when its wait is over", () => {
    const { tasks, effects } = run(new Map(), perTask,
      { type: "launch", task: "a", run: RN(1) }, { type: "runStart", task: "a" }, { type: "choose", task: "a", reuse: false }, { type: "started", task: "a", session: S2 },
      { type: "runEnd", task: "a", at: AT, outcome: "suggested", ref: R2, solo: { told: [], turns: 1 } },
      { type: "release", task: "a", gate: G }, { type: "snooze", task: "a" });
    expect(tasks.get("a")).toEqual({ s: "snoozed", gate: G });
    expect(effects.at(-1)).toEqual([{ type: "clearTimer", task: "a" }, { type: "snooze", session: S2, data: { run: 1, task: "a", finishedAt: AT, engine: "e" } }]);
  });

  test("an ask again goes on with the agent kept", () => {
    const start: Tasks = new Map([["a", { s: "waiting", gate: G, kept: K }]]);
    const { tasks } = run(start, perTask, { type: "launch", task: "a", run: RN(2) }, { type: "runStart", task: "a" }, { type: "choose", task: "a", reuse: true });
    expect(tasks.get("a")).toEqual({ s: "running", run: RN(2), session: S1, ref: R1 });
  });

  test("past maxWaiting, the one waiting longest snoozes", () => {
    const cfg = { ...perTask, maxWaiting: 1 };
    const start: Tasks = new Map<string, AgentState>([["a", { s: "waiting", kept: K }], ["b", { s: "running", run: RN(2), session: S2 }]]);
    const { tasks, effects } = run(start, cfg, { type: "runEnd", task: "b", at: AT, outcome: "declined", ref: R2, solo: { told: [], turns: 1 } });
    expect(tasks.get("a")).toEqual({ s: "snoozed" });
    expect(tasks.get("b")).toMatchObject({ s: "waiting", kept: { session: S2, order: 2 } });
    expect(effects[0]!.map((x) => x.type)).toEqual(["setTimer", "say", "clearTimer", "snooze"]);
  });

  test("a kept agent whose task left the page snoozes; in single-agent mode the page's one stays", () => {
    const start: Tasks = new Map<string, AgentState>([["a", { s: "waiting", kept: KS }], ["b", { s: "waiting", kept: { ...K, session: S2, order: 2 } }]]);
    expect(run(start, single, { type: "seen", ids: new Set() }).tasks.get("a")).toEqual({ s: "waiting", kept: KS });
    expect(run(start, single, { type: "seen", ids: new Set() }).tasks.get("b")).toEqual({ s: "snoozed" });
    expect(run(start, perTask, { type: "seen", ids: new Set() }).tasks.get("a")).toEqual({ s: "snoozed" });
  });

  describe("single-agent mode", () => {
    test("the page's one agent, waiting on another task, takes the run: that task is told none waits there now", () => {
      const start: Tasks = new Map<string, AgentState>([["x", { s: "waiting", gate: G, kept: KS }], ["y", PENDING]]);
      const { tasks, effects } = run(start, single, { type: "launch", task: "y", run: RN(6) }, { type: "runStart", task: "y" }, { type: "choose", task: "y", reuse: true });
      expect(tasks.get("x")).toEqual({ s: "snoozed", gate: G });
      expect(effects[1]).toEqual([{ type: "clearTimer", task: "x" }, { type: "say", event: "snooze", data: { run: 4, task: "x", finishedAt: 400, engine: "e" } }]);
      expect(tasks.get("y")).toEqual({ s: "running", run: RN(6), session: S1, ref: R1, solo: SOLO });
      expect(soloHolder(tasks)).toMatchObject({ task: "y", session: S1, running: true });
    });

    test("a run's end keeps it as the page's one agent whatever it came to, with what it was told", () => {
      const start: Tasks = new Map([["y", { s: "running", run: RN(6), session: S1, ref: R1, solo: SOLO }]]);
      const { tasks } = run(start, single, { type: "runEnd", task: "y", at: AT, outcome: "nothing", ref: R1, solo: { told: ["gen", "sel"], turns: 3 } });
      expect(tasks.get("y")).toMatchObject({ s: "waiting", kept: { session: S1, solo: { told: ["gen", "sel"], turns: 3 } } });
    });

    test("a model change: the run closes the page's one agent and starts afresh, which is the page's one after it", () => {
      const start: Tasks = new Map<string, AgentState>([["x", { s: "waiting", kept: KS }]]);
      const { tasks, effects } = run(start, single, { type: "launch", task: "y", run: RN(7) }, { type: "runStart", task: "y" }, { type: "choose", task: "y", reuse: false }, { type: "started", task: "y", session: SN });
      expect(effects[2]).toEqual([{ type: "close", session: S1 }]);
      expect(soloHolder(tasks)).toBeUndefined();
      const end = run(tasks, single, { type: "runEnd", task: "y", at: AT, outcome: "suggested", ref: R2, solo: { told: ["gen"], turns: 1 } });
      expect(soloHolder(end.tasks)).toMatchObject({ task: "y", session: SN, solo: { told: ["gen"], turns: 1 } });
    });

    test("the chat on a task whose record names the page's one agent gets it whole, unless a run is a turn of it", () => {
      const start: Tasks = new Map<string, AgentState>([["x", { s: "waiting", gate: G, kept: KS }], ["y", { s: "held", gate: G }]]);
      const { tasks, effects } = run(start, single, { type: "chatOpen", task: "y", recorded: R1.session });
      expect(effects[0]).toEqual([{ type: "clearTimer", task: "x" }, { type: "lend", agent: { session: S1, ref: R1 } }]);
      expect(tasks.get("x")).toEqual({ s: "held", gate: G }); // moved, not closed: nothing said
      expect(tasks.get("y")).toEqual({ s: "chatting", gate: G });
      const busy = new Map<string, AgentState>([...start, ["z", { s: "acking", run: RN(8) }]]);
      expect(run(busy, single, { type: "chatOpen", task: "y", recorded: R1.session }).effects[0]).toEqual([{ type: "working" }]);
      // Not its own: the usual way.
      expect(run(start, single, { type: "chatOpen", task: "y", recorded: "other" }).effects[0]).toEqual([{ type: "lend", agent: null }]);
    });

    test("an agent given back by the chat is the page's one again, told afresh; any other loses the mark", () => {
      const start: Tasks = new Map<string, AgentState>([["x", { s: "waiting", kept: KS }], ["y", { s: "chatting" }]]);
      const { tasks } = run(start, single, { type: "chatClose", task: "y", at: AT, agent: { session: S3, ref: R3 }, finishedAt: 300 });
      expect(tasks.get("x")).toEqual({ s: "waiting", kept: { ...K, solo: undefined } });
      expect(tasks.get("y")).toMatchObject({ s: "waiting", kept: { session: S3, solo: { told: [], turns: 0 }, order: 2 } });
      expect(soloHolder(tasks)?.task).toBe("y");
    });
  });

  test("ready: a gate opens at its time, and once the page differs from the hash it holds", () => {
    expect(ready(PENDING, 0, 1)).toBe(true);
    expect(ready({ s: "held", gate: { until: 10 } }, 9, 1)).toBe(false);
    expect(ready({ s: "held", gate: { until: 10 } }, 10, 1)).toBe(true);
    expect(ready({ s: "waiting", gate: { until: 0, hash: 1 }, kept: K }, 5, 1)).toBe(false);
    expect(ready({ s: "waiting", gate: { until: 0, hash: 1 }, kept: K }, 5, 2)).toBe(true);
    expect(ready({ s: "held", gate: { until: Infinity } }, 5, 2)).toBe(false);
    for (const a of [STATES.acking!, STATES.running!, STATES.chatting!]) expect(ready(a, 5, 2)).toBe(false);
  });
});
