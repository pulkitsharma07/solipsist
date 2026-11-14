import { mkdirSync } from "node:fs";
import type { ChatEvent } from "../../shared/chat";
import { why } from "../log";
import type { AnyReply } from "../suggest";
import { noteUnmeteredRun, spend } from "./budget";
import type { AgentEngine, AgentSession, AgentStep, RunResult, StartOptions } from "./engine";
import { instructions } from "./page";

/**
 * One run on one agent: the part of a run that is the same whoever asked for it.
 *
 * It starts the agent or takes one that is already up, sends it the prompt, waits for whichever comes first — the
 * reply, the agent dying, or the time limit — and accounts for what the run cost. Nothing about a page is in here: the
 * caller acknowledges the task, builds the prompt, decides what to do with the reply and keeps or drops the agent.
 * `PageAgents.launch` is the caller today; work triggered by something other than a marker gets the same run without
 * the marker bookkeeping it has no use for.
 *
 * The caller's own state machine is told where the run has got to through `onPhase`, so the transitions stay with the
 * caller that owns them.
 */

/** Where a run has got to, for the caller's own bookkeeping. */
export type RunPhase =
  /** The agent handed in as `reuse` is being used as it is. */
  | { at: "reuse" }
  /** A fresh agent is wanted. What this returns is awaited first, so an agent being closed is gone before the next starts. */
  | { at: "starting" }
  | { at: "started"; session: AgentSession }
  /** The agent is done with: it failed, or it keeps no conversation. The caller closes it. */
  | { at: "dropped" };

/** The places a run may read and write: the page's file, its own image folder, the project, and a folder of its own. */
export interface RunWorkspace { file: string; images: string; root: string; scratch: string }

export interface RunRequest {
  /** The page the run is for, as the engine names its agent's working folder and sessions. */
  id: string;
  choice: { engine: AgentEngine; model: string };
  /**
   * What the run is sent, built when the agent is ready rather than before: starting one takes a moment, and the
   * prompt carries the page as it is now. Called once, and only if the run gets that far.
   */
  prompt(): string;
  /** Called once, only when an agent is started: it may make folders, so it is not asked for on the reuse path. */
  workspace(): RunWorkspace;
  /** An agent already up whose conversation this run continues (an ask again). Absent: one is started. */
  reuse?: AgentSession;
  /** A conversation on disk for a fresh agent to take up (an `AgentSession.sessionId` of this engine). */
  resume?: string;
  /** How long the run may take before the agent is stopped and the run counted as failed. */
  timeoutMs: number;
  /** Checks a reply tool's call against the page the run read, so a call that can't be used is fixed in the same turn. */
  check?(reply: AnyReply): string | null;
  /**
   * What the agent is started with, when a task's instructions are the wrong ones: a review passes its own system
   * prompt and `REVIEW_TOOLS`, which has no `suggest` in it. Absent: `instructions(engine)`, the task protocol.
   */
  start?: Pick<StartOptions, "system" | "readable" | "replyTools">;
  onStep(s: AgentStep): void;
  onStream?(e: ChatEvent): void;
  /**
   * Told where the run has got to, for the caller's own state machine. It is awaited only when it returns a promise,
   * so a phase the caller handles synchronously costs the run no tick: a phase boundary is not a point where other
   * work may interleave unless the caller asks the run to wait there (an agent being closed in this one's place).
   */
  onPhase(p: RunPhase): void | Promise<void> | null;
  /** Whether the caller has given up (the page's agents stopped): the agent is closed and the run says nothing more. */
  stopped(): boolean;
}

export interface RunReport {
  res: RunResult;
  /** The agent, when it is still worth keeping: it ran and keeps its conversation. Undefined: dropped, or never started. */
  session?: AgentSession;
  /**
   * The run said nothing about what it cost, so no dollar limit saw it; it was counted against
   * `agent.max_unmetered_runs_day` instead. The caller puts it on its `end` event, so the panel says the cost isn't
   * known rather than showing nothing.
   */
  costUnknown?: true;
  /** The caller gave up while the agent was starting: it has been closed, and there is nothing to report. */
  aborted?: true;
}

/** A finite cost of zero or more: what `spend` can do something with. A missing or nonsense one means nobody knows. */
const metered = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;

/**
 * Tells the caller where the run is, and gives back whatever it asked to be waited for (nothing, usually). Not an
 * `async` function on purpose: `await`ing one costs a tick even when it awaits nothing inside, and a tick between the
 * agent starting and its prompt being sent is a window other work can land in. Call it as
 * `const wait = phase(…); if (wait) await wait;`.
 */
const phase = (req: RunRequest, p: RunPhase): Promise<void> | undefined => req.onPhase(p) || undefined;

/** The reply, the agent dying, or the time limit: whichever comes first. */
async function race(agent: AgentSession, req: RunRequest, prompt: string): Promise<RunResult> {
  let timer: Timer | undefined;
  const limit = req.timeoutMs;
  const timedOut = new Promise<RunResult>((done) => {
    timer = setTimeout(() => done({ ok: false, result: "", error: `Timed out after ${Math.round(limit / 1000)}s: the agent was stopped.` }), limit);
  });
  try {
    return await Promise.race([
      agent.run(prompt, { ...(req.check && { check: req.check }) }),
      agent.died.then((gone): RunResult => ({ ok: false, result: "", error: gone })),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runOnce(req: RunRequest): Promise<RunReport> {
  const { engine, model } = req.choice;
  let agent: AgentSession | undefined;
  let res: RunResult;
  try {
    if (req.reuse) {
      const waitReuse = phase(req, { at: "reuse" });
      if (waitReuse) await waitReuse;
      agent = req.reuse;
    } else {
      // The one phase the caller does make the run wait on: an agent being closed in this one's place is gone first.
      const waitFree = phase(req, { at: "starting" });
      if (waitFree) await waitFree;
      const w = req.workspace();
      // Made now: the sandbox lets the agent write in the image folder, not create it.
      mkdirSync(w.images, { recursive: true });
      agent = await engine.start({
        id: req.id, file: w.file, images: w.images, root: w.root, scratch: w.scratch, model,
        ...(req.start ?? instructions(engine)), ...(req.resume && { resume: req.resume }),
        onStep: req.onStep, ...(req.onStream && { onStream: req.onStream }),
      });
      const waitStarted = phase(req, { at: "started", session: agent });
      if (waitStarted) await waitStarted;
    }
    // Given up on while the agent was starting: it is closed here, since the caller never heard of it.
    if (req.stopped()) {
      await agent.close().catch(() => {});
      return { res: { ok: false, result: "", error: "stopped" }, aborted: true };
    }
    res = await race(agent, req, req.prompt());
    // Only an agent that did its run and keeps its conversation is worth keeping; any other is done with.
    if (!res.ok || !agent.sessionId) {
      const waitDrop = phase(req, { at: "dropped" });
      if (waitDrop) await waitDrop;
      agent = undefined;
    }
  } catch (e: any) {
    res = { ok: false, result: "", error: why(e) };
    if (agent) { const waitDrop = phase(req, { at: "dropped" }); if (waitDrop) await waitDrop; }
    agent = undefined;
  }
  // One or the other, never both: the dollar limits see a run that said what it cost, and the run limit sees one
  // that didn't, so nothing an engine does leaves a run unaccounted for.
  const known = metered(res.costUsd);
  if (known) spend(res.costUsd);
  else noteUnmeteredRun();
  return { res, ...(agent && { session: agent }), ...(known ? {} : { costUnknown: true as const }) };
}
