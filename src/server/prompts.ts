/**
 * Every instruction the agents get, with the writer's edits.
 *
 * A prompt has a built-in default, a file in the repo, embedded in the build (so a compiled binary has it too). The writer's edit is a file of the same id in `prompts.dir`
 * (`~/.config/solipsist/prompts`): present means it is the prompt, absent means the default. The files are read each time
 * a prompt is used, so an edit, in the app or by hand, applies to the next run without a restart.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { plugins } from "../shared/plugin";
import "../plugins/server"; // the built-in task types, with their type.* prompts
import { taskTypeServer } from "./taskTypes";
import { config } from "./config";
import protocolMd from "./agent/protocol.md" with { type: "text" };
import envelopeMd from "./prompts/protocol.envelope.md" with { type: "text" };
import imagesMd from "./prompts/images.md" with { type: "text" };
import runMd from "./prompts/run.md" with { type: "text" };
import runNextMd from "./prompts/run.next.md" with { type: "text" };
import runProjectMd from "./prompts/run.project.md" with { type: "text" };
import runAgainMd from "./prompts/run.again.md" with { type: "text" };
import runButtonMd from "./prompts/run.button.md" with { type: "text" };
import runAsButtonMd from "./prompts/run.as_button.md" with { type: "text" };
import chatFirstMd from "./prompts/chat.first.md" with { type: "text" };
import piChatSystemMd from "./prompts/pi-chat.system.md" with { type: "text" };
import piChatFirstMd from "./prompts/pi-chat.first.md" with { type: "text" };
import reviewMd from "./prompts/review.md" with { type: "text" };
import reviewerMd from "./prompts/review.reviewer.md" with { type: "text" };
import { briefPromptId, reviewers } from "./review/reviewers";

/**
 * A reviewer's built-in brief, embedded in the build (a compiled binary has no repo to read). Each reviewer that
 * ships adds its file here; one registered at runtime has no built-in, and the writer's own file is its whole text.
 */
const BRIEFS: Record<string, string> = { reviewer: reviewerMd };
const briefText = (id: string) => BRIEFS[id] ?? "";

export interface Slot { name: string; description: string; required?: boolean }
export type PromptGroup = "Agent" | "Chat" | "Task types";
/** `defaultFile` is where the default lives in the repo; `builtin` is its text, as embedded in the build. */
interface Def { id: string; title: string; group: PromptGroup; description: string; slots: Slot[]; defaultFile: string; builtin: string }

/** From this file's folder, not the working directory: the server may be started anywhere. */
const repo = (...p: string[]) => resolve(import.meta.dir, "..", "..", ...p);
/** What every run follows, whatever the task types: the states, the record and the rules. */
export const protocolFile = () => repo("src/server/agent/protocol.md");
/** A task type's own instructions: what it asks for, and what to write. */
export const kindPromptFile = (kind: string) => repo("src/plugins", kind, "prompt.md");
const template = (name: string) => repo("src/server/prompts", `${name}.md`);

const FIXED: Def[] = [
  { id: "protocol", title: "Protocol", group: "Agent", defaultFile: protocolFile(), builtin: protocolMd,
    description: "The system prompt of every agent: what a request is, the reply tools, and the rules. Read when an agent starts.",
    slots: [{ name: "guide", description: "Where the image guide (the images prompt) is, for the agent to read before it makes an image." }] },
  { id: "protocol.envelope", title: "Protocol, without tools", group: "Agent", slots: [], defaultFile: template("protocol.envelope"), builtin: envelopeMd,
    description: "Added to the protocol for an engine that has no reply tools: how to give the result as text, in an envelope." },
  { id: "images", title: "Image guide", group: "Agent", slots: [], defaultFile: template("images"), builtin: imagesMd,
    description: "How to make an image and how it looks. Not sent: the agent reads the file when it makes one." },
  { id: "run", title: "Run prompt", group: "Agent", defaultFile: template("run"), builtin: runMd,
    description: "What each run is sent: the request it is for, the task types on the page and the page itself.",
    slots: [
      { name: "id", description: "The page's id." },
      { name: "imageLink", description: "The folder under images/ that the page links its images from." },
      { name: "project", description: "Where the page's original is, when it is a copy of a file in a project; otherwise empty." },
      { name: "file", description: "The page's file, in full." },
      { name: "images", description: "The folder the agent may write images in." },
      { name: "target", description: "The request this run is for, its comments and the writer's instruction.", required: true },
      { name: "again", description: "The “asked again” text (run.again), when the writer asked again; empty otherwise." },
      { name: "kinds", description: "Each task type on the page and its instructions (the type.* prompts)." },
      { name: "page", description: "The page file as it is now." },
    ] },
  { id: "run.project", title: "Run prompt, in a project", group: "Agent", defaultFile: template("run.project"), builtin: runProjectMd,
    description: "Added to the run prompt when the page is a copy of a file in a project: where the original is.",
    slots: [
      { name: "path", description: "The original's path in the project." },
      { name: "root", description: "The project's folder." },
      { name: "conventions", description: "The project's files of instructions for agents, or none." },
    ] },
  { id: "run.next", title: "Run prompt, lasting agent", group: "Agent", defaultFile: template("run.next"), builtin: runNextMd,
    description: "What a run is sent in single-agent mode (`agent.single_agent`) once the page's agent has done one: the request only, since the protocol, the page and the task types it has been told are in its conversation already.",
    slots: [
      { name: "id", description: "The page's id." },
      { name: "file", description: "The page's file, in full." },
      { name: "images", description: "The folder the agent may write images in." },
      { name: "target", description: "The request this run is for, its comments and the writer's instruction.", required: true },
      { name: "again", description: "The “asked again” text (run.again), when the writer asked again; empty otherwise." },
      { name: "kinds", description: "The task types this agent has not been told about yet and their instructions, with a line introducing them; empty when it has been told all of them." },
    ] },
  { id: "run.again", title: "Asked again", group: "Agent", defaultFile: template("run.again"), builtin: runAgainMd,
    description: "Added to a run when the writer turned down the earlier result and asked again.",
    slots: [{ name: "was", description: "The earlier result the writer turned down, or the reason it was declined." }] },
  { id: "run.button", title: "Button pressed", group: "Agent", defaultFile: template("run.button"), builtin: runButtonMd,
    description: "Added to a run when the writer pressed a task's button: its result replaces the text and goes straight into the page.",
    slots: [] },
  { id: "run.as_button", title: "Asked again as a button", group: "Agent", defaultFile: template("run.as_button"), builtin: runAsButtonMd,
    description: "Added to a run when the writer asked again for a result they can keep as a button: one piece of text in place, nothing changed elsewhere.",
    slots: [] },
  { id: "review", title: "Page review prompt", group: "Agent", defaultFile: template("review"), builtin: reviewMd,
    description: "What each review is sent: the page, and the questions already raised on it so they are not raised twice. Shared by every reviewer — what one of them looks for is its own brief, below.",
    slots: [
      { name: "id", description: "The page's id." },
      { name: "file", description: "The page's file, in full." },
      { name: "page", description: "The page as it is now." },
      { name: "images", description: "The folder the reviewer may draw images in." },
      { name: "max", description: "The most questions this review may raise (`review.max_per_review`)." },
      { name: "raised", description: "The questions already live, dismissed or orphaned on this page, with a line introducing them; empty when there are none." },
    ] },
  { id: "chat.first", title: "Chat on a suggestion", group: "Chat", defaultFile: template("chat.first"), builtin: chatFirstMd,
    description: "Said to the agent when the writer opens a chat from a suggestion's card.",
    slots: [{ name: "placeholder", description: "The request's id." }] },
  { id: "pi-chat.system", title: "Page chat, system prompt", group: "Chat", defaultFile: template("pi-chat.system"), builtin: piChatSystemMd,
    description: "The system prompt of the chat opened from the page's chat button.",
    slots: [
      { name: "name", description: "The agent's name (the engine's title, e.g. Pi)." },
      { name: "file", description: "The page's file, in full.", required: true },
    ] },
  { id: "pi-chat.first", title: "Page chat, first message", group: "Chat", defaultFile: template("pi-chat.first"), builtin: piChatFirstMd,
    description: "Said to the agent when the writer opens the chat from the page's chat button.",
    slots: [{ name: "file", description: "The page's file, in full." }] },
];

/** A task type's prompt: `type.<type>`. */
const TYPE = "type.";
/** Every prompt: the fixed ones, one per reviewer, then one per registered task type. */
export function definitions(): Def[] {
  return [
    ...FIXED,
    // A reviewer's brief is a prompt of its own, so the writer edits what it looks for; a second reviewer is a
    // second brief (`review/reviewers.ts`), not a change to the first one's.
    ...reviewers().map((r): Def => ({
      id: briefPromptId(r.id), title: r.title, group: "Agent", slots: [], defaultFile: template(briefPromptId(r.id)),
      builtin: briefText(r.id), description: r.description,
    })),
    ...plugins().map((p): Def => ({
      id: `${TYPE}${p.taskType}`, title: `Task type: ${p.taskType}`, group: "Task types", slots: [], defaultFile: kindPromptFile(p.taskType), builtin: taskTypeServer(p.taskType)?.instructions ?? "",
      description: `What a ${p.taskType} request asks for, and what the agent writes. Shown to a run whenever this task type is on the page.`,
    })),
  ];
}
const find = (id: string) => definitions().find((d) => d.id === id);

const read = (path: string): string | null => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };

export const promptsDir = () => config().prompts.dir;
const overrideFile = (id: string) => join(promptsDir(), `${id}.md`);
/** The writer's file for a prompt; null when there is none, or it has no text. */
function ownFile(id: string): string | null {
  return (read(overrideFile(id)) ?? "") !== "" ? overrideFile(id) : null;
}

export const defaultText = (id: string): string => find(id)?.builtin.trim() ?? "";
/** A prompt as it is now: the writer's file if there is one, else the default. An unknown id is empty. */
export function promptText(id: string): string {
  const own = ownFile(id);
  return own ? read(own)! : defaultText(id);
}

/** The file a prompt is read from now: the writer's, if there is one, else the default. For a prompt the agent reads itself. */
export function promptPath(id: string): string {
  const d = find(id);
  if (!d) throw new Error(`There is no prompt "${id}".`);
  const own = ownFile(id);
  if (own) return own;
  return existsSync(d.defaultFile) ? d.defaultFile : builtinFile(d);
}

/** Tests only: the file `promptPath` gives when the repo's file isn't there. */
export const builtinFileOf = (id: string) => { const d = find(id); if (!d) throw new Error(`There is no prompt "${id}".`); return builtinFile(d); };

/**
 * The built-in text as a file, for a prompt the agent reads itself when the repo's file isn't on disk (a compiled
 * binary). Written to a folder of this user's in the temp dir; rewritten when the text differs.
 */
function builtinFile(d: Def): string {
  const file = join(tmpdir(), `solipsist-${userInfo().username}`, "prompts", `${d.id}.md`);
  const text = `${d.builtin.trim()}\n`;
  if (read(file) !== text.trim()) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  return file;
}

/** A prompt with its `{slots}` filled in, in one pass: a slot's value is never read for slots. Others are kept as written. */
export function renderPrompt(id: string, vars: Record<string, string>): string {
  const d = find(id);
  const names = new Set(d?.slots.map((s) => s.name));
  return promptText(id).replace(/\{([a-z]+)\}/g, (all, k: string) => (names.has(k) && k in vars ? vars[k]! : all));
}

export interface PromptView {
  id: string; title: string; group: PromptGroup; description: string; slots: Slot[];
  text: string;
  default: string;
  /** Whether the writer's file is in use. */
  custom: boolean;
  /** Where the writer's file is (or would be). */
  file: string;
}
const view = (d: Def): PromptView => ({
  id: d.id, title: d.title, group: d.group, description: d.description, slots: d.slots,
  text: promptText(d.id), default: defaultText(d.id), custom: ownFile(d.id) !== null, file: overrideFile(d.id),
});

export const listPrompts = (): PromptView[] => definitions().map(view);
export const getPrompt = (id: string): PromptView | null => { const d = find(id); return d ? view(d) : null; };

export class PromptError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Keeps the writer's text as the prompt. Text equal to the default removes the file. Throws a `PromptError` naming the problem. */
export function savePrompt(id: string, text: unknown): PromptView {
  const d = find(id);
  if (!d) throw new PromptError(`There is no prompt "${id}".`, 404);
  if (typeof text !== "string" || text.trim() === "") throw new PromptError("A prompt can't be empty: reset it to the default instead.");
  const body = text.replace(/\r\n/g, "\n").trim();
  const missing = d.slots.filter((s) => s.required && !body.includes(`{${s.name}}`));
  if (missing.length) throw new PromptError(`It must contain ${missing.map((s) => `{${s.name}}`).join(" and ")}: ${missing.map((s) => s.description).join(" ")}`);
  if (body === defaultText(id)) return resetPrompt(id);
  const file = overrideFile(id);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${body}\n`);
  renameSync(tmp, file);
  return view(d);
}

export function resetPrompt(id: string): PromptView {
  const d = find(id);
  if (!d) throw new PromptError(`There is no prompt "${id}".`, 404);
  rmSync(overrideFile(id), { force: true });
  return view(d);
}
