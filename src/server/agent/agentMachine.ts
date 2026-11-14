import type { TaskAgent } from "../../shared/docfile";
import type { AgentSession } from "./engine";

/**
 * Where each task's agent stands on one page, as a pure function: `step(tasks, config, event)` gives the next states
 * and what to do about them. No timers, files or engines here: `PageAgents` (`pageAgents.ts`) does the I/O (the ack,
 * starting an engine, the run, writing its outcome), feeds the events in, and carries out the effects. Sessions are
 * opaque values the machine only moves between states.
 *
 * Single-agent mode (`Config.single`) is not a separate path: the page's one lasting agent is the agent of whichever
 * task's state holds it, marked by its `solo` (what it has been told, and how many turns it has taken).
 */

/** When an idle task may be sent again: after `until`, and if `hash` is set, once the page differs from it. */
export interface Gate { until: number; hash?: bigint | number }

/** The page's one agent (single-agent mode): the task types it has had the instructions of, and its turns so far. */
export interface Solo { told: string[]; turns: number }

/** An agent kept after its run (or given back by the chat), waiting for more until its timer snoozes it. */
export interface Kept {
  session: AgentSession;
  ref: TaskAgent;
  /** The run it came from (0: given back by the chat). */
  run: number;
  until: number;
  finishedAt: number;
  /** When it started waiting, relative to the others: past `maxWaiting`, the lowest snoozes. */
  order: number;
  /** Set while it is the page's one agent (single-agent mode). */
  solo?: Solo;
}

/**
 * One run's log, for a tab that opens mid-run and for the terminal view. `PageAgents` appends to `said` and sets
 * `step` and `model` as the run goes; the machine only carries it.
 */
export interface RunLog { n: number; taskType: string; model: string; startedAt: number; step?: string; said: { event: string; data: object }[] }

export type AgentState =
  /** No agent and nothing holding it back: sent as soon as it is pending and the page has settled. */
  | { s: "pending" }
  /** No agent; sent again once its gate opens. */
  | { s: "held"; gate: Gate }
  /** Its agent was closed, its conversation left on disk. */
  | { s: "snoozed"; gate?: Gate }
  /** Its agent waits for more (an ask again, the chat), until its timer snoozes it. */
  | { s: "waiting"; gate?: Gate; kept: Kept }
  /** A run is acknowledging it in the file. An agent kept from before still waits until the run takes it. */
  | { s: "acking"; run: RunLog; gate?: Gate; kept?: Kept }
  /**
   * A run works on it. `taken`: the agent it took up, until it chooses to go on with it or not. `session`: its agent
   * once chosen or started (`ref` when it went on with one); `solo` while that is the page's one agent; `dropped`
   * once it was closed (a failed run, or one that keeps no conversation).
   */
  | { s: "running"; run: RunLog; taken?: Kept; session?: AgentSession; ref?: TaskAgent; solo?: Solo; dropped?: boolean }
  /** The writer is chatting with its agent: the chat has it, and no run is sent until the chat ends. */
  | { s: "chatting"; gate?: Gate };

export type Tasks = ReadonlyMap<string, AgentState>;
export const PENDING: AgentState = { s: "pending" };

/** Read by the machine, never changed by it. */
export interface Config { single: boolean; waitMs: number; maxWaiting: number; gapMs: number }

/** Run outcomes after which the agent is kept for the writer's next word (in single-agent mode, every one). */
const KEEPS = new Set(["suggested", "declined", "applied"]);

export type Event =
  /** The loop picked the task: a run starts acknowledging it. */
  | { type: "launch"; task: string; run: RunLog }
  /** The acknowledgement failed: tried again after the gap. */
  | { type: "ackFailed"; task: string; at: number }
  /** The task was no longer pending: no run. */
  | { type: "ackNothing"; task: string }
  /** Acknowledged: the run takes up the task's own kept agent, or in single-agent mode the page's one agent. */
  | { type: "runStart"; task: string }
  /** The run goes on with the agent it took up (`reuse`), or closes it to start a fresh one. */
  | { type: "choose"; task: string; reuse: boolean }
  /** A fresh agent started for the run. */
  | { type: "started"; task: string; session: AgentSession }
  /** The run's agent is done with: the run failed, or its agent keeps no conversation. */
  | { type: "drop"; task: string }
  /** The run's outcome is written. `ref`: its agent's conversation, if it keeps one; `solo`: what it was told. */
  | { type: "runEnd"; task: string; at: number; outcome: string; ref?: TaskAgent; solo: Solo }
  /** When a task whose run has ended may be sent again. */
  | { type: "release"; task: string; gate: Gate }
  /** Something unexpected broke the run: tried again after the gap. */
  | { type: "crash"; task: string; at: number }
  /** Its agent's wait is over (its timer, or the page let it go): it snoozes. */
  | { type: "snooze"; task: string }
  /** The ids of the tasks in the page now: a kept agent whose task left has nothing more to do. */
  | { type: "seen"; ids: ReadonlySet<string> }
  /** The writer opens a chat on it. `recorded`: the session its record names (single-agent mode). */
  | { type: "chatOpen"; task: string; recorded?: string }
  /** The chat ended, giving back its agent (none: it never had one). */
  | { type: "chatClose"; task: string; at: number; agent?: { session: AgentSession; ref: TaskAgent }; finishedAt: number }
  /** The page's agents stop. */
  | { type: "stop" };

export type Effect =
  /** Tell the page's agent streams. */
  | { type: "say"; event: string; data: object }
  /** Close an agent; the caller may wait for it. */
  | { type: "close"; session: AgentSession }
  /** Close an agent in the background, then say it snoozed. */
  | { type: "snooze"; session: AgentSession; data: object }
  | { type: "setTimer"; task: string; ms: number }
  | { type: "clearTimer"; task: string }
  /** The answer to `chatOpen`: the agent lent to the chat (null: none is kept; the chat wakes it from disk). */
  | { type: "lend"; agent: { session: AgentSession; ref: TaskAgent } | null }
  /** The answer to `chatOpen`: a run is on it, so the chat only looks in. */
  | { type: "working" };

/** `ok: false`: the event can't happen in this state (a bug in the caller); nothing changes. */
export type Step = { ok: true; tasks: Tasks; effects: Effect[] } | { ok: false; reason: string };

export const isRun = (a: AgentState): a is Extract<AgentState, { s: "acking" | "running" }> => a.s === "acking" || a.s === "running";
/** The agent waiting for the task, if one is (a task being acknowledged keeps its own until the run takes it). */
export const keptOf = (a: AgentState): Kept | undefined => (a.s === "waiting" || a.s === "acking" ? a.kept : undefined);
export const gateOf = (a: AgentState): Gate | undefined => (a.s === "held" || a.s === "snoozed" || a.s === "waiting" || a.s === "acking" || a.s === "chatting" ? a.gate : undefined);

/** Whether a task in this state may be sent a run now, the page being `hash`. */
export function ready(a: AgentState, now: number, hash: bigint | number): boolean {
  if (isRun(a) || a.s === "chatting") return false;
  const g = gateOf(a);
  return !g || (now >= g.until && (g.hash === undefined || g.hash !== hash));
}

/** The task whose state holds the page's one agent, and that agent (session, ref, solo), if one is live. */
export function soloHolder(tasks: Tasks): { task: string; session: AgentSession; ref?: TaskAgent; solo: Solo; running: boolean } | undefined {
  for (const [task, a] of tasks) {
    const k = keptOf(a);
    if (k?.solo) return { task, session: k.session, ref: k.ref, solo: k.solo, running: false };
    if (a.s === "running" && a.solo && a.session) return { task, session: a.session, ref: a.ref, solo: a.solo, running: true };
  }
  return undefined;
}

/** The agents waiting, oldest first. */
export const keptList = (tasks: Tasks): [string, Kept][] =>
  [...tasks].flatMap(([t, a]): [string, Kept][] => { const k = keptOf(a); return k ? [[t, k]] : []; }).sort((x, y) => x[1].order - y[1].order);

/** The state of an idle task with `gate` and no agent. */
const idle = (gate: Gate | undefined): AgentState => (gate ? { s: "held", gate } : PENDING);
/** A task being acknowledged, its kept agent gone. */
const unkept = ({ kept: _, ...a }: Extract<AgentState, { s: "acking" }>): AgentState => a;
const snoozeData = (task: string, k: Kept) => ({ run: k.run, task, finishedAt: k.finishedAt, engine: k.ref.engine });

export function step(tasks: Tasks, c: Config, e: Event): Step {
  const next = new Map(tasks);
  const effects: Effect[] = [];
  const no = (reason: string): Step => ({ ok: false, reason });
  const ok = (): Step => ({ ok: true, tasks: next, effects });
  const get = (t: string) => next.get(t) ?? PENDING;

  /** The state `a` of `t` without its kept agent (its timer cleared): the agent moves elsewhere, not closed. */
  const unkeep = (t: string, a: AgentState): AgentState => {
    effects.push({ type: "clearTimer", task: t });
    if (a.s === "acking") return unkept(a);
    return idle(gateOf(a));
  };
  /** Snoozes the agent kept for `t`, if one waits: closed, its conversation on disk. */
  const snooze = (t: string) => {
    const a = get(t);
    const k = keptOf(a);
    if (!k) return;
    effects.push({ type: "clearTimer", task: t });
    next.set(t, a.s === "acking" ? unkept(a) : { s: "snoozed", ...(gateOf(a) && { gate: gateOf(a) }) });
    effects.push({ type: "snooze", session: k.session, data: snoozeData(t, k) });
  };
  /** In single-agent mode, `except` becomes the page's one agent: any other loses the mark (it stays, as any agent). */
  const unmarkSolo = (except: string) => {
    for (const [t, a] of next) {
      if (t === except) continue;
      const k = keptOf(a);
      if (k?.solo) next.set(t, { ...a, kept: { ...k, solo: undefined } } as AgentState);
      else if (a.s === "running" && a.solo) next.set(t, { ...a, solo: undefined });
    }
  };
  /** Keeps `k` for `t`: it waits `waitMs`, then snoozes; past `maxWaiting`, the oldest snoozes. */
  const keep = (t: string, gate: Gate | undefined, k: Omit<Kept, "order" | "until">, at: number) => {
    const order = Math.max(0, ...keptList(next).map(([, x]) => x.order)) + 1;
    const until = at + c.waitMs;
    next.set(t, { s: "waiting", ...(gate && { gate }), kept: { ...k, until, order } });
    if (k.solo) unmarkSolo(t);
    effects.push({ type: "setTimer", task: t, ms: c.waitMs });
    effects.push({ type: "say", event: "wait", data: { run: k.run, task: t, until, engine: k.ref.engine, finishedAt: k.finishedAt } });
    for (let list = keptList(next); list.length > c.maxWaiting; list = keptList(next)) snooze(list[0]![0]);
  };

  switch (e.type) {
    case "launch": {
      const a = get(e.task);
      if (isRun(a) || a.s === "chatting") return no(`a run can't start on a task ${a.s}`);
      next.set(e.task, { s: "acking", run: e.run, ...(gateOf(a) && { gate: gateOf(a) }), ...(keptOf(a) && { kept: keptOf(a) }) });
      return ok();
    }

    case "ackFailed":
    case "ackNothing": {
      const a = get(e.task);
      if (a.s !== "acking") return no(`no acknowledgement on a task ${a.s}`);
      const gate = e.type === "ackFailed" ? { until: e.at + c.gapMs } : a.gate;
      next.set(e.task, a.kept ? { s: "waiting", ...(gate && { gate }), kept: a.kept } : idle(gate));
      return ok();
    }

    case "runStart": {
      const a = get(e.task);
      if (a.s !== "acking") return no(`a run starts on a task ${a.s}`);
      let taken: Kept | undefined;
      if (c.single) {
        // The page's one agent, whichever task it waits on; a task it waited on instead is told none waits there now.
        const h = soloHolder(next);
        if (h && !h.running) {
          const other = get(h.task);
          taken = keptOf(other)!;
          if (h.task !== e.task) {
            effects.push({ type: "clearTimer", task: h.task });
            next.set(h.task, { s: "snoozed", ...(gateOf(other) && { gate: gateOf(other) }) });
            effects.push({ type: "say", event: "snooze", data: snoozeData(h.task, taken) });
          }
        }
        // An agent of this task's own that isn't the page's one has no place in this mode: it snoozes.
        const own = (get(e.task) as typeof a).kept;
        if (own && own !== taken) { effects.push({ type: "clearTimer", task: e.task }); effects.push({ type: "snooze", session: own.session, data: snoozeData(e.task, own) }); }
        else if (own) effects.push({ type: "clearTimer", task: e.task });
      } else if (a.kept) {
        taken = a.kept;
        effects.push({ type: "clearTimer", task: e.task });
      }
      next.set(e.task, { s: "running", run: a.run, ...(taken && { taken }) });
      return ok();
    }

    case "choose": {
      const a = get(e.task);
      if (a.s !== "running" || a.session) return no(`no agent to choose on a task ${a.s}`);
      const { taken, ...rest } = a;
      if (e.reuse) {
        if (!taken) return no("nothing taken up to go on with");
        next.set(e.task, { ...rest, session: taken.session, ref: taken.ref, ...(taken.solo && { solo: taken.solo }) });
      } else {
        if (taken) effects.push({ type: "close", session: taken.session });
        next.set(e.task, rest);
      }
      return ok();
    }

    case "started": {
      const a = get(e.task);
      if (a.s !== "running" || a.session || a.taken) return no(`an agent starts on a task ${a.s}`);
      next.set(e.task, { ...a, session: e.session });
      return ok();
    }

    case "drop": {
      const a = get(e.task);
      if (a.s !== "running") return no(`no run's agent to drop on a task ${a.s}`);
      if (a.session && !a.dropped) effects.push({ type: "close", session: a.session });
      // The session stays for a chat looking in until the run ends; it is no longer the page's one agent.
      next.set(e.task, { ...a, solo: undefined, dropped: true });
      return ok();
    }

    case "runEnd": {
      const a = get(e.task);
      if (a.s !== "running") return no(`a run ends on a task ${a.s}`);
      // Not sent again until its gate is set (`release`), once the run's cleanup is done.
      const gate: Gate = { until: Infinity };
      const live = a.session && !a.dropped ? a.session : undefined;
      if (live && e.ref && (c.single || KEEPS.has(e.outcome))) {
        keep(e.task, gate, { session: live, ref: e.ref, run: a.run.n, finishedAt: e.at, ...(c.single && { solo: e.solo }) }, e.at);
      } else {
        if (live) effects.push({ type: "close", session: live });
        next.set(e.task, idle(gate));
      }
      return ok();
    }

    case "release": {
      const a = get(e.task);
      if (isRun(a)) return no(`a gate set on a task ${a.s}`);
      next.set(e.task, a.s === "pending" || a.s === "held" ? { s: "held", gate: e.gate } : { ...a, gate: e.gate });
      return ok();
    }

    case "crash": {
      const a = get(e.task);
      const gate = { until: e.at + c.gapMs };
      if (a.s === "running") {
        if (a.taken) effects.push({ type: "close", session: a.taken.session });
        if (a.session && !a.dropped) effects.push({ type: "close", session: a.session });
        next.set(e.task, idle(gate));
      } else if (a.s === "acking") next.set(e.task, a.kept ? { s: "waiting", gate, kept: a.kept } : idle(gate));
      else next.set(e.task, a.s === "pending" || a.s === "held" ? { s: "held", gate } : { ...a, gate });
      return ok();
    }

    case "snooze":
      snooze(e.task);
      return ok();

    case "seen":
      for (const [t, k] of keptList(next)) {
        // The page's one agent stays: its next turn may be anywhere on the page.
        if (e.ids.has(t) || (c.single && k.solo)) continue;
        snooze(t);
      }
      return ok();

    case "chatOpen": {
      const a = get(e.task);
      if (a.s === "chatting") return no("a chat on this task is open already");
      if (isRun(a)) { effects.push({ type: "working" }); return ok(); }
      // Single-agent mode: the page's one conversation goes to the chat whole, and only while no run is a turn of it.
      // One it never worked on (a suggestion from before this mode) is not its own, and goes the usual way.
      const h = c.single ? soloHolder(next) : undefined;
      if (h && h.ref && (h.task === e.task || e.recorded === h.ref.session)) {
        if ([...next.values()].some(isRun)) { effects.push({ type: "working" }); return ok(); }
        if (h.task !== e.task) {
          next.set(h.task, unkeep(h.task, get(h.task)));
          // An agent of this task's own that isn't the page's one: the chat has the page's, so it snoozes.
          const own = keptOf(a);
          if (own) { effects.push({ type: "clearTimer", task: e.task }); effects.push({ type: "snooze", session: own.session, data: snoozeData(e.task, own) }); }
        } else effects.push({ type: "clearTimer", task: e.task });
        next.set(e.task, { s: "chatting", ...(gateOf(a) && { gate: gateOf(a) }) });
        effects.push({ type: "lend", agent: { session: h.session, ref: h.ref } });
        return ok();
      }
      const k = keptOf(a);
      if (k) effects.push({ type: "clearTimer", task: e.task });
      next.set(e.task, { s: "chatting", ...(gateOf(a) && { gate: gateOf(a) }) });
      effects.push({ type: "lend", agent: k ? { session: k.session, ref: k.ref } : null });
      return ok();
    }

    case "chatClose": {
      const a = get(e.task);
      if (isRun(a)) return no(`a chat ends on a task ${a.s}`);
      if (!e.agent) {
        if (a.s === "chatting") next.set(e.task, idle(a.gate));
        return ok();
      }
      snooze(e.task); // one kept meanwhile (there should be none)
      const gate = gateOf(get(e.task));
      // Single-agent mode: it is the page's one agent again, told the page afresh on its next turn (the chat has
      // been over it since).
      keep(e.task, gate, { session: e.agent.session, ref: e.agent.ref, run: 0, finishedAt: e.finishedAt, ...(c.single && { solo: { told: [], turns: 0 } }) }, e.at);
      return ok();
    }

    case "stop":
      for (const a of tasks.values()) if (a.s === "running" && a.session) effects.push({ type: "close", session: a.session });
      for (const [t, k] of keptList(tasks)) {
        effects.push({ type: "clearTimer", task: t });
        effects.push({ type: "close", session: k.session });
      }
      return { ok: true, tasks: new Map(), effects };
  }
}
