import type { ChatEvent, ChatMessage } from "../../shared/chat";
import type { AnyReply } from "../suggest";
import type { ReplyTool } from "./replyTools";

/**
 * An agent engine: something that can work through a page's tasks when prompted. The loop in `agent.ts` owns
 * everything about when to run (settling, pending work, stale acks, the stream); an engine only starts an agent, runs
 * one prompt at a time on it, reports its steps, and stops it. Built-ins are in `engines/`, registered by
 * `engines/index.ts`.
 */

/** One thing the agent did, as a short line for the debug panel; `detail` is the longer form the margin note shows on hover. */
export interface AgentStep {
  /** `error`: something the writer should know went wrong, such as a permission prompt nobody can answer. */
  kind: "init" | "text" | "tool" | "tool_result" | "error";
  text: string;
  detail?: string;
  /** A tool call: the tool, and what it is about (a path, a command, a pattern). */
  name?: string;
  brief?: string;
}

/**
 * How one run ended: `result` is the agent's whole last reply. `reply` is the result it gave with a reply tool
 * (`replyTools.ts`), the last call that counted; without one, the result is read from `result`'s envelope. `costUsd` is
 * what this run cost, when the engine knows.
 */
export interface RunResult { ok: boolean; result: string; reply?: AnyReply; costUsd?: number; error?: string }

/** What one run is told besides its prompt. */
export interface RunOptions {
  /** Checks a reply tool's call against the page the run read: why it can't be used, or null when it can. */
  check?(reply: AnyReply): string | null;
}

/** What an engine is told when it starts an agent for a page. */
export interface StartOptions {
  /** The page's id and its file (the only file the agent may write). */
  id: string;
  file: string;
  /** The page's own image folder (`<docs>/images/<id>/`, made before the agent starts): the only other place it may write. */
  images: string;
  /** Where Solipsist runs: the agent may read all of it. */
  root: string;
  /** An empty directory of its own, removed when the stream closes: the agent's working directory. */
  scratch: string;
  /** One of the engine's model ids. */
  model: string;
  /** The instructions every run follows (the protocol), for the agent's system prompt: added to it, not replacing it. */
  system: string;
  /**
   * The reply tools (`replyTools.ts`) the agent gets, to give its result with: `true` for a task's set
   * (`REPLY_TOOLS`), or a set of its own — a review passes `REVIEW_TOOLS`, which has no `suggest` in it, so the
   * agent cannot propose page text at all. An engine may not offer reply tools; then the envelope is used instead.
   */
  replyTools?: boolean | readonly ReplyTool[];
  /** Files outside `root` the agent may read (the image guide, when it is the writer's own). */
  readable?: string[];
  /** A conversation to continue (an `AgentSession.sessionId` of this engine) instead of starting one. */
  resume?: string;
  onStep(step: AgentStep): void;
  /** The agent's work as it streams (text as it comes, tool calls, what each reply cost), for the chat. Optional. */
  onStream?(e: ChatEvent): void;
}

/** One live agent: it keeps its conversation between runs, until it is closed or dies. */
export interface AgentSession {
  /**
   * Set by an engine that keeps the conversation on disk, so it outlives `close()`: its id, for `resume`. Such an
   * agent is kept after its run, waits, and snoozes; one without is closed.
   */
  readonly sessionId?: string;
  /** Whether it continues the conversation it was asked to `resume` (false: that one was not found, so it is new). */
  readonly resumed?: boolean;
  /** Sends one prompt and resolves when the run has ended. One run at a time. */
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  /** The conversation so far, for the chat (an engine that keeps conversations). */
  history?(): ChatMessage[];
  /** Stops the run in flight, keeping the agent and its conversation. */
  abort?(): Promise<void>;
  /**
   * Adds `prompt` to the run in flight (the writer's word mid-reply, in a chat): the agent reads it after its current
   * step, before it next calls the model, and the run answers it before it ends. False when no run is in flight (it
   * ended meanwhile): send it as a run of its own. An engine without it can only be stopped mid-run.
   */
  steer?(prompt: string): Promise<boolean>;
  /** Resolves, with what went wrong, if the agent dies on its own (whether a run is in flight or not). */
  readonly died: Promise<string>;
  /** Stops the agent and anything it runs; resolves once nothing of it is left. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A model an engine offers, as the picker shows it. Beyond its id and title, whatever the engine knows: the vendor it
 * groups under, how much it holds, what a million tokens cost, and a word about why it is worth picking.
 */
export interface EngineModel {
  id: string;
  title: string;
  /** The group it is listed under when the picker searches (`DeepSeek`, `OpenAI`); the engine's title when absent. */
  vendor?: string;
  /** Its context window, in tokens. */
  context?: number;
  /** Dollars per million tokens, in and out. */
  inUsd?: number;
  outUsd?: number;
  /** A few words beside it in the list ("Pi's own default"). */
  note?: string;
}

export interface AgentEngine {
  /** Its id, the part before the colon in a model choice (`pi:<provider>/<model>`). */
  name: string;
  /** What the model picker calls it. */
  title: string;
  /** The models the picker offers at a glance (a shortlist), the first being its default. */
  models(): readonly EngineModel[];
  /** Every model it could run, for the picker's search. Absent: `models()` is all of them. */
  catalog?(): readonly EngineModel[];
  /** Whether it can run this model id. Absent: its lists decide. */
  knows?(model: string): boolean;
  /** Reads whatever its lists need (a model catalog on disk), once. Awaited before the lists are sent. */
  warm?(): Promise<void>;
  /** Whether its agents keep a conversation the writer can chat with, and look in on while they run. */
  chats?: boolean;
  /** Whether it offers the reply tools (`StartOptions.replyTools`); without them its agents are told the envelope. */
  replyTools?: boolean;
  /**
   * Whether it reports what every run cost (`RunResult.costUsd`). False, the default, means the dollar limits
   * (`agent.cost_limit_*`) can't see its runs at all, so `agent.max_unmetered_runs_day` bounds them by count
   * instead and the panel says the cost isn't known rather than showing nothing.
   */
  reportsCost?: boolean;
  /**
   * Whether the commands its agents run are confined: writes limited to the page's image folder, no network but
   * localhost. False, the default, means a run can do whatever the writer can. Pi's Bash is not confined. It used to decide who may take work nobody is watching; the
   * writer has since chosen (2026-11-10) to let scheduled buttons run on any engine (`schedules.ts`), so it is reported
   * and nothing is refused on it now.
   */
  confined?: boolean;
  /** Why it cannot run now (a missing key, say), or null when it can. */
  unavailable(): string | null;
  start(o: StartOptions): Promise<AgentSession>;
}

export const DETAIL = 4000;
export const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** What a tool call is about, in a word or a path: the file, the command, the pattern. */
export const brief = (input: any) => String(input?.file_path ?? input?.command ?? input?.pattern ?? input?.path ?? input?.description ?? "");
