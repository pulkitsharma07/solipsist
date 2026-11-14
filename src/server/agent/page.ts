import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { commentFor, markdownToDoc, parseFile, markersIn, type TaskAgent } from "../../shared/docfile";
import { pluginFor, plugins, type TaskTypePlugin } from "../../shared/plugin";
import { config } from "../config";
import { readModifyWrite, withLock } from "../files";
import { pagesDir, root } from "../runtime";
import { resetAcks } from "../put";
import { promptPath, promptText, renderPrompt } from "../prompts";
import { taskTypeServer } from "../taskTypes";
import type { AgentEngine, StartOptions } from "./engine";
import { defaultChoice, parseChoice } from "./engines";

/**
 * What the agent loop reads of a page, and what it tells a run about it: the page's files, its pending tasks,
 * the settings that pace the loop, and each run's prompt.
 */

/**
 * The model a page's agent runs on: an engine (`engines/`) and one of its models, written `engine:model`. One that
 * is unknown, or whose engine can't run now (no key), means the default.
 */
export const asChoice = (x: unknown) => { const c = parseChoice(x); return c && !c.engine.unavailable() ? c.choice : defaultChoice(); };
/** The pause before a task whose run failed is tried again. */
export const gapMs = () => config().agent.gap_ms;
/** How long the page must sit unchanged before a changed page is sent: the writer may still be typing. */
export const settleMs = () => config().agent.settle_ms;
/** How long one run may take before its agent is stopped and the run counted as failed: a hung model or tool frees its slot. */
export const runTimeoutMs = () => config().agent.run_timeout_ms;
/**
 * Single-agent mode: the page has one lasting agent that takes every request in turn and keeps what it has read and
 * written, instead of a fresh agent per request (`pageAgents.ts`). Its runs are one at a time, whatever `concurrency`.
 */
export const singleAgent = () => config().agent.single_agent;
/** How many runs may work on one page at once, each on its own task and its own agent (1 in single-agent mode). */
export const concurrency = () => (singleAgent() ? 1 : config().agent.concurrency);
/** How many runs may work at once across every page, so many open pages don't run a crowd of agents. */
export const maxRuns = () => config().agent.max_runs;
/** How long an agent kept after its run waits before it snoozes: closed, its conversation left on disk. */
export const waitMs = () => config().agent.wait_ms;
/** How many kept agents may wait on one page at once: past that, the one waiting longest snoozes. */
export const maxWaiting = () => config().agent.max_waiting;

export const pageFile = (id: string) => resolve(pagesDir(), `${id}.md`);
/** The images a page's agent draws: its own folder, the one place it may write besides the page. */
export const imagesDir = (id: string) => resolve(root(), ".solipsist", "images", id);
export { kindPromptFile, protocolFile } from "../prompts";

/**
 * The page as the loop looks at it: the body's fingerprint, the tasks waiting (each once, in page order, of any
 * task type), and the ids of all its tasks (null when the body can't be parsed).
 */
interface PageView { hash: bigint | number; pending: Target[]; ids: Set<string> | null }
/**
 * The last view of each page, by the file it was made from: the loop looks several times a second, and parsing a page
 * is slow (a 40 KB page took 266 ms a look, all of it blocking the server), so it is parsed again only when its file
 * changed.
 */
const views = new Map<string, { src: string; view: PageView }>();

/** The page as it is now (a missing file counts as empty). */
export function pageView(id: string): PageView {
  let src = "";
  try { src = readFileSync(pageFile(id), "utf8"); } catch {}
  const last = views.get(id);
  if (last?.src === src) return last.view;
  let markdown = "";
  try { markdown = parseFile(src).markdown; } catch {}
  let found: ReturnType<typeof markersIn> | null = null;
  try { found = markersIn(markdownToDoc(markdown)); } catch {}
  const seen = new Set<string>();
  const view: PageView = {
    // The comments block is left out: the server rewrites it on its own (a recorded disk edit, an orphan sweep), and
    // that is no reason to run again.
    hash: Bun.hash(markdown),
    pending: (found ?? []).filter((p) => p.state === "pending" && !seen.has(p.id) && !!seen.add(p.id)).map(({ id, taskType, instruction }) => ({ id, taskType, ...(instruction && { instruction }) })),
    ids: found && new Set(found.map((p) => p.id)),
  };
  views.set(id, { src, view });
  return view;
}
/** Forgets the page's last view (its agents have stopped). */
export const forgetPage = (id: string) => void views.delete(id);

/** A fingerprint of the page's body as it is now (see `pageView`). */
export const pageHash = (id: string) => pageView(id).hash;
/** Moves the page's acknowledged tasks back to pending, but those in `keep` (see `resetAcks`). Returns their ids. */
export const resetStaleAcks = (id: string, keep: ReadonlySet<string> = new Set()) =>
  withLock(id, () => readModifyWrite(id, (src) => {
    const r = src === null ? null : resetAcks(src, new Date(), keep);
    return { file: r?.file, result: r?.ids ?? [] };
  }));

/** The plugins with a task waiting on the page, in the order they were registered. */
export function pendingKinds(id: string): TaskTypePlugin[] {
  const found = new Set(pageView(id).pending.map((p) => p.taskType));
  return plugins().filter((p) => found.has(p.taskType));
}
/** The agent recorded for task `task`, if its engine keeps conversations. */
export function recordedAgent(id: string, task: string): TaskAgent | undefined {
  try { return parseFile(readFileSync(pageFile(id), "utf8")).block.tasks?.[task]?.agent; } catch { return undefined; }
}
/** When task `task`'s last run finished, from its record (ms), if it says. */
export function recordedFinish(id: string, task: string): number | undefined {
  try {
    const at = Date.parse(parseFile(readFileSync(pageFile(id), "utf8")).block.tasks?.[task]?.finished ?? "");
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}
export const taskIds = (id: string) => pageView(id).ids;

/** A task a run can be sent to work on, and what the writer asked in it, if it says. */
export interface Target { id: string; taskType: string; instruction?: string }
/** The tasks waiting on the page, each once, in page order. Only task types that are registered. */
export function pendingTasks(id: string): Target[] {
  // Filtered now, not when the view was made: a task type may be registered since.
  const known = new Set(plugins().map((p) => p.taskType));
  return pageView(id).pending.filter((t) => known.has(t.taskType));
}

const readOr = (path: string, fallback: string) => { try { return readFileSync(path, "utf8").trim(); } catch { return fallback; } };

/**
 * What every run follows, for the agent's system prompt (read when an agent starts): the protocol, and for an engine
 * without the reply tools how to give its result as text instead.
 */
export const systemPrompt = (engine?: Pick<AgentEngine, "replyTools">) =>
  [renderPrompt("protocol", { guide: promptPath("images") }), ...(engine?.replyTools ? [] : [promptText("protocol.envelope")])].join("\n\n");

/** What an agent of `engine` is told when it starts, besides the page: its system prompt and the files it may read for it. */
export const instructions = (engine: Pick<AgentEngine, "replyTools">): Pick<StartOptions, "system" | "readable" | "replyTools"> =>
  ({ system: systemPrompt(engine), readable: [promptPath("images")], replyTools: true });

/** How a prompt names a task: its task type and id, its marker as it looks while its run works (`:ack`), and its instruction. */
const describe = (t: Target) => {
  const range = pluginFor(t.taskType)?.shape === "range";
  const part = range ? "s" : "p";
  return `the ${t.taskType} task ${t.id}, marked \`${commentFor(part, t.taskType, t.id, "ack", t.instruction)}${range ? `…${commentFor("e", t.taskType, t.id, "ack")}` : ""}\`${t.instruction ? `, with the writer's instruction <instruction>${t.instruction}</instruction>` : ""}`;
};

/** When the writer asked again: the proposal they turned down, so the run makes a different one. A task with a button is told what that means instead. */
function askedAgain(id: string, t: Target): string {
  let record;
  try { record = parseFile(readFileSync(pageFile(id), "utf8")).block.tasks?.[t.id]; } catch { return ""; }
  if (record?.button) return `\n\n${renderPrompt("run.button", {})}`;
  if (!record?.asked_again) return "";
  const edits = (record.edits ?? []).map((e) => `\n<edit>\n<before>\n${e.before}\n</before>\n<after>\n${e.after}\n</after>\n</edit>`).join("");
  const was = record.answer !== undefined
    ? `\n\n<earlier-answer>\n${record.answer}\n</earlier-answer>`
    : record.suggestion !== undefined || edits
      ? `\n\n<rejected-suggestion>${record.suggestion !== undefined ? `\n${record.suggestion}` : ""}${edits}\n</rejected-suggestion>`
      : record.note ? ` Last time you declined: ${record.note}` : "";
  // Asked again for a button: told what that needs (checkReply holds it to it).
  const asButton = record.wants_button ? `\n\n${renderPrompt("run.as_button", {})}` : "";
  return `\n\n${renderPrompt("run.again", { was })}${asButton}`;
}

/** The task types a run is told the instructions of: its target's first, then the others waiting on the page. */
export function runKinds(id: string, target: Target): TaskTypePlugin[] {
  const own = plugins().filter((p) => p.taskType === target.taskType);
  return [...own, ...pendingKinds(id).filter((p) => p.taskType !== target.taskType)];
}
/** What a run is told about a task type: its server half's `prompt`, by default its `type.<type>` prompt as it is now. */
function kindText(id: string, target: Target, p: TaskTypePlugin): string {
  const text = promptText(`type.${p.taskType}`);
  const own = taskTypeServer(p.taskType)?.prompt;
  return own ? own({ pageId: id, target, text }) : text;
}
const kindsText = (id: string, target: Target, ps: TaskTypePlugin[]) =>
  ps.map((p) => `<task-type name="${p.taskType}" shape="${p.shape}">\n${kindText(id, target, p) || "(no instructions)"}\n</task-type>`).join("\n\n");

/** Where the page's original is and what the project tells agents; nothing when the page is no copy. */
function projectNote(id: string) {
  const conventions = ["AGENTS.md"].filter((f) => existsSync(join(root(), f))).join(", ") || "none";
  return renderPrompt("run.project", { path: `${id}.md`, root: root(), conventions }).trimEnd();
}

/**
 * The prompt for one run on one task, with its tasks filled in: the task it is for, the
 * instructions of its task type and of the others waiting on the page inline, and the page file.
 */
export function promptFor(id: string, target: Target) {
  const page = readOr(pageFile(id), "");
  // Filled in one pass, so text in a task type's instructions or the page is never taken for a task.
  const fill: Record<string, string> = { id, file: pageFile(id), images: imagesDir(id), imageLink: basename(id), project: projectNote(id), target: describe(target), again: askedAgain(id, target), kinds: kindsText(id, target, runKinds(id, target)) || "none", page };
  return renderPrompt("run", fill);
}

/**
 * The prompt for a run on a lasting agent that has already done one (single-agent mode): the task and little
 * else, since the protocol, the page and the task types it has been told are in its conversation. `told` is the task types it
 * has had the instructions of; any it hasn't come with this run, so a task type new to the page is never unexplained.
 */
export function promptNext(id: string, target: Target, told: ReadonlySet<string>) {
  const fresh = runKinds(id, target).filter((p) => !told.has(p.taskType));
  const kinds = fresh.length ? `\n\nTask types you have not been told about yet, and the instructions for each:\n\n${kindsText(id, target, fresh)}` : "";
  const fill: Record<string, string> = { id, file: pageFile(id), images: imagesDir(id), target: describe(target), again: askedAgain(id, target), kinds };
  return renderPrompt("run.next", fill);
}

