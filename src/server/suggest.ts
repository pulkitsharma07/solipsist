import {
  aloneInBlock, canonicalBody, commentFor, decide, docToMarkdown, findBlocks, mapMarkerComments, markdownToDoc, newTaskId, parseFile, markerComments,
  BUTTON_EVERY, markerSpots, nextRunAt, taskStates, serializeFile, whyNoButton, type CommentsBlock, type TaskAgent, type TaskRecord, type SuggestionMode,
  type SuggestionEdit, type SuggestionPlace,
} from "../shared/docfile";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import "../plugins/server"; // the built-in task types' server halves
import { config } from "./config";
import { ALL_REPLY_TOOLS, taskTypeServer, toolOf, type Checked, type ReplyContext } from "./taskTypes";
import type { CommentProposal } from "./place";

/**
 * A run's result as a suggestion. The agent never writes the page: the server
 * acknowledges the task when its run starts (`ackTask`), the agent replies with its result in an
 * envelope (`parseReply`), and the server checks it (`checkReply`) and writes it into the task's record, moving
 * the task to `:sug` (`finishRun`). All pure: a file in, a file out. The one exception to "never writes the page" is a task the
 * writer kept as a button (`applyRerun`): they said, at that moment, that its next results go straight in.
 *
 * What is the same for every task type is here: reading the envelope, the checks every reply passes, writing the record.
 * What a task type decides for itself (the replies it takes, where its suggestion may go, checks of its own, the
 * fields it records) is asked of its server half (`taskTypes.ts`).
 */

/** What a run's reply said: a result for its spot, changes to other blocks, or both; or why the agent won't make one. */
export type Reply =
  | { kind: "suggestion"; mode?: SuggestionMode; place?: SuggestionPlace; suggestion?: string; edits?: SuggestionEdit[]; note?: string }
  | { kind: "answer"; answer: string; note?: string }
  | { kind: "decline"; note: string };

/**
 * A review's questions (`review/`, the `comment` tool). Deliberately not a `Reply`: a task's reply can never be
 * one, so the task path (`checkReply`, `finishRun`) keeps taking `Reply` and says so in its types.
 */
export type CommentsReply = { kind: "comments"; comments: CommentProposal[] };

/** What any run may reply with: a task's result, or a review's questions. */
export type AnyReply = Reply | CommentsReply;

/** Narrows a run's reply to a task's, which is all the suggestion path can use. */
export const taskReply = (r: AnyReply | undefined): Reply | undefined => (r && r.kind !== "comments" ? r : undefined);

const SUGGESTION_RE = /<suggestion\s+mode="(at|replace|after)"\s+place="(inline|blocks)"\s*>\n?([\s\S]*?)\n?<\/suggestion>/g;
const EDIT_RE = /<edit>\s*<before>\n?([\s\S]*?)\n?<\/before>\s*<after>\n?([\s\S]*?)\n?<\/after>\s*<\/edit>/g;
const lastMatch = (re: RegExp, text: string) => [...text.matchAll(re)].at(-1);

/**
 * The envelope in a run's reply: the last `<suggestion>`, so a draft the agent quoted earlier doesn't count, and
 * every `<edit>`; or a `<decline>`.
 */
export function parseReply(reply: string): Reply | { error: string } {
  const s = lastMatch(SUGGESTION_RE, reply);
  const edits = [...reply.matchAll(EDIT_RE)].map((m) => ({ before: m[1]!, after: m[2]! }));
  const decline = lastMatch(/<decline>([\s\S]*?)<\/decline>/g, reply)?.[1]?.trim();
  const answer = lastMatch(/<answer>([\s\S]*?)<\/answer>/g, reply)?.[1]?.trim();
  if ((s || edits.length) && decline !== undefined) return { error: "The reply has both a result and a <decline>." };
  if (answer !== undefined && (s || edits.length || decline !== undefined)) return { error: "An <answer> goes alone: it changes nothing, so no <suggestion>, <edit> or <decline> with it." };
  if (decline !== undefined) return decline ? { kind: "decline", note: decline } : { error: "The <decline> gives no reason." };
  const note = lastMatch(/<note>([\s\S]*?)<\/note>/g, reply)?.[1]?.trim();
  if (answer !== undefined) return answer ? { kind: "answer", answer, ...(note && { note }) } : { error: "The <answer> is empty." };
  if (!s && !edits.length) return { error: "The reply has no <suggestion>, <edit>, <answer> or <decline>." };
  return {
    kind: "suggestion",
    ...(s && { mode: s[1] as SuggestionMode, place: s[2] as SuggestionPlace, suggestion: s[3]! }),
    ...(edits.length && { edits }),
    ...(note && { note }),
  };
}

/** The longest suggestion kept (`suggestions.max_chars`): a run that writes more than this has gone wrong. */
const maxSuggestionChars = () => config().suggestions.max_chars;
/** The most edits to other blocks one suggestion may make (`suggestions.max_edits`). */
const maxEdits = () => config().suggestions.max_edits;

export type { Checked };

/** Markdown from the agent, canonical: as the page would write it, and reading back as itself. */
function canonical(markdown: string, what: string): { markdown: string; doc: PMNode } | { error: string } {
  if (markdown.length > maxSuggestionChars()) return { error: `${what} is longer than ${maxSuggestionChars()} characters.` };
  try {
    const out = docToMarkdown(markdownToDoc(markdown));
    const doc = markdownToDoc(out);
    if (docToMarkdown(doc) !== out) return { error: `${what}'s markdown doesn't read back as itself.` };
    if (out.includes("<!-- solip-comments")) return { error: `${what} holds a comments block.` };
    return { markdown: out, doc };
  } catch (e: any) {
    return { error: `${what}'s markdown can't be read: ${e?.message ?? e}` };
  }
}

/**
 * The tasks in markdown the agent wrote: of registered task types, waiting, never the run's own, and each with an
 * id no other has (`used`, which this adds to). Returns the markdown with ids changed where theirs were taken.
 */
function freshMarkers(markdown: string, targetId: string, used: Set<string>, what: string): string | { error: string } {
  const found = markerComments(markdown);
  if (found.some((c) => c.state !== "pending")) return { error: `A marker in ${what} is not waiting (it has a state suffix).` };
  if (found.some((c) => c.id === targetId)) return { error: `${what} holds the marker of your own task.` };
  const fresh = new Map<string, string>();
  for (const c of found) {
    if (fresh.has(c.id)) continue;
    const id = used.has(c.id) ? newTaskId(used) : c.id;
    fresh.set(c.id, id);
    used.add(id);
  }
  return mapMarkerComments(markdown, (c) => commentFor(c.part, c.taskType, fresh.get(c.id) ?? c.id, c.state, c.instruction));
}

/**
 * A reply as record fields, checked against the page the run read (`page`, the body with the task at `:ack`)
 * and the ids already taken (`taken`: in the body as it is now and in the record). Returns why it can't be used
 * instead, and the run then counts as failed. The shared checks first, then the task type's own (`check`); the
 * fields are the task type's to shape last (`finish`), so every writer of a record (a run, a chat, the page chat)
 * records the same.
 */
export function checkReply(reply: Reply, page: string, target: { id: string; taskType: string; button?: boolean; asButton?: boolean }, taken: Iterable<string>): Checked | { error: string } {
  const type = taskTypeServer(target.taskType);
  const tools = type?.tools ?? ALL_REPLY_TOOLS;
  if (!tools.includes(toolOf(reply.kind))) return { error: `A ${target.taskType} task takes no ${toolOf(reply.kind)}: reply with ${tools.join(", ")}.` };
  if (reply.kind === "decline") return { status: "declined", note: reply.note };
  if (!type) return { error: `The task type ${target.taskType} is not registered.` };
  const doc = markdownToDoc(page);
  const spots = markerSpots(doc, target.id);
  if (!spots) return { error: "The task's marker is not in the page the run read." };
  const checked = sharedChecks(reply, doc, spots, target, taken, type.modes, type.places);
  if ("error" in checked) return checked;
  if ((target.button || target.asButton) && reply.kind === "suggestion") {
    const why = target.button ? rerunProblem(doc, checked) : asButtonProblem(doc, checked);
    if (why) return { error: why };
  }
  const ctx: ReplyContext = { page, doc, target };
  const why = type.check?.(checked, ctx);
  if (why) return { error: why };
  return type.finish ? type.finish(checked, ctx) : checked;
}

/** Why a result for a task with a button can't go straight into the page, or null. Nobody reviews it, so it may do only this. */
function rerunProblem(doc: PMNode, c: Checked): string | null {
  if (c.mode !== "replace") return 'This task has a button: its result replaces the text in its range, so reply with mode="replace".';
  if (c.edits?.length) return "This task has a button, and its result goes straight into the page: it may change only the text in its range, so leave out the edits to other blocks.";
  const why = whyNoButton(doc.type.schema, c);
  return why && `This task has a button, and its result goes straight into the page, so it can't be used: ${why}`;
}

/** Why a result the writer asked for as a button can't be one, or null. */
function asButtonProblem(doc: PMNode, c: Checked): string | null {
  const why = whyNoButton(doc.type.schema, c);
  return why && `The writer asked for a result they can keep as a button: one piece of text at the range (mode="replace" or "after"), changing nothing else on the page. This one can't be: ${why}`;
}

/** What a task's record says about how its replies are checked: it has a button, or the writer asked for one. */
const flagsOf = (r: TaskRecord | undefined) => ({ button: !!r?.button, asButton: !!r?.wants_button && !r?.button });

/** The text of a range, as a run reads it and as the record's `saw` keeps it. */
const rangeText = (doc: PMNode, spots: NonNullable<ReturnType<typeof markerSpots>>) => spots.pieces.map((p) => doc.textBetween(p.from, p.to, "\n", "\uFFFC")).join("\n\n");

/** The checks every task type's reply passes (`checkReply`), with where its task type lets a suggestion go. */
function sharedChecks(
  reply: Exclude<Reply, { kind: "decline" }>, doc: PMNode, spots: NonNullable<ReturnType<typeof markerSpots>>, target: { id: string; taskType: string },
  taken: Iterable<string>, modes: readonly SuggestionMode[], places: readonly SuggestionPlace[] = ["inline", "blocks"],
): Checked | { error: string } {
  const saw = spots.pieces.length ? rangeText(doc, spots) : undefined;
  if (reply.kind === "answer") {
    const c = canonical(reply.answer, "The answer");
    if ("error" in c) return c;
    return { status: "suggested", answer: c.markdown, ...(saw !== undefined && { saw }), ...(reply.note && { note: reply.note }) };
  }
  const used = new Set(taken);
  const out: Checked = { status: "suggested" };

  if (reply.suggestion !== undefined) {
    const mode = reply.mode!;
    if (!modes.includes(mode)) return { error: `A ${target.taskType} suggestion goes ${modes.map((m) => `mode="${m}"`).join(" or ")}, not mode="${mode}".` };
    const c = canonical(reply.suggestion, "The suggestion");
    if ("error" in c) return c;
    if (!c.markdown.trim() && mode !== "replace") return { error: "The suggestion is empty: decline instead, or change other blocks with <edit>." };
    const suggested = freshMarkers(c.markdown, target.id, used, "the suggestion");
    if (typeof suggested !== "string") return suggested;
    // Where it goes: inline content is one paragraph; blocks only where the spot can take them.
    const oneParagraph = !suggested.trim() || (c.doc.childCount === 1 && c.doc.firstChild!.type.name === "paragraph");
    const takesBlocks = (() => {
      if (mode === "after") return true;
      if (mode === "at") return aloneInBlock(doc, spots.points[0]!);
      const first = doc.resolve(spots.pieces[0]!.from);
      const last = doc.resolve(spots.pieces[spots.pieces.length - 1]!.to);
      return first.parentOffset === 0 && last.parentOffset === last.parent.content.size;
    })();
    let place: SuggestionPlace = reply.place!;
    if (oneParagraph && !takesBlocks) place = "inline";
    else if (!oneParagraph && place === "inline") place = "blocks";
    if (place === "blocks" && !takesBlocks) return { error: "Blocks don't fit there: the spot is inside a line of text. Write inline content." };
    if (!places.includes(place)) return { error: `A ${target.taskType} suggestion is ${places.map((p) => `place="${p}"`).join(" or ")}, not place="${place}".` };
    Object.assign(out, { mode, place, suggestion: suggested });
  }

  if (reply.edits?.length) {
    if (reply.edits.length > maxEdits()) return { error: `More than ${maxEdits()} edits.` };
    // The top-level blocks that hold the run's own task: an edit may not touch them.
    const own = [...spots.points, ...spots.pieces.flatMap((p) => [p.from, p.to])].map((pos) => doc.resolve(pos).before(1));
    const runs: { from: number; to: number }[] = [];
    const edits: SuggestionEdit[] = [];
    for (const [i, e] of reply.edits.entries()) {
      const what = `Edit ${i + 1}`;
      const at = findBlocks(doc, e.before);
      if (!at) return { error: `${what}: its <before> is not whole blocks found once in the page. Copy the blocks exactly, from the start of the first to the end of the last.` };
      if (own.some((pos) => pos >= at.from && pos < at.to)) return { error: `${what} changes the blocks that hold your own marker: put that in your <suggestion> instead.` };
      if (runs.some((r) => r.from < at.to && at.from < r.to)) return { error: `${what} overlaps another edit.` };
      runs.push(at);
      let after = "";
      if (e.after.trim()) {
        const c = canonical(e.after, `${what}'s <after>`);
        if ("error" in c) return c;
        const fresh = freshMarkers(c.markdown, target.id, used, `${what}'s <after>`);
        if (typeof fresh !== "string") return fresh;
        after = fresh;
      }
      // Kept as the page wrote those blocks, so the page finds them by what they say.
      const before = docToMarkdown(doc.type.create(null, doc.content.cut(at.from, at.to)));
      edits.push({ before, after });
    }
    out.edits = edits;
  }

  return { ...out, ...(saw !== undefined && { saw }), ...(reply.note && { note: reply.note }) };
}

/** The file with every comment of task `id` moved to state `to`, and its record changed by `patch`. */
function move(src: string, id: string, to: "ack" | "sug", patch: (r: TaskRecord | undefined) => TaskRecord): string {
  const { markdown, block } = parseFile(src);
  const body = mapMarkerComments(markdown, (c) => (c.id === id ? commentFor(c.part, c.taskType, c.id, to, c.instruction) : c.whole));
  return withRecord(body, block, id, patch, true);
}

function withRecord(body: string, block: CommentsBlock, id: string, patch: (r: TaskRecord | undefined) => TaskRecord, bodyChanged: boolean): string {
  const rev = block.meta.rev + 1;
  const meta = bodyChanged ? { rev, body_rev: rev, body_by: "server" } : { ...block.meta, rev };
  return serializeFile(body, { ...block, meta, tasks: { ...block.tasks, [id]: patch(block.tasks?.[id]) } });
}

/**
 * Acknowledges task `id` as its run starts: its comments move to `:ack`, its record to `ack`. A task
 * written by hand may have no record yet: it gets the writer's. Null when it isn't pending (gone, or taken).
 */
export function ackTask(src: string, id: string, now = new Date()): { file: string; taskType: string } | null {
  const { markdown } = parseFile(src);
  if (taskStates(markdown).get(id) !== "pending") return null;
  const taskType = markerComments(markdown).find((c) => c.id === id)!.taskType;
  const file = move(src, id, "ack", (r) => ({ ...(r ?? { type: taskType, created_by: "writer", created: now.toISOString() }), status: "ack", acked: now.toISOString() }));
  return { file, taskType };
}

/** The task ids a new one may not take: those in the body and those with a record. */
const takenIds = (markdown: string, block: CommentsBlock) => [...taskStates(markdown).keys(), ...Object.keys(block.tasks ?? {})];

/**
 * Whether a reply a run gives with a reply tool can be used, checked as `finishRun` will check it: against the page
 * the run read, with the ids taken in the file as it is now. Why not, or null.
 */
export function checkRunReply(src: string, target: { id: string; taskType: string }, page: string, reply: Reply): string | null {
  const { markdown, block } = parseFile(src);
  const checked = checkReply(reply, page, { ...target, ...flagsOf(block.tasks?.[target.id]) }, takenIds(markdown, block));
  return "error" in checked ? checked.error : null;
}

/** After this many failed runs in a row, a task is declined instead of tried again. */
const maxFailures = () => config().agent.max_failures;

export type RunOutcome =
  /** The reply, checked: the task moved to `:sug`. */
  | { done: "suggested" | "declined" }
  /** A task with a button: the result went straight into the page, and the task is back at `:btn`. */
  | { done: "applied" }
  /** The run failed or its reply can't be used: the task stays at `:ack` for the reset, and is tried again. */
  | { done: "failed"; error: string; failures: number }
  /** The writer deleted the task while the run worked: the proposal is kept in the record. */
  | { done: "dropped" }
  /** Not at `:ack` any more (reset, or moved on by someone else): left alone. */
  | { done: "nothing" };

/**
 * A run on task `target` has ended: the file as it should be now, and what happened. `page` is the body the
 * run read; `result` the run's reply (its text, read for the envelope, or what it gave with a reply tool), or the error
 * it failed with. `agent`, with a reply, is the agent that is kept after it: recorded with the result, to wake or chat
 * with.
 */
export function finishRun(src: string, target: { id: string; taskType: string }, page: string, result: { reply: string | Reply; agent?: TaskAgent } | { error: string }, now = new Date()): { file?: string; outcome: RunOutcome } {
  const { markdown, block } = parseFile(src);
  const state = taskStates(markdown).get(target.id);
  const record = block.tasks?.[target.id];
  const taken = takenIds(markdown, block);
  const reply = "reply" in result ? (typeof result.reply === "string" ? parseReply(result.reply) : result.reply) : { error: result.error };
  const checked = "error" in reply ? reply : checkReply(reply, page, { ...target, ...flagsOf(record) }, taken);
  const base = (r: TaskRecord | undefined): TaskRecord => r ?? { type: target.taskType, created_by: "writer", created: now.toISOString(), status: "ack" };
  const finished = (c: Checked) => (r: TaskRecord | undefined): TaskRecord => {
    const { mode: _m, place: _p, suggestion: _x, edits: _e, answer: _a, saw: _s, note: _n, ...rest } = base(r);
    return { ...rest, ...c, finished: now.toISOString(), failures: 0, ...("agent" in result && result.agent && { agent: result.agent }) };
  };

  if (state === undefined) {
    if ("error" in checked) return { outcome: { done: "nothing" } };
    return { file: withRecord(markdown, block, target.id, (r) => ({ ...finished(checked)(r), status: "dropped" }), false), outcome: { done: "dropped" } };
  }
  if (state !== "ack") return { outcome: { done: "nothing" } };
  if (!("error" in checked) && record?.button) {
    const body = applyRerun(markdown, target.id, checked);
    if (body !== null) return { file: withRecord(body, block, target.id, (r) => ({ ...finished({ status: "suggested", ...(checked.note && { note: checked.note }) })(r), status: "button" }), true), outcome: { done: "applied" } };
  }
  if (!("error" in checked)) return { file: move(src, target.id, "sug", finished(checked)), outcome: { done: checked.status === "declined" ? "declined" : "suggested" } };

  const failures = (record?.failures ?? 0) + 1;
  if (failures >= maxFailures()) {
    const note = `The run failed ${failures} times in a row, so it was given up; the last time: ${checked.error}`;
    return { file: move(src, target.id, "sug", (r) => ({ ...finished({ status: "declined", note })(r), failures })), outcome: { done: "declined" } };
  }
  return { file: withRecord(markdown, block, target.id, (r) => ({ ...base(r), failures, note: checked.error }), false), outcome: { done: "failed", error: checked.error, failures } };
}

/**
 * The body with a re-run's result in place of its range, the task back at `:btn`; null when it has to wait for the writer
 * instead: nothing to put in (a decline, an answer), the writer changed that text during the run (it would be lost), or
 * the page isn't as the page itself would write it (writing it back would change text nobody asked to change).
 */
function applyRerun(markdown: string, id: string, c: Checked): string | null {
  if (c.suggestion === undefined) return null;
  const doc = markdownToDoc(markdown);
  const spots = markerSpots(doc, id);
  if (!spots || rangeText(doc, spots) !== c.saw || canonicalBody(docToMarkdown(doc)) !== canonicalBody(markdown)) return null;
  const tr = new Transform(doc);
  return decide(tr, id, "accepted", { ...c, button: { at: "" } }) ? docToMarkdown(tr.doc) : null;
}

/**
 * What the agent said in the chat about task `target`, once the writer has seen its suggestion (the
 * task at `:sug`): a `<suggestion>` in it, or a `suggest` call (`reply`, a `Reply`), replaces the one on the card, checked like a run's. The body doesn't
 * change. Anything else is conversation and changes nothing (`file` absent, no `error`); a `<suggestion>` that can't
 * be used gives `error` and leaves the record as it was.
 */
export function reviseSuggestion(src: string, target: { id: string; taskType: string }, reply: string | Reply, now = new Date()): { file?: string; error?: string } {
  const { markdown, block } = parseFile(src);
  if (taskStates(markdown).get(target.id) !== "sug") return {};
  const parsed = typeof reply === "string" ? parseReply(reply) : reply;
  if ("error" in parsed || parsed.kind === "decline") return {};
  const taken = takenIds(markdown, block);
  const checked = checkReply(parsed, markdown, { ...target, ...flagsOf(block.tasks?.[target.id]) }, taken);
  if ("error" in checked) return { error: checked.error };
  return {
    file: withRecord(markdown, block, target.id, (r) => {
      const { mode: _m, place: _p, suggestion: _x, edits: _e, answer: _a, saw: _s, note: _n, ...rest } = r ?? { type: target.taskType, created_by: "writer" as const, created: now.toISOString(), status: "suggested" as const };
      return { ...rest, ...checked, finished: now.toISOString() };
    }, false),
  };
}

/** Why a range result can't be used from a chat on a task whose suggestion was decided already. */
const DECIDED = "This request's suggestion is no longer waiting: the writer has already decided on it, so there is no card to replace and no range to put a result at. Change the page with `edits` (its blocks as they are now), or add new blocks at the end of the page with mode=\"at\".";

/**
 * What the agent said in the chat about task `target`: while its suggestion waits (`:sug`), a suggestion in it replaces
 * the card's (`reviseSuggestion`). Once the writer has decided on it (accepted, kept as a button, rejected), a
 * suggestion becomes a new one at the end of the page, as the page's chat makes them (`suggestOnPage`): changes to
 * other blocks, or blocks added there. `created`: it is a new one.
 */
export function suggestFromTaskChat(src: string, target: { id: string; taskType: string }, reply: string | Reply, now = new Date(), random = Math.random): { file?: string; error?: string; created?: boolean } {
  if (taskStates(parseFile(src).markdown).get(target.id) === "sug") return reviseSuggestion(src, target, reply, now);
  const parsed = typeof reply === "string" ? parseReply(reply) : reply;
  if (!("error" in parsed) && parsed.kind === "suggestion" && parsed.suggestion !== undefined && parsed.mode !== "at") return { error: DECIDED };
  const r = suggestOnPage(src, reply, now, random);
  return r.file ? { file: r.file, created: true } : r;
}

/** Settled records, whose proposal is kept a while after the writer's decision (so Undo can bring it back). */
const decidedLongAgo = (r: TaskRecord, now: number, keepMs: number) =>
  !!r.reviewed && (r.suggestion !== undefined || r.edits !== undefined || r.answer !== undefined || r.saw !== undefined) && r.status !== "pending" && r.status !== "suggested" && Date.parse(r.reviewed) + keepMs <= now;

/**
 * Drops `proposal`, `edits`, `answer` and `saw` from the records of suggestions the writer decided at least `keepMs` ago. A record keeps
 * its status, times and note. One asked again keeps its proposal for the next run's prompt.
 */
export function pruneSuggestions(block: CommentsBlock, now = new Date(), keepMs: number): { block: CommentsBlock; settled: string[] } {
  const records = block.tasks ?? {};
  const settled = Object.keys(records).filter((id) => decidedLongAgo(records[id]!, now.getTime(), keepMs));
  if (!settled.length) return { block, settled };
  const next = { ...records };
  for (const id of settled) {
    const { suggestion: _p, edits: _e, answer: _a, saw: _s, ...rest } = next[id]!;
    next[id] = rest;
  }
  return { block: { ...block, tasks: next }, settled };
}

/** When the next decided suggestion's proposal may be dropped (epoch ms), or null when none waits. */
export function nextSuggestionExpiry(block: CommentsBlock, keepMs: number): number | null {
  const times = Object.values(block.tasks ?? {})
    .filter((r) => r.reviewed && (r.suggestion !== undefined || r.edits !== undefined || r.saw !== undefined) && r.status !== "pending" && r.status !== "suggested")
    .map((r) => Date.parse(r.reviewed!) + keepMs);
  return times.length ? Math.min(...times) : null;
}

/** The task type of the task `suggestOnPage` adds: a point, whose suggestion goes `at` it. */
const PAGE_TASK_TYPE = "gen";

/**
 * A change to the page the agent proposed in the page's chat (`chat/page.ts`), which has no task to answer: the
 * server adds one, a point at the end of the page already at `:sug`, and records the reply on it as a run's would be, so
 * the page shows it as any suggestion (blocks added at the end by a `suggest` call `at`/`blocks` or the envelope's
 * `<suggestion>`, other blocks changed by its `edits`). An answer, a decline or a reply without an envelope is
 * conversation: `{}`. One that can't be used gives `error`.
 */
export function suggestOnPage(src: string, reply: string | Reply, now = new Date(), random = Math.random): { file?: string; error?: string; id?: string } {
  const parsed = typeof reply === "string" ? parseReply(reply) : reply;
  if ("error" in parsed || parsed.kind !== "suggestion") return typeof reply === "string" && /<(suggestion|edit)\b/.test(reply) && "error" in parsed ? { error: parsed.error } : {};
  const { markdown, block } = parseFile(src);
  const taken = new Set([...taskStates(markdown).keys(), ...Object.keys(block.tasks ?? {})]);
  const id = newTaskId(taken, random);
  const target = { id, taskType: PAGE_TASK_TYPE };
  const body = `${markdown.replace(/\s+$/, "")}\n\n${commentFor("p", PAGE_TASK_TYPE, id, "sug")}\n`;
  const checked = checkReply(parsed, body, target, taken);
  if ("error" in checked) return { error: checked.error };
  const record: TaskRecord = { type: PAGE_TASK_TYPE, created_by: "writer", created: now.toISOString(), ...checked, finished: now.toISOString() };
  return { file: withRecord(body, block, id, () => record, true), id };
}

/**
 * The writer set how often task `id`'s button runs on its own (`every`, one of `BUTTON_EVERY`), or took that off
 * (null). The body doesn't change. An error when the task has no button or `every` isn't one of the choices.
 */
export function scheduleButton(src: string, id: string, every: number | null, now = new Date()): { file?: string; error?: string } {
  const { markdown, block } = parseFile(src);
  const r = block.tasks?.[id];
  if (!r?.button || taskStates(markdown).get(id) === undefined) return { error: "That request has no button." };
  if (every !== null && !(BUTTON_EVERY as readonly number[]).includes(every)) return { error: `every must be one of ${BUTTON_EVERY.join(", ")} (ms), or null.` };
  const { every: _e, from: _f, ...button } = r.button;
  return { file: withRecord(markdown, block, id, () => ({ ...r, button: every === null ? button : { ...button, every, from: now.toISOString() } }), false) };
}

/**
 * The buttons of `src` whose schedule is due at `now`, pressed as the writer presses one: each marker back to pending, its
 * record pending again with the result it holds dropped (`recordDecisions` does the same for a press). Null when none is due.
 */
export function pressDueButtons(src: string, now = new Date()): { file: string; ids: string[] } | null {
  const { markdown, block } = parseFile(src);
  const states = taskStates(markdown);
  const records = block.tasks ?? {};
  const ids = Object.keys(records).filter((id) => states.get(id) === "btn" && (nextRunAt(records[id]) ?? Infinity) <= now.getTime());
  if (!ids.length) return null;
  const body = mapMarkerComments(markdown, (c) => (ids.includes(c.id) ? commentFor(c.part, c.taskType, c.id, "pending", c.instruction) : c.whole));
  const tasks = { ...records };
  for (const id of ids) {
    const { suggestion: _p, mode: _m, place: _l, edits: _e, answer: _a, saw: _s, note: _n, ...rest } = records[id]!;
    tasks[id] = { ...rest, status: "pending", asked_again: (rest.asked_again ?? 0) + 1, reviewed: now.toISOString() };
  }
  const rev = block.meta.rev + 1;
  return { ids, file: serializeFile(body, { ...block, meta: { rev, body_rev: rev, body_by: "server" }, tasks }) };
}
