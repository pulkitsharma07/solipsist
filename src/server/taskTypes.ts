import type { Node as PMNode } from "@tiptap/pm/model";
import type { SuggestionMode, SuggestionPlace, TaskRecord } from "../shared/docfile";
import { pluginFor, type TaskTypePlugin } from "../shared/plugin";

/**
 * The server half of a task type: what the agent is told about it, which replies it takes and
 * where its suggestions may go. The browser half is `TaskTypePlugin` (`src/shared/plugin.ts`: shape, keys, phases,
 * instruction); this one is server only, so the page's bundle never pulls it in. Built-in ones are
 * `src/plugins/<taskType>/server.ts`, registered by `src/plugins/server.ts` (never imported by `src/plugins/index.ts`,
 * which the browser loads).
 *
 * A task type registered with a browser half only gets `defaultServer`: today's behaviour for any task type (its
 * `type.<type>` prompt, every reply tool, a point's suggestion `at` it and a range's `after` it).
 *
 * This module imports nothing of the server's at run time, so a plugin's `server.ts` can import it without a cycle.
 */

/** A reply tool's name (`agent/replyTools.ts`), and so the kind of reply it gives. */
export type ReplyToolName = "suggest" | "answer" | "decline";
export const ALL_REPLY_TOOLS: readonly ReplyToolName[] = ["suggest", "answer", "decline"];

/** The task a run works on, as the prompt and the checks name it. */
export interface TaskRef { id: string; taskType: string; instruction?: string }

/** What `prompt` is given: the page and the run's task, and the task type's prompt as it is now (the writer's, or `instructions`). */
export interface PromptContext {
  pageId: string;
  /** The run's own task; the task type being described may be another one waiting on the page. */
  target: TaskRef;
  /** The `type.<type>` prompt as it is now. */
  text: string;
}

/** What `check` and `finish` are given: the page the run read, its task, and the record fields the shared checks made. */
export interface ReplyContext {
  /** The body the run read, with the task at `:ack`. */
  page: string;
  doc: PMNode;
  target: { id: string; taskType: string };
}

/** The record fields a checked reply adds (see `checkReply` in `suggest.ts`). */
export type Checked = Pick<TaskRecord, "status" | "mode" | "place" | "suggestion" | "edits" | "answer" | "saw" | "note">;

export interface TaskTypeServer {
  /** The same name as its browser half's. */
  taskType: string;
  /** The built-in text of its `type.<type>` prompt (the writer may edit it in the settings). Default: none. */
  instructions?: string;
  /** What a run is told about this task type. Default: its `type.<type>` prompt (`ctx.text`). */
  prompt?(ctx: PromptContext): string;
  /** The replies a run on it may give (by reply tool, or the same in the envelope). Default: all of them. */
  tools?: readonly ReplyToolName[];
  /** Where its suggestion may go: `at` a point, `replace` a range's text or `after` it. */
  modes: readonly SuggestionMode[];
  /** Whether its suggestion may be `inline` text, whole `blocks`, or either (the default). */
  places?: readonly SuggestionPlace[];
  /** Checks of its own, after the shared ones passed: why the reply can't be used, or null. */
  check?(checked: Checked, ctx: ReplyContext): string | null;
  /** The record fields to write for a checked reply. Default: as the shared checks made them. */
  finish?(checked: Checked, ctx: ReplyContext): Checked;
  /** A model this task type does best on (an `engine:model` choice). Not read yet. */
  modelHint?: string;
  /** Whether a run on it may create tasks (item 7). Default false; not read yet. */
  mayCreate?: boolean;
}

/** Typed identity: `export default defineTaskTypeServer({ … })` in a plugin's `server.ts`. */
export const defineTaskTypeServer = (s: TaskTypeServer) => s;

const registry = new Map<string, TaskTypeServer>();

/** Makes a task type's server half known. Registering it again replaces it (a hot reload). */
export function registerTaskTypeServer(s: TaskTypeServer): TaskTypeServer {
  registry.set(s.taskType, s);
  return s;
}
/** Tests only: forgets a server half registered for the test. */
export const unregisterTaskTypeServer = (taskType: string) => void registry.delete(taskType);

/** What a task type with no server half of its own does: the behaviour every task type had before they had one. */
export const defaultServer = (p: TaskTypePlugin): TaskTypeServer => ({
  taskType: p.taskType,
  modes: p.shape === "point" ? ["at"] : ["after"],
});

/** The server half of a registered task type: its own, or the default. Undefined when the task type isn't registered. */
export function taskTypeServer(taskType: string): TaskTypeServer | undefined {
  const p = pluginFor(taskType);
  if (!p) return undefined;
  return registry.get(taskType) ?? defaultServer(p);
}

/** The reply tool a reply came from (or would have, as an envelope). */
export const toolOf = (kind: "suggestion" | "answer" | "decline"): ReplyToolName => (kind === "suggestion" ? "suggest" : kind);
