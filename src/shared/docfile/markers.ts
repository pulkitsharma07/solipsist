import { pluginFor } from "../plugin";
import "../../plugins"; // the built-in kinds
import { TASK_ID_SOURCE } from "../ids";

/**
 * Markers are HTML comments in the markdown, of a task type some plugin registered (`src/shared/plugin.ts`): a point
 * `<!-- gen:abc -->` (a spot), or a range `<!-- sel:abc -->selected text<!-- /sel:abc -->` (text to act on). The markdown
 * parser turns HTML comments into literal text, so they travel through it as private-use characters around a part
 * letter, the task type and the id, and are swapped for nodes and marks on the way in and out. Text the writer types can't
 * fake one: the serializer writes `<` as `&lt;`. A comment of a task type nobody registered is not a marker.
 *
 * A task type that takes an instruction (`TaskTypePlugin.instruction`) may carry one on its opening comment, after the
 * state: `<!-- sel:abc:ack "make this punchier" -->`. It is escaped (`escapeInstruction`), so it can't end the
 * comment, and is one line. A range over several blocks writes it on its first opening comment only. On any other
 * comment (another task type, a closing one) a payload means it is not a marker.
 */
export const OPEN = "";
export const CLOSE = "";

/** p: a point. s / e: the start and end of a range. */
export type MarkerPart = "p" | "s" | "e";

/**
 * Where a marker is in its life. Someone edits the comment in the markdown file to move it on:
 * `<!-- gen:abc -->` (pending) → `<!-- gen:abc:ack -->` (acknowledged, being worked on) → `<!-- gen:abc:sug -->`
 * (the agent's suggestion, kept in the marker's record, waits for the writer). `:done` is an older end state.
 * A range carries the state on both comments; when they disagree the opening one wins.
 *
 * `:btn`: the writer accepted the result as a button. The range is around that result,
 * and pressing the button moves it back to pending.
 */
export const STATES = ["pending", "ack", "sug", "done", "btn"] as const;
export type TaskState = (typeof STATES)[number];
export const DEFAULT_STATE: TaskState = "pending";

/** The comment's suffix for each state (pending has none), and the one-letter code the state has inside a marker. */
const SUFFIX: Record<TaskState, string> = { pending: "", ack: ":ack", sug: ":sug", done: ":done", btn: ":btn" };
const CODE: Record<TaskState, string> = { pending: "", ack: "A", sug: "S", done: "D", btn: "B" };
const STATE_OF_CODE: Record<string, TaskState> = { "": "pending", A: "ack", S: "sug", D: "done", B: "btn" };
const STATE_OF_SUFFIX: Record<string, TaskState> = { "": "pending", ack: "ack", sug: "sug", done: "done", btn: "btn" };

/** A state read from anywhere (a node attribute, a data attribute): anything unknown is pending. */
export const asState = (x: unknown): TaskState => (STATES as readonly unknown[]).includes(x) ? (x as TaskState) : DEFAULT_STATE;
export const stateOfCode = (code: string | undefined) => STATE_OF_CODE[code ?? ""] ?? DEFAULT_STATE;

/**
 * An instruction as a comment holds it: one line, and nothing that could end the comment or be read as markup
 * (`&`, `"`, `<`, `>`, and a `-` after a `-`, as entities).
 */
export const escapeInstruction = (text: string) =>
  text.replace(/\s*[\r\n]+\s*/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/(?<=-)-/g, "&#45;");
export const unescapeInstruction = (text: string) =>
  text.replace(/&#45;/g, "-").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** An instruction inside a stand-in, as hex of its UTF-8: nothing the markdown parser or serializer would touch. */
const toHex = (text: string) => [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => new TextDecoder().decode(new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16))));

/** The comment for one part of a marker: `<!-- type:abc -->`, or a range's end `<!-- /type:abc -->`, with the state's suffix and, opening, the instruction. */
export const commentFor = (part: MarkerPart, taskType: string, id: string, state: TaskState = DEFAULT_STATE, instruction?: string | null) =>
  `<!-- ${part === "e" ? "/" : ""}${taskType}:${id}${SUFFIX[state]}${part !== "e" && instruction ? ` "${escapeInstruction(instruction)}"` : ""} -->`;
/** The private-use stand-in for that comment while the markdown parser or serializer runs. */
export const markerText = (part: MarkerPart, taskType: string, id: string, state: TaskState = DEFAULT_STATE, instruction?: string | null) =>
  `${OPEN}${part}${taskType}:${id}${CODE[state]}${part !== "e" && instruction ? `.${toHex(instruction)}` : ""}${CLOSE}`;
/** A stand-in: part, task type, id, state code and the instruction in hex (groups 1–5). */
export const MARKER_RE = new RegExp(`([pse])([a-z][a-z0-9-]*):(${TASK_ID_SOURCE})([ASDB]?)(?:\\.((?:[0-9a-f]{2})+))?`, "g");
/** The instruction a stand-in carries (its group 5), or undefined. */
export const instructionOfHex = (hex: string | undefined) => (hex ? fromHex(hex) : undefined);

/** Anything shaped like a marker comment: "/", task type, id, state suffix and instruction (groups 1–5). Whether it is one depends on the task type. */
const SHAPED_RE = new RegExp(`<!-- (\\/?)([a-z][a-z0-9-]*):(${TASK_ID_SOURCE})(?::(ack|sug|done|btn))?(?: "([^"\\r\\n]+)")? -->`, "g");

export interface MarkerComment {
  whole: string;
  index: number;
  part: MarkerPart;
  taskType: string;
  id: string;
  state: TaskState;
  /** What the writer asked, on an opening comment of a task type that takes an instruction. */
  instruction?: string;
}

/**
 * A comment shaped like a marker, as one: null unless its task type is registered, a closing comment only for a range,
 * and an instruction only on the opening comment of a task type that takes one.
 */
function asComment(whole: string, slash: string, taskType: string, id: string, suffix: string | undefined, payload: string | undefined, index: number): MarkerComment | null {
  const plugin = pluginFor(taskType);
  if (!plugin || (slash && plugin.shape !== "range")) return null;
  if (payload !== undefined && (slash || (plugin.instruction ?? "none") === "none")) return null;
  const c: MarkerComment = { whole, index, part: slash ? "e" : plugin.shape === "point" ? "p" : "s", taskType, id, state: STATE_OF_SUFFIX[suffix ?? ""]! };
  if (payload !== undefined) c.instruction = unescapeInstruction(payload);
  return c;
}

/** Every marker comment in a markdown source, in order. This reads the source as text: a comment in code is listed too. */
export function markerComments(markdown: string): MarkerComment[] {
  const out: MarkerComment[] = [];
  for (const m of markdown.matchAll(SHAPED_RE)) {
    const c = asComment(m[0], m[1]!, m[2]!, m[3]!, m[4], m[5], m.index!);
    if (c) out.push(c);
  }
  return out;
}

/** The source with each marker comment replaced by what `f` returns for it. */
export const mapMarkerComments = (markdown: string, f: (c: MarkerComment) => string) =>
  markdown.replace(SHAPED_RE, (whole, slash: string, taskType: string, id: string, suffix: string | undefined, payload: string | undefined, index: number) => {
    const c = asComment(whole, slash, taskType, id, suffix, payload, index);
    return c ? f(c) : whole;
  });

/**
 * Markdown source → text with the comments swapped for markers, ready for the parser. Markers that already
 * are in the text (a save that leaked them, from a page running older code) are kept, so the page loads as intended.
 */
export const toMarkers = (markdown: string) =>
  mapMarkerComments(markdown, (c) => markerText(c.part, c.taskType, c.id, c.state, c.instruction));

/**
 * Markers swapped back for their comments. A range over several blocks carries its instruction in every piece
 * (the parse shares it out), and only the first opening comment writes it.
 */
export function fromMarkers(text: string) {
  const said = new Set<string>();
  return text.replace(MARKER_RE, (_, part: MarkerPart, taskType: string, id: string, code: string, hex: string | undefined) => {
    const instruction = said.has(id) ? undefined : instructionOfHex(hex);
    if (instruction) said.add(id);
    return commentFor(part, taskType, id, stateOfCode(code), instruction);
  });
}

/**
 * A body on its way to disk: any marker that leaked through is turned into its comment, and a stray private-use
 * character that is left over is dropped. The server does this to every save, whatever version of the page sent it.
 */
export const scrubMarkers = (markdown: string) => fromMarkers(markdown).replace(/[]/g, "");

/**
 * The state each marker id has in a markdown body. The opening comment decides; an id that appears more than once
 * (one range over several paragraphs gets a pair in each) takes the furthest along of its opening comments, so moving
 * on just one of them is enough. Used to move the page's loaders on.
 */
export function taskStates(markdown: string): Map<string, TaskState> {
  const out = new Map<string, TaskState>();
  const closing = new Map<string, TaskState>();
  for (const c of markerComments(markdown)) {
    const into = c.part === "e" ? closing : out;
    const had = into.get(c.id);
    if (!had || STATES.indexOf(c.state) > STATES.indexOf(had)) into.set(c.id, c.state);
  }
  for (const [id, state] of closing) if (!out.has(id)) out.set(id, state);
  return out;
}

/** A body with every state suffix taken off, so two bodies that differ only in how far their markers are compare equal. */
export const withoutStates = (markdown: string) => mapMarkerComments(markdown, (c) => commentFor(c.part, c.taskType, c.id, DEFAULT_STATE, c.instruction));

/**
 * `markdown` with each marker in the state `theirs` has it in (the server's word on how far each one is), and any
 * other as it is: for a body merged from state-free bodies (`withoutStates`) that is saved as it is. `held` overrides
 * that for tasks the writer has just decided on, which the server can't know of yet.
 */
export function withStatesFrom(markdown: string, theirs: string, held?: ReadonlyMap<string, TaskState>): string {
  const states = taskStates(theirs);
  return mapMarkerComments(markdown, (c) => commentFor(c.part, c.taskType, c.id, held?.get(c.id) ?? states.get(c.id) ?? c.state, c.instruction));
}

/** A marker as the parsed page holds it. A range over several paragraphs is listed once per piece. */
export interface MarkerInDoc { taskType: string; id: string; state: TaskState; instruction?: string }

export const asInstruction = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
const withInstruction = (p: MarkerInDoc, x: unknown): MarkerInDoc => {
  const instruction = asInstruction(x);
  return instruction ? { ...p, instruction } : p;
};

/** The name of the node a point is, and of the mark a range is, in the page's schema. */
export const POINT_NODE = "markerPoint";
export const RANGE_MARK = "markerRange";

type Walkable = { descendants(f: (node: { type: { name: string }; attrs: Record<string, any>; marks: readonly { type: { name: string }; attrs: Record<string, any> }[] }) => void): void };

/** The markers in a parsed page, in page order. Comments in code are text, not markers, so they aren't listed. */
export function markersIn(doc: Walkable): MarkerInDoc[] {
  const out: MarkerInDoc[] = [];
  doc.descendants((node) => {
    if (node.type.name === POINT_NODE) out.push(withInstruction({ taskType: node.attrs.taskType, id: node.attrs.id, state: asState(node.attrs.state) }, node.attrs.instruction));
    for (const m of node.marks) if (m.type.name === RANGE_MARK) out.push(withInstruction({ taskType: m.attrs.taskType, id: m.attrs.id, state: asState(m.attrs.state) }, m.attrs.instruction));
  });
  return out;
}
