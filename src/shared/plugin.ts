import type { TaskState } from "./docfile/markers";

/**
 * Task type plugins. A plugin adds a type of task: a request the writer leaves in the page for the agent,
 * written to the markdown as HTML comments. The core knows two shapes, and a plugin picks one:
 *
 * - `point`: a marker at the caret, `<!-- type:abc -->` (like `gen`).
 * - `range`: around the selected text, `<!-- type:abc -->the text<!-- /type:abc -->` (like `sel`).
 *
 * Everything else (parsing and writing the comments, the node and mark in the page, states, records, merging, the
 * loaders) is the core's, the same for every task type. A plugin is plain data shared by the server and the browser, so it
 * imports neither. Built-in plugins live in `src/plugins/<taskType>/`, with the agent's instructions for the task type in
 * `prompt.md`, and are registered by `src/plugins/index.ts`. What the server does with a task type (its prompt, the
 * replies it takes, where its suggestion may go) is its server half, `TaskTypeServer` in `src/server/taskTypes.ts`, in
 * the plugin's `server.ts`.
 */
export type MarkerShape = "point" | "range";

/** The built-in pictures for a state: a slow blink, a spinner, nothing. */
export type IndicatorName = "blink" | "spinner" | "none";

export interface PopupContext {
  id: string;
  taskType: string;
  state: TaskState;
  close(): void;
}

export interface PopupDef {
  /** "auto": opens by itself when a live task reaches this state. Either way a click on the picture opens it. */
  opens: "auto" | "click";
  render(ctx: PopupContext): HTMLElement;
}

/** What the page shows for one state. Any field left out takes the default. */
export interface PhaseDef {
  /** Tooltip and accessible name. */
  label?: string;
  /** A built-in picture, or a function that makes a fresh one each time the state is entered (browser only). */
  indicator?: IndicatorName | (() => Element);
  popup?: PopupDef;
}

export interface TaskTypePlugin {
  /** The comment's prefix, `<!-- type:abc -->`: a lower case letter, then letters, digits or `-`. */
  taskType: string;
  shape: MarkerShape;
  /** What the writer calls it (the settings dialog's prompt list); the page's own labels are the same for every type. */
  title: string;
  /**
   * Keys that make one, in Tiptap's notation (`Mod-.`). A point is made at a caret and a range from a selection, so a
   * point plugin and a range plugin may share a key; two plugins of the same shape may not.
   */
  keys?: string[];
  /**
   * A range task type: what the range is around. `text` (the default) is the writer's selected text. `image` is one image
   * in the page: its key acts on a selection that holds nothing but an image, and the page offers it there (`img`).
   * A text task type and an image task type may share a key, as a point task type and a range task type may.
   */
  subject?: "text" | "image";
  /**
   * Whether the writer says what they want in words, kept on the opening comment (`<!-- sel:abc "make it shorter" -->`):
   * never, if they like, or always. Default: `none`, and then a comment with an instruction is not a task.
   */
  instruction?: "none" | "optional" | "required";
  /** A range task type whose result may be accepted as a button, to run the task again later. Default: no. */
  reusable?: boolean;
  /** The instruction input's placeholder text ("Ask or tell the agent…"). */
  inputLabel?: string;
  /** How the review pane shows a point (a range shows its text between ⟦ ⟧). Default: `[type]`. */
  reviewText?: string;
  /** What the page shows per state. Default: a slow blink while pending, a spinner when acknowledged, nothing when done. */
  phases?: Partial<Record<TaskState, PhaseDef>>;
}

export const TASK_TYPE_RE = /^[a-z][a-z0-9-]{0,15}$/;

/** Typed identity: `export default definePlugin({ … })` in a plugin's `index.ts`. */
export const definePlugin = (plugin: TaskTypePlugin) => plugin;

const registry = new Map<string, TaskTypePlugin>();

/** What a plugin's key acts on: a point at the caret, a range around text, or a range around an image. */
export const targetOf = (p: TaskTypePlugin) => (p.shape === "point" ? "point" : p.subject === "image" ? "image" : "text");

/**
 * Makes a task type known to the parser, the editor and the agent. Registering a task type again replaces it (a hot reload
 * re-runs `src/plugins/index.ts`). Throws on a bad task type, or a key another plugin that acts on the same thing
 * (`targetOf`) already uses.
 */
export function registerPlugin(plugin: TaskTypePlugin): TaskTypePlugin {
  if (!TASK_TYPE_RE.test(plugin.taskType)) throw new Error(`Placeholder kind "${plugin.taskType}" must match ${TASK_TYPE_RE}.`);
  for (const other of registry.values()) {
    if (other.taskType === plugin.taskType || targetOf(other) !== targetOf(plugin)) continue;
    const key = plugin.keys?.find((k) => other.keys?.includes(k));
    if (key) throw new Error(`"${plugin.taskType}" and "${other.taskType}" would both make a ${targetOf(plugin)} placeholder with ${key}.`);
  }
  registry.set(plugin.taskType, plugin);
  return plugin;
}

/** Tests only: forgets a task type registered for the test. */
export const unregisterPlugin = (taskType: string) => void registry.delete(taskType);

/** Every registered plugin, in the order they were registered. */
export const plugins = (): TaskTypePlugin[] => [...registry.values()];
export const pluginFor = (taskType: string): TaskTypePlugin | undefined => registry.get(taskType);
