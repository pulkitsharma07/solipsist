import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToDoc, parseFile, markersIn, type TaskAgent } from "../../shared/docfile";
import { plugins } from "../../shared/plugin";
import { readModifyWrite, repairs, withLock } from "../files";
import { log, why } from "../log";
import { ackTask, checkRunReply, finishRun, taskReply, type AnyReply, type RunOutcome } from "../suggest";
import { onPageChanged, root, runtime } from "../runtime";
import { overBudget, overRuns } from "./budget";
import { publish } from "./bus";
import { SCRATCH_PREFIX } from "./leftovers";
import { clip, DETAIL, type AgentSession } from "./engine";
import {
  gateOf, isRun, keptList, PENDING, ready as isReady, soloHolder, step, type AgentState, type Effect, type Event, type RunLog, type Tasks,
} from "./agentMachine";
import { choiceOf, engineKnows, engines, parseChoice } from "./engines";
import {
  concurrency, forgetPage, gapMs, imagesDir, maxRuns, maxWaiting, pageFile, pageHash, pageView, promptFor, promptNext,
  recordedAgent, recordedFinish, resetStaleAcks, runKinds, runTimeoutMs, settleMs, singleAgent, instructions,
  waitMs, type Target,
} from "./page";
import { runOnce } from "./runOnce";
import { readSettings, writeSettings } from "./settings";
import { reviewPage, reviewRunOf, type ReviewDriver, type ReviewResult } from "../review";
import type { AgentStep } from "./engine";

/**
 * In single-agent mode (`agent.single_agent`) the page has one agent instead: every task is a turn of its
 * conversation, one at a time, so it keeps what it has read and written and each prompt after the first is short. It
 * waits and snoozes like any kept agent, and the next run takes its conversation up again (`block.agent.solo`).
 *
 * The agents of one page: the loop that sends each pending task a run of its own, the
 * runs in flight, the agents kept after their runs, and the lending of a kept agent to the chat. It reports what
 * happens to whoever subscribes (the page's agent streams, one per open tab), and a tab that subscribes mid-run is told
 * what is in flight first. The page's agents start when a tab opens the page and keep working when it closes: they
 * stop once no tab is open and nothing is left to do (`rest`), or when the writer turns them off (`stop`).
 */

/**
 * The longest the loop sleeps without being woken: it looks when something happens (`nudge`), and this only bounds a
 * signal missed (an fs event dropped) or a change nothing reports (a new day under the cost limit).
 */
export const LOOK_AT_LEAST_MS = 5000;

/** How many of a run's steps are kept, for a tab that opens mid-run. */
const REPLAY_STEPS = 50;

import { REVIEW } from "../../shared/chat";
export { REVIEW };

/** What a page's agents report: the event's name and its data. */
export type AgentListener = (event: string, data: object) => void;

/** Where a page's agents stand, for the terminal view (`tui.ts`). */
export interface PageSnapshot {
  id: string;
  model: string;
  tabs: number;
  /** Why the loop is idle, if it is: settling, unchanged, nothing pending, busy, cost. */
  idle?: string;
  runs: { task: string; taskType: string; run: number; model: string; startedAt: number; step?: string }[];
  kept: { task: string; until: number; finishedAt: number }[];
  chatting: string[];
}

export const pageAgents = (id: string) => runtime().pages.get(id);
export const runningPages = () => [...runtime().pages.keys()];
export const allPageAgents = () => [...runtime().pages.values()];
/** The runs in flight on every page, for the server's limit (`AGENT_MAX_RUNS`). */
export const runsEverywhere = () => [...runtime().pages.values()].reduce((n, p) => n + p.runCount, 0);
/** Stops every page's agents (the server is shutting down); resolves once their acks are reset. */
export const stopAllPages = (reason: string) => Promise.all([...runtime().pages.values()].map((p) => p.stop(reason)));

/**
 * The tasks whose agent the writer is chatting with, by page: the chat has it, so no run is sent to the
 * task until the chat ends. Kept apart from the page's agents, which may not be running.
 */
export const chatting = (id: string) => runtime().chats.get(id) ?? new Set<string>();
export const markChatting = (id: string, task: string) => void runtime().chats.set(id, chatting(id).add(task));
export const unmarkChatting = (id: string, task: string) => { const chats = runtime().chats; const set = chats.get(id); if (set?.delete(task) && !set.size) chats.delete(id); };

/** Who wants to know when the run on a task ends (a chat looking in on it), by `page/task`. */
const runEnded = (id: string, task: string, end: { error?: string }) => { for (const f of runtime().enders.get(`${id}/${task}`) ?? []) try { f(end); } catch {} };
/** Listens for the end of the run on `task`; the returned function stops listening. */
export function onRunEnd(id: string, task: string, f: (end: { error?: string }) => void): () => void {
  const k = `${id}/${task}`;
  const enders = runtime().enders;
  const set = enders.get(k) ?? new Set();
  enders.set(k, set.add(f));
  return () => { set.delete(f); if (!set.size) enders.delete(k); };
}

/**
 * Where each recorded agent of a task still in the body stands, for a tab that opens: one being chatted with,
 * or snoozed (one waiting is told by the page's agents), and when each finished its last run.
 */
export function agentStates(id: string): { agents: Record<string, "snoozed" | "chatting">; finished: Record<string, number> } {
  const agents: Record<string, "snoozed" | "chatting"> = {};
  const finished: Record<string, number> = {};
  let file;
  try { file = parseFile(readFileSync(pageFile(id), "utf8")); } catch { return { agents, finished }; }
  let found: ReturnType<typeof markersIn> = [];
  try { found = markersIn(markdownToDoc(file.markdown)); } catch {}
  for (const p of found) {
    const record = file.block.tasks?.[p.id];
    if (!record?.agent) continue;
    agents[p.id] = chatting(id).has(p.id) ? "chatting" : "snoozed";
    const at = record.finished ? Date.parse(record.finished) : NaN;
    if (Number.isFinite(at)) finished[p.id] = at;
  }
  return { agents, finished };
}

/** Events worth a line in the server's log, as the action they record. */
const LOGGED: Record<string, string> = { start: "run.start", end: "run.end", wait: "agent.wait", snooze: "agent.snooze", model: "agents.model", warning: "agents.warning", error: "agents.error" };

/** The engine of each recorded agent of a task still in the body, for a stream that starts (the pill's mark). */
export function agentEngines(id: string): Record<string, string> {
  let file;
  try { file = parseFile(readFileSync(pageFile(id), "utf8")); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const p of markersIn(markdownToDoc(file.markdown))) {
    const a = file.block.tasks?.[p.id]?.agent;
    if (a) out[p.id] = a.engine;
  }
  return out;
}

/** Whether a recorded agent is on the choice `model` (`engine:model`), whatever its engine can run now. */
function onChoice(ref: TaskAgent, model: string) {
  const c = parseChoice(model);
  return !!c && c.engine.name === ref.engine && c.model === ref.model;
}

/**
 * The choice of a recorded agent, if its engine can run now and still offers its model; null when it can't (a key
 * removed, a model dropped), and the task then goes to the page's engine.
 */
function ownChoice(ref: TaskAgent) {
  const engine = engines().find((e) => e.name === ref.engine);
  if (!engine || engine.unavailable() || !engineKnows(engine, ref.model)) return null;
  return { engine, model: ref.model, choice: choiceOf(engine.name, ref.model) };
}

export class PageAgents {
  /** The model the next run starts on (`engine:model`); runs in flight keep theirs. */
  model: string;
  private stopped: Promise<void> | null = null;
  private n = 0;
  /** Where each task's agent stands (`agentMachine.ts`); a task not in it is pending. */
  private tasks: Tasks = new Map();
  /** The timers of the agents waiting, by task (the machine's `setTimer`/`clearTimer`). */
  private readonly timers = new Map<string, Timer>();
  private readonly listeners = new Set<AgentListener>();
  private wake: (() => void) | undefined;
  /** Set by `nudge`, cleared as the loop looks: a nudge that comes while the loop is busy isn't lost. */
  private poked = false;
  private offChanged = () => {};
  /** How many times the loop has looked at the page (tests: it looks when something happens, not on a clock). */
  looks = 0;
  /** Why the loop is idle, as last said. */
  private idle: string | undefined;
  /** The working directory of this page's agents: made when the first one starts, removed when they stop. */
  private scratchDir: string | undefined;
  private get scratch(): string {
    return (this.scratchDir ??= mkdtempSync(join(tmpdir(), `${SCRATCH_PREFIX}${process.pid}-`)));
  }

  /** The runs in flight on the page (acknowledging or running), by task, in the order they started. */
  private runs(): [string, RunLog][] {
    return [...this.tasks].flatMap(([t, a]): [string, RunLog][] => (isRun(a) ? [[t, a.run]] : [])).sort((x, y) => x[1].n - y[1].n);
  }

  get runCount() {
    let n = 0;
    for (const a of this.tasks.values()) if (isRun(a)) n++;
    return n;
  }

  get isStopped() {
    return this.stopped !== null;
  }

  constructor(readonly id: string, model: string) {
    this.model = model;
    // A chat opened while the page's agents weren't running has its task's agent still.
    this.tasks = new Map([...chatting(id)].map((t): [string, AgentState] => [t, { s: "chatting" }]));
  }

  /** Starts the loop; the page counts as running from now. */
  start() {
    runtime().pages.set(this.id, this);
    // The loop looks when the page changes, not on a clock.
    this.offChanged = onPageChanged((id) => { if (id === this.id) this.nudge(); });
    log("agents.start", { page: this.id, model: this.model });
    void this.loop();
  }

  /**
   * Feeds `e` to the machine and carries out its effects. `closed` resolves once the agents it closed are closed
   * (null: it closed none, so there is nothing to wait for; those that snooze close in the background). After `stop` nothing is fed: what is left of the runs cleans up
   * after itself.
   */
  private apply(e: Event): { effects: Effect[]; closed: Promise<void> | null } {
    if (this.stopped && e.type !== "stop") return { effects: [], closed: null };
    const r = step(this.tasks, { single: singleAgent(), waitMs: waitMs(), maxWaiting: maxWaiting(), gapMs: gapMs() }, e);
    if (!r.ok) {
      this.say("error", { run: 0, message: `The agent loop: ${e.type} refused: ${r.reason}` });
      return { effects: [], closed: null };
    }
    this.tasks = r.tasks;
    const closing: Promise<unknown>[] = [];
    for (const fx of r.effects) {
      switch (fx.type) {
        case "say": this.say(fx.event, fx.data); break;
        case "close": closing.push(fx.session.close().catch(() => {})); break;
        case "snooze":
          void fx.session.close().catch(() => {}).then(() => {
            this.say("snooze", fx.data);
            this.nudge(); // nothing may be left to do
          });
          break;
        case "setTimer":
          clearTimeout(this.timers.get(fx.task));
          this.timers.set(fx.task, setTimeout(() => { this.timers.delete(fx.task); this.apply({ type: "snooze", task: fx.task }); }, fx.ms));
          break;
        case "clearTimer": clearTimeout(this.timers.get(fx.task)); this.timers.delete(fx.task); break;
        case "lend": case "working": break; // answers to `chatOpen`, read by `take`
      }
    }
    return { effects: r.effects, closed: closing.length ? Promise.all(closing).then(() => {}) : null };
  }

  private runState(task: string) {
    const a = this.tasks.get(task);
    return a?.s === "running" ? a : undefined;
  }

  /**
   * Hears every event from now on, after what is in flight now: each run's start and steps so far, and each agent
   * waiting. The returned function stops; with no tab left, the page's agents carry on until nothing is left to do.
   */
  subscribe(f: AgentListener): () => void {
    for (const [, r] of this.runs()) for (const s of r.said) try { f(s.event, s.data); } catch {}
    for (const [task, k] of keptList(this.tasks)) try { f("wait", { run: k.run, task, until: k.until, finishedAt: k.finishedAt }); } catch {}
    this.listeners.add(f);
    log("agents.tab", { page: this.id, tabs: this.listeners.size });
    return () => {
      if (!this.listeners.delete(f)) return;
      log("agents.tab", { page: this.id, tabs: this.listeners.size });
      this.nudge();
    };
  }

  /** Tells every subscriber, keeps a run's events for a tab that opens later, and logs what matters. */
  say(event: string, data: object) {
    const d = { at: Date.now(), ...data } as { at: number; run?: number; task?: string; [k: string]: unknown };
    const run = d.run ? this.runs().find(([, r]) => r.n === d.run)?.[1] : undefined;
    if (run && (event === "start" || event === "step")) {
      run.said.push({ event, data: d });
      if (run.said.length > REPLAY_STEPS + 1) run.said.splice(1, 1); // the start stays
      if (event === "step" && typeof d.text === "string") run.step = d.text;
    }
    if (LOGGED[event] || (event === "skip" && (d.reason === "busy" || d.reason === "cost" || d.reason === "runs"))) {
      const { at: _at, detail: _d, result, ...rest } = d;
      log(LOGGED[event] ?? "agents.skip", { page: this.id, ...rest, ...(typeof result === "string" && result && { result: clip(result, 300) }) });
    }
    for (const f of this.listeners) try { f(event, d); } catch {}
  }

  /** Wakes the loop now, instead of at its next look. */
  nudge() {
    this.poked = true;
    this.wake?.();
  }

  /**
   * Stops every agent of the page (`reason`: the writer turned them off, nothing left to do, the server stopping).
   * What the runs in flight acknowledged is left unfinished, so it waits again; the waiting agents snooze, their
   * conversations on disk. Resolves once the acks are reset. Safe to call twice.
   */
  stop(reason = "stopped"): Promise<void> {
    if (this.stopped) return this.stopped;
    if (runtime().pages.get(this.id) === this) runtime().pages.delete(this.id);
    this.offChanged();
    forgetPage(this.id);
    log("agents.stop", { page: this.id, reason, runs: this.runCount, waiting: keptList(this.tasks).length });
    this.say("stopped", { run: 0, reason });
    this.listeners.clear();
    const abandoned = this.runCount > 0;
    // Every agent closes and every timer is cleared; the runs still going see `stopped` and write nothing.
    const { closed } = this.apply({ type: "stop" });
    // Reset at once, not once the agents have closed: one whose close hangs would keep its task spinning. A run
    // that ends after this writes nothing (`launch` checks `stopped`).
    this.stopped = (abandoned ? resetStaleAcks(this.id).then(() => {}) : Promise.resolve()).catch((e) => log("agents.error", { page: this.id, message: `Couldn't reset acks: ${why(e)}` }));
    // Removed now, not once the agents have closed: a close that hangs (or a server that exits first) would leave
    // the folder behind for good, and an agent still closing needs nothing from it.
    if (this.scratchDir) rmSync(this.scratchDir, { recursive: true, force: true });
    this.scratchDir = undefined;
    this.nudge();
    return this.stopped;
  }

  /**
   * The agent kept for `task`, out of the loop's hands (null: none waits, and the chat wakes it from disk);
   * "working" while a run is on it. In single-agent mode the page's one conversation goes to the chat whole, and
   * only while no run is a turn of it. Until `adopt` (or `chatEnded`), no run is sent to the task.
   */
  take(task: string): { session: AgentSession; ref: TaskAgent } | "working" | null {
    const recorded = singleAgent() && soloHolder(this.tasks) ? recordedAgent(this.id, task)?.session : undefined;
    const { effects } = this.apply({ type: "chatOpen", task, ...(recorded && { recorded }) });
    for (const fx of effects) {
      if (fx.type === "working") return "working";
      if (fx.type === "lend") return fx.agent;
    }
    return null;
  }

  /** Takes back an agent the chat had: it waits again (in single-agent mode, as the page's one agent). */
  adopt(task: string, session: AgentSession, ref: TaskAgent) {
    if (this.stopped) { void session.close(); return; }
    const at = Date.now();
    this.apply({ type: "chatClose", task, at, agent: { session, ref }, finishedAt: recordedFinish(this.id, task) ?? at });
    this.nudge();
  }

  /** The chat on `task` ended with no agent to give back (it couldn't wake one): the task is the loop's again. */
  chatEnded(task: string) {
    this.apply({ type: "chatClose", task, at: Date.now(), finishedAt: 0 });
    this.nudge();
  }

  /** The run on `task`, if one is in flight: its agent, once started (undefined while it starts). */
  running(task: string): { session?: AgentSession } | undefined {
    const a = this.tasks.get(task);
    if (!a || !isRun(a)) return undefined;
    return a.s === "running" ? { session: a.session } : {};
  }

  snapshot(): PageSnapshot {
    return {
      id: this.id,
      model: this.model,
      tabs: this.listeners.size,
      ...(this.idle && { idle: this.idle }),
      runs: this.runs().map(([task, r]) => ({ task, taskType: r.taskType, run: r.n, model: r.model, startedAt: r.startedAt, ...(r.step && { step: r.step }) })),
      kept: keptList(this.tasks).map(([task, k]) => ({ task, until: k.until, finishedAt: k.finishedAt })),
      chatting: [...chatting(this.id)],
    };
  }

  /**
   * Records the page's one agent in its file (`block.agent.solo`), so the next run takes its conversation up again
   * after it has snoozed, or after a restart. A run that failed records nothing: what it was told is in the
   * conversation already recorded, and an engine whose session has gone starts a new one of its own accord.
   */
  private async recordSolo(ref: TaskAgent) {
    const saved = readSettings(this.id).saved.solo;
    if (saved && saved.engine === ref.engine && saved.model === ref.model && saved.session === ref.session) return;
    await writeSettings(this.id, { solo: ref }).catch((e) => log("agents.error", { page: this.id, message: `Couldn't record the page's agent: ${why(e)}` }));
  }

  /** Waits `ms`, or until a nudge (one since the loop last looked returns at once). */
  private nap(ms: number) {
    if (this.poked || this.stopped) return Promise.resolve();
    return new Promise<void>((r) => {
      const done = () => { clearTimeout(timer); this.wake = undefined; r(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /**
   * How long the loop may sleep before it must look again on its own: until the page has settled, or a held task's
   * gap is over. Everything else wakes it (`nudge`): the page changing (`pageChanged`), a run ending, an agent
   * snoozing, a tab or a chat leaving. `LOOK_AT_LEAST_MS` bounds it, so a missed signal (or a new day under the cost
   * limit) can't stall the page.
   */
  private sleepFor(now: number, idle: string | undefined, quietSince: number) {
    let ms = LOOK_AT_LEAST_MS;
    if (idle === "settling") ms = Math.min(ms, quietSince + settleMs() - now);
    for (const a of this.tasks.values()) {
      const until = gateOf(a)?.until;
      if (until !== undefined && until > now && Number.isFinite(until)) ms = Math.min(ms, until - now);
    }
    return Math.max(0, ms);
  }

  /**
   * Starts a run on `t` and lets it go: the loop goes on while it works. The server acknowledges the task
   * first, so the writer sees the spinner at once; one that is no longer waiting gets no run.
   */
  private launch(t: Target) {
    const { id } = this;
    const r: RunLog = { n: ++this.n, taskType: t.taskType, model: this.model, startedAt: Date.now(), said: [] };
    this.apply({ type: "launch", task: t.id, run: r });
    // What a chat looking in on the run hears at its end: by then its agent, if kept, waits for the chat to take it.
    let failed: string | undefined;
    void (async () => {
      let page: string | null;
      try {
        page = await withLock(id, () => readModifyWrite(id, (src) => {
          const a = src === null ? null : ackTask(src, t.id);
          return { file: a?.file, result: a ? parseFile(a.file).markdown : null };
        }));
      } catch (e: any) {
        this.say("error", { message: `Couldn't acknowledge ${t.id}: ${why(e)}` });
        page = null;
        this.apply({ type: "ackFailed", task: t.id, at: Date.now() });
      }
      if (this.stopped || page === null) {
        if (this.tasks.get(t.id)?.s === "acking") this.apply({ type: "ackNothing", task: t.id });
        if (this.stopped && page !== null) await resetStaleAcks(id).catch(() => []);
        this.nudge();
        return;
      }
      const started = Date.now();
      const repairsAtStart = repairs.get(id) ?? 0;
      // The engine of the agent this task already has (kept waiting, or recorded on the page), if it can run now:
      // an ask again goes on with its conversation, whatever the page is on now. Otherwise the page's choice.
      //
      // In single-agent mode the run goes to the page's one agent instead, whichever task it is for: the live
      // one, or its recorded conversation taken up again (it snoozed, or the server was restarted). A change of the
      // page's model starts a fresh one, since the conversation is the old model's.
      const single = singleAgent();
      this.apply({ type: "runStart", task: t.id });
      const k = this.runState(t.id)?.taken;
      const recorded = k?.ref ?? (single ? readSettings(id).saved.solo : undefined) ?? recordedAgent(id, t.id);
      const own = recorded && (!single || onChoice(recorded, r.model)) ? ownChoice(recorded) : null;
      const choice = own ?? parseChoice(r.model);
      if (!choice) throw new Error(`No engine runs the model ${r.model}.`);
      const model = (r.model = choice.choice);
      this.say("start", { run: r.n, task: t.id, taskType: t.taskType, model, engine: choice.engine.name, ...(choice.engine.chats && { chat: true }) });
      // What the page's one agent has been told, read when the prompt is built and reported at the end of the run.
      let told = new Set<string>();
      let turns = 0;
      // The run itself is `runOnce`: start or reuse the agent, send it this, wait for the reply, the agent dying or
      // the time limit, and account for the cost. What is left here is the page's own bookkeeping.
      const report = await runOnce({
        id,
        choice,
        // The agent kept from this task's last run, or its conversation on disk: the run continues it (an ask
        // again). A kept one whose engine can't run now is closed, and the page's engine starts a fresh agent.
        ...(k && own ? { reuse: k.session } : own && recorded ? { resume: recorded.session } : {}),
        workspace: () => ({ file: pageFile(id), images: imagesDir(id), root: root(), scratch: this.scratch }),
        timeoutMs: runTimeoutMs(),
        prompt: () => {
          // The page's one agent, on a turn after its first, is sent the short prompt: it has the protocol, the page
          // and the task types it has been told in its conversation already, so only this task is new (`run.next`).
          const live = single ? this.runState(t.id)?.solo : undefined;
          told = new Set(live?.told ?? []);
          turns = live?.turns ?? 0;
          const prompt = turns > 0 ? promptNext(id, t, told) : promptFor(id, t);
          if (single) for (const p of runKinds(id, t)) told.add(p.taskType);
          // What this run is sent, in characters (engines report no input tokens; `run.end` carries the cost).
          log("run.size", { page: id, run: r.n, task: t.id, engine: choice.engine.name, system: instructions(choice.engine).system.length, prompt: prompt.length, turn: turns + 1 });
          return prompt;
        },
        // A reply tool's call is checked as `finishRun` will check it, so the agent can fix one that can't be used.
        check: (reply: AnyReply) => {
          const r = taskReply(reply);
          if (!r) return "There is no `comment` tool here.";
          try { return checkRunReply(readFileSync(pageFile(id), "utf8"), t, page, r); } catch (e: any) { return why(e); }
        },
        onStep: (s) => this.say("step", { run: r.n, ...s }),
        onStream: (e) => publish(id, t.id, e),
        // A phase that returns nothing costs the run no tick, so the only place it pauses is where an agent has to
        // be closed first. Returning a promise from the rest would let other work land between the agent starting
        // and its prompt being sent.
        onPhase: (p) => {
          if (p.at === "reuse") return void this.apply({ type: "choose", task: t.id, reuse: true });
          // Waited for only when there was one to close: an agent starts as soon as it can.
          if (p.at === "starting") return this.apply({ type: "choose", task: t.id, reuse: false }).closed;
          if (p.at === "started") return void this.apply({ type: "started", task: t.id, session: p.session });
          // In single-agent mode too: the next run takes the recorded conversation up again, which is where a
          // failed agent's work is.
          return this.apply({ type: "drop", task: t.id }).closed;
        },
        stopped: () => this.isStopped,
      });
      const res = report.res;
      const a = report.session;
      if (report.aborted || this.stopped) return; // `stop` cleans up
      const ref: TaskAgent | undefined = a?.sessionId ? { engine: choice.engine.name, model: choice.model, session: a.sessionId } : undefined;
      // Its reply, checked, becomes the task's suggestion (`suggest.ts`); a run that failed counts towards giving up.
      const outcome: RunOutcome = await withLock(id, () => readModifyWrite(id, (src) => {
        if (src === null) return { result: { done: "nothing" } as RunOutcome };
        // A task's run is never given the `comment` tool, so its reply is always a task's (`taskReply`).
        const f = finishRun(src, t, page, res.ok ? { reply: taskReply(res.reply) ?? res.result, ...(ref && { agent: ref }) } : { error: res.error ?? "error" });
        return { file: f.file, result: f.outcome };
      })).catch((e: any): RunOutcome => ({ done: "failed", error: why(e), failures: 0 }));
      const finishedAt = Date.now();
      const endHash = pageHash(id);
      const ok = res.ok && outcome.done !== "failed";
      const error = outcome.done === "failed" ? outcome.error : res.error ?? "error";
      if (!ok) failed = error;
      this.say("end", { run: r.n, task: t.id, durationMs: finishedAt - started, ok, outcome: outcome.done, result: clip(res.result, DETAIL), costUsd: res.costUsd, ...(report.costUnknown && { costUnknown: true }), ...(ok ? {} : { error }) });
      // The agent stays for the writer's next word on its suggestion (an ask again, the chat); otherwise it is done.
      // In single-agent mode it stays whatever this run came to: it is the page's agent, and the next request is its
      // next turn. It is recorded, so a turn after it has snoozed takes the same conversation up again. The task is
      // not sent again until the cleanup below is done (`release`).
      await this.apply({ type: "runEnd", task: t.id, at: finishedAt, outcome: outcome.done, ...(ref && { ref }), solo: { told: [...told], turns: turns + 1 } }).closed;
      if (single && ref) await this.recordSolo(ref);
      // Nobody works on what this run acknowledged any more (the other runs keep theirs), and a block it broke is reported.
      const ids = await resetStaleAcks(id, new Set(this.runs().map(([task]) => task))).catch(() => []);
      if (ids.length) this.say("warning", { run: r.n, message: `The run left ${ids.length} request(s) acknowledged but unfinished: moved back to waiting.` });
      if ((repairs.get(id) ?? 0) > repairsAtStart) this.say("warning", { run: r.n, message: "The run broke the comments block: the last good one was kept, and the broken file saved as .bad-block." });
      // The page as the run left it (after the reset, if there was one): a change the writer makes from now on counts.
      this.apply({ type: "release", task: t.id, gate: ok ? { until: 0, hash: ids.length ? pageHash(id) : endHash } : { until: Date.now() + gapMs() } });
    })().catch((e) => {
      // Something none of the above expected: the run counts as failed, its task is tried again after the gap.
      failed = why(e);
      this.apply({ type: "crash", task: t.id, at: Date.now() });
      this.say("error", { run: r.n, message: `The run on ${t.id} failed: ${failed}` });
      void resetStaleAcks(id, new Set(this.runs().map(([task]) => task))).catch(() => []);
    }).finally(() => {
      runEnded(id, t.id, failed ? { error: failed } : {});
      // A slot is free: this page's loop, and any other waiting on the server's limit, may start a run.
      for (const p of runtime().pages.values()) p.nudge();
    });
  }

  /**
   * One review, as a job of the page's agents: it takes a run slot like any run, its
   * steps go to the page's stream so the writer can see it working, and stopping the page's agents stops it. It is
   * not a task — there is no marker and no record — so it is not in `agentMachine`; it is page state of its own,
   * which is why `reading` is a field here rather than a transition there.
   *
   * At most one at a time per page. A second asks to wait rather than queueing: the writer pressed the button twice.
   */
  private reading: Promise<ReviewResult> | null = null;
  read(): Promise<ReviewResult> {
    const { id } = this;
    // Said on the page's stream as well as answered, so a review that never happened is in the panel with its
    // reason, rather than being a button that did nothing.
    const none = (reason: string, error: string): Promise<ReviewResult> => {
      this.say("skip", { run: 0, task: REVIEW, reason });
      return Promise.resolve({ placed: [], replaced: [], judged: [], error });
    };
    if (this.reading) return none("reading", "This page is being read already.");
    if (this.isStopped) return none("stopped", "This page's agents are stopped.");
    // The same gates a task's run passes, so a review cannot crowd out the work or outrun the limits.
    if (this.runCount >= concurrency()) return none("busy", "This page's agents are busy: try again when a run has finished.");
    if (runsEverywhere() >= maxRuns()) return none("busy", "The server is at its limit of runs: try again in a moment.");

    const r: RunLog = { n: ++this.n, taskType: REVIEW, model: this.model, startedAt: Date.now(), said: [] };
    const started = Date.now();
    const job = (async (): Promise<ReviewResult> => {
      const choice = parseChoice(this.model);
      if (!choice) return { placed: [], replaced: [], judged: [], error: `No engine runs the model ${this.model}.` };
      const unavailable = choice.engine.unavailable();
      if (unavailable) return { placed: [], replaced: [], judged: [], error: unavailable };
      this.say("start", { run: r.n, task: REVIEW, taskType: REVIEW, model: choice.choice, engine: choice.engine.name });

      // The driver: the run itself is `runOnce`, as a task's is, but the bookkeeping around it is a review's — no
      // ack, no record, no agent kept. Everything it does is reported on the page's own stream.
      const drive: ReviewDriver = async (_id, spec) => {
        const steps: AgentStep[] = [];
        let session: AgentSession | undefined;
        const report = await runOnce({
          id,
          choice,
          start: spec.start,
          prompt: spec.prompt,
          workspace: () => ({ file: pageFile(id), images: imagesDir(id), root: root(), scratch: this.scratch }),
          timeoutMs: spec.timeoutMs,
          check: spec.check,
          onStep: (s) => { steps.push(s); this.say("step", { run: r.n, task: REVIEW, ...s }); },
          onPhase: (p) => { if (p.at === "started") session = p.session; return null; },
          stopped: () => this.isStopped,
        });
        // A review keeps no conversation: its agent is closed, exactly once, whatever the run came to.
        await session?.close().catch(() => {});
        return { ...reviewRunOf(report.res, steps), model: choice.choice };
      };

      return await reviewPage(id, drive);
    })();

    this.reading = job
      .then((out) => {
        const ok = !out.error;
        // What became of every question it raised, stage by stage: the one thing that answers "why so few?".
        if (ok) {
          const dropped = out.judged.filter((j) => j.outcome !== "shown");
          const tally = dropped.reduce<Record<string, number>>((a, j) => ({ ...a, [j.outcome]: (a[j.outcome] ?? 0) + 1 }), {});
          const why = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ");
          this.say("read", {
            run: r.n, task: REVIEW,
            message: `${out.judged.length} question(s) raised · ${out.placed.length} in the margin${out.replaced.length ? ` · ${out.replaced.length} replaced` : ""}${why ? ` · dropped: ${why}` : ""}`,
          });
        }
        this.say("end", {
          run: r.n, task: REVIEW, durationMs: Date.now() - started, ok, outcome: ok ? "read" : "failed",
          result: ok ? `${out.placed.length} question(s) in the margin` : "", costUsd: out.costUsd,
          ...(ok ? {} : { error: out.error }),
        });
        return out;
      })
      .catch((e: any): ReviewResult => {
        const error = why(e);
        this.say("error", { run: r.n, message: `The review failed: ${error}` });
        return { placed: [], replaced: [], judged: [], error };
      })
      .finally(() => {
        this.reading = null;
        // A slot is free, and the page has new comments: this page's loop and any other may move on.
        for (const p of runtime().pages.values()) p.nudge();
      });
    return this.reading;
  }

  /** Whether a review is in flight, for the stream's hello and the route. */
  get isReviewing() {
    return this.reading !== null;
  }

  /**
   * Whether the page's agents may stop: no tab, no run, no agent waiting or in the chat, and no task that will
   * be sent without the page changing (one whose run failed is tried again after the gap). With a limit reached
   * (cost, or runs on an engine that reports no cost), nothing will be sent.
   */
  private restful(waiting: Target[], idle: string | undefined) {
    if (this.listeners.size || this.runCount || keptList(this.tasks).length || chatting(this.id).size) return false;
    if (this.reading) return false; // a review in flight is this page's work too
    if (idle === "nothing pending" || idle === "cost" || idle === "runs") return true;
    return idle === "unchanged" && waiting.every((t) => { const a = this.tasks.get(t.id); return a !== undefined && gateOf(a)?.hash !== undefined; });
  }

  /**
   * Sends each pending task a run once the page has stopped changing, up to `AGENT_CONCURRENCY` at once; one
   * whose run failed after the gap, and one whose run ended but left it waiting once the page has changed since. A
   * look that fails is reported and the loop goes on. The loop only feeds the machine and picks the tasks ready.
   */
  private async loop() {
    const { id } = this;
    let model = this.model;
    // No run is working on the page yet, so an `:ack` in it was left by an earlier one.
    const leftover = await resetStaleAcks(id).catch(() => []);
    if (leftover.length) this.say("warning", { run: 0, message: `${leftover.length} request(s) were left acknowledged by an earlier run: moved back to waiting.` });
    // The page as last seen, and since when it has not changed. The first look needs no quiet time.
    let seen = pageHash(id);
    let quietSince = -Infinity;
    while (!this.stopped) {
      this.poked = false;
      this.looks++;
      try {
        if (this.model !== model) { model = this.model; this.say("model", { model }); }
        // Looked at once a turn (parsed again only when the file changed).
        const view = pageView(id);
        const hash = view.hash;
        if (hash !== seen) { seen = hash; quietSince = Date.now(); }
        const now = Date.now();
        // A kept agent whose task left the page (accepted, rejected, deleted) has nothing more to do. The
        // page's one agent stays: its next turn may be anywhere on the page, and it waits for one like any other.
        if (view.ids && keptList(this.tasks).length) this.apply({ type: "seen", ids: view.ids });
        // One the writer is chatting about waits for the chat to end: the chat has its agent.
        const known = new Set(plugins().map((p) => p.taskType));
        const state = (task: string) => this.tasks.get(task) ?? PENDING;
        const waiting = view.pending.filter((t) => { const a = state(t.id); return known.has(t.taskType) && !isRun(a) && a.s !== "chatting"; });
        const ready = waiting.filter((t) => isReady(state(t.id), now, hash));
        // Slots free on the page, and on the server.
        const runs = this.runCount;
        const free = Math.min(concurrency() - runs, maxRuns() - runsEverywhere());
        let idle: string | undefined;
        if (!ready.length) idle = runs ? undefined : waiting.length ? "unchanged" : "nothing pending";
        else if (now - quietSince < settleMs()) idle = "settling"; // the writer may still be typing
        else if (engines().every((e) => !!e.unavailable())) idle = "no engine"; // nothing could run it: not a failed run, so no retries and no decline
        else if (overBudget()) idle = "cost"; // AGENT_COST_LIMIT_USD reached: no new run
        // An engine that never says what a run cost passes every dollar limit, so its runs are bounded by count
        // instead (`AGENT_MAX_UNMETERED_RUNS_DAY`). Read for the page's own engine: a task whose recorded agent is on
        // another one is rare, and a metered engine is bounded by the dollar limits anyway.
        else if (overRuns(parseChoice(this.model)?.engine)) idle = "runs";
        else if (singleAgent() && [...this.tasks.values()].some((a) => a.s === "chatting")) idle = "chat"; // the page's one agent is the chat's until it ends
        else if (free > 0) {
          for (const t of ready.slice(0, free)) this.launch(t);
          this.idle = undefined;
          continue;
        } else if (runs < concurrency()) idle = "busy"; // other pages' runs fill the server's limit
        if (idle && idle !== this.idle) this.say(idle === "settling" ? "settling" : "skip", { run: 0, ...(idle === "settling" ? {} : { reason: idle }) });
        this.idle = idle;
        if (this.restful(waiting, idle)) {
          void this.stop("nothing left to do");
          break;
        }
        await this.nap(this.sleepFor(now, idle, quietSince));
      } catch (e) {
        this.say("error", { run: 0, message: `The agent loop: ${why(e)}` });
        await this.nap(1000);
      }
    }
  }
}
