import { commentFor, mapMarkerComments, markdownToDoc, markerComments, markersIn, taskStates, ORPHAN_KEEP_MS, parseFile, scrubMarkers, pruneOrphans, serializeFile, setStatus, type Anchor, type CommentsBlock, type TaskRecord } from "../shared/docfile";
import { pruneSuggestions } from "./suggest";

export interface PutRequest {
  client_id: string;
  /** The rev of the last file this tab received and applied. */
  base_rev: number;
  markdown: string;
  /**
   * The tab's state for every comment it has received. `opened` on an open one says the writer has read the card,
   * which keeps a better comment from taking its block; `dismissed` is the writer taking it down for good.
   */
  comments: Record<string, { status: "open"; anchor: Anchor; opened?: boolean } | { status: "orphaned" } | { status: "dismissed" }>;
  /** What the writer decided on suggestions since the last save, by task id. */
  decisions?: Record<string, Decision>;
}

export type Decision = "accepted" | "rejected" | "asked_again" | "button" | "asked_for_button";

export type PutResult = { ok: true; rev: number; file: string } | { ok: false; code: "body_changed_elsewhere"; rev: number; file: string };

/**
 * Gives a record to every task in `markdown` that has none: the writer's own, as a save is how they reach the
 * file, or the agent's, when it came in with a suggestion the writer accepted (`created_from` names that one).
 */
function recordWriterTasks(block: CommentsBlock, markdown: string, now: Date, accepted: string[]): CommentsBlock {
  const known = block.tasks ?? {};
  const added: Record<string, TaskRecord> = {};
  const wrote = (a: string) => [known[a]?.suggestion ?? "", ...(known[a]?.edits ?? []).map((e) => e.after)].join("\n\n");
  const from = (id: string) => accepted.find((a) => markerComments(wrote(a)).some((c) => c.id === id));
  for (const c of markerComments(markdown)) {
    if (c.id in known || c.id in added || c.part === "e") continue;
    const source = from(c.id);
    added[c.id] = { type: c.taskType, created_by: source ? "agent" : "writer", ...(source && { created_from: source }), created: now.toISOString(), status: "pending" };
  }
  return Object.keys(added).length ? { ...block, tasks: { ...known, ...added } } : block;
}

/** A record whose suggestion the writer has dealt with. */
const SETTLED = new Set<TaskRecord["status"]>(["accepted", "rejected", "edited", "button"]);

/**
 * The writer's decisions on suggestions, into their records, checked against the body being saved: accepted or
 * rejected only if the task is gone, asked again only if it waits again. A suggestion gone with no decision was
 * removed by hand (`edited`); one back at `:sug` (an Undo) is waiting again. A decline dismissed stays `declined`,
 * with the time it was dismissed. A task at `:btn` has a button, however it got there; one whose button went (`×`, or its
 * text deleted) counts as accepted.
 */
function recordDecisions(block: CommentsBlock, markdown: string, decisions: Record<string, Decision>, now: Date): CommentsBlock {
  const records = block.tasks;
  if (!records) return block;
  const states = taskStates(markdown);
  const at = now.toISOString();
  const next: Record<string, TaskRecord> = { ...records };
  let changed = false;
  const set = (id: string, r: TaskRecord) => { next[id] = r; changed = true; };
  for (const [id, r] of Object.entries(records)) {
    const state = states.get(id);
    const decision = decisions[id];
    if (state === "btn" && r.status !== "button") {
      set(id, { ...r, status: "button", reviewed: at, button: r.button ?? { at } });
    } else if (decision === "asked_again" && state === "pending" && r.status === "button") {
      // The result it holds is in the page now: the next run must not be told it was turned down.
      const { suggestion: _p, mode: _m, place: _l, edits: _e, answer: _a, saw: _s, note: _n, ...rest } = r;
      set(id, { ...rest, status: "pending", asked_again: (r.asked_again ?? 0) + 1, reviewed: at });
    } else if ((decision === "asked_again" || decision === "asked_for_button") && state === "pending" && (r.status === "suggested" || r.status === "declined")) {
      set(id, { ...r, status: "pending", asked_again: (r.asked_again ?? 0) + 1, reviewed: at, ...(decision === "asked_for_button" && { wants_button: true }) });
    } else if (state === undefined && r.status === "button") {
      set(id, { ...r, status: "accepted", reviewed: at });
    } else if (state === undefined && (r.status === "suggested" || (r.status === "declined" && !r.reviewed))) {
      const settled = decision === "accepted" || decision === "rejected" ? decision : "edited";
      set(id, r.status === "declined" ? { ...r, reviewed: at } : { ...r, status: settled, reviewed: at });
    } else if (state === "sug" && (SETTLED.has(r.status) || (r.status === "declined" && r.reviewed))) {
      const { reviewed: _, ...kept } = r;
      // Undoing the decision that made the button takes the button away too.
      const { button: _b, ...withoutButton } = kept;
      const rest: Omit<TaskRecord, "reviewed"> = r.button?.at === r.reviewed ? withoutButton : kept;
      set(id, { ...rest, status: rest.suggestion === undefined && !rest.edits?.length ? "declined" : "suggested" });
    }
  }
  return changed ? { ...block, tasks: next } : block;
}

/**
 * A save (plan section 5.1). The server trusts the client: it writes the body and the comment states it was sent,
 * as they are, and leaves every other comment untouched. It refuses only a tab that hasn't seen a body written by
 * someone else (another tab, or a hand edit on disk).
 */
export function applyPut(src: string, req: PutRequest, now = new Date(), keepMs = ORPHAN_KEEP_MS): PutResult {
  const { block } = parseFile(src);
  const { meta } = block;
  if (meta.body_by !== null && meta.body_by !== req.client_id && meta.body_rev > req.base_rev) {
    return { ok: false, code: "body_changed_elsewhere", rev: meta.rev, file: src };
  }
  const rev = meta.rev + 1;
  let next: CommentsBlock = { ...block, meta: { rev, body_rev: rev, body_by: req.client_id } };
  for (const [id, state] of Object.entries(req.comments)) {
    // Unknown ids are ignored, and so are dismissed comments: the writer took them down, a tab can't reopen or orphan them.
    if (!next.comments[id] || next.comments[id]!.status === "dismissed") continue;
    if (state.status === "dismissed") next = setStatus(next, id, "dismissed", { now });
    else if (state.status === "orphaned") next = setStatus(next, id, "orphaned", { now });
    else next = setStatus(next, id, "open", { anchor: state.anchor, now, ...(state.opened && { opened: true }) });
  }
  next = pruneOrphans(next, now, keepMs).block;
  const markdown = scrubMarkers(req.markdown);
  const decisions = req.decisions ?? {};
  next = recordDecisions(next, markdown, decisions, now);
  const accepted = Object.keys(decisions).filter((id) => decisions[id] === "accepted");
  return { ok: true, rev, file: serializeFile(markdown, recordWriterTasks(next, markdown, now, accepted)) };
}

/** A change to the file the server didn't write (a hand edit): record it as a body change by "disk". */
export function recordDiskEdit(src: string): string {
  const { markdown, block } = parseFile(src);
  const rev = block.meta.rev + 1;
  return serializeFile(markdown, { ...block, meta: { rev, body_rev: rev, body_by: "disk" } });
}

/**
 * The cleanup stage: removes orphaned comments (their passage is gone) once they've been orphaned for `keepMs`, and
 * the proposals of suggestions the writer decided on that long ago (kept until then, so Undo can bring one back).
 * Returns the new file, with the rev bumped and the body untouched, or null when there was nothing to remove.
 */
export function pruneFile(src: string, now = new Date(), keepMs = ORPHAN_KEEP_MS): { file: string; removed: string[] } | null {
  const { markdown, block } = parseFile(src);
  const { block: orphansGone, removed } = pruneOrphans(block, now, keepMs);
  const { block: pruned, settled } = pruneSuggestions(orphansGone, now, keepMs);
  if (!removed.length && !settled.length) return null;
  return { file: serializeFile(markdown, { ...pruned, meta: { ...pruned.meta, rev: pruned.meta.rev + 1 } }), removed };
}

/**
 * Moves every acknowledged task back to pending, except those in `keep` (a run is working on them): only the
 * `:ack` suffix of its comments changes, and its record says why. Used when no run is working on the task any
 * more (its run just ended, or none has started), so an `:ack` there is a spinner nobody will stop. Returns the new
 * file and the ids, or null when there was none.
 */
export function resetAcks(src: string, now = new Date(), keep: ReadonlySet<string> = new Set()): { file: string; ids: string[] } | null {
  const { markdown, block } = parseFile(src);
  const ids = [...new Set(markersIn(markdownToDoc(markdown)).filter((p) => p.state === "ack" && !keep.has(p.id)).map((p) => p.id))];
  if (!ids.length) return null;
  const body = mapMarkerComments(markdown, (c) => (c.state === "ack" && ids.includes(c.id) ? commentFor(c.part, c.taskType, c.id, "pending", c.instruction) : c.whole));
  const tasks = { ...block.tasks };
  for (const id of ids) {
    const r = tasks[id];
    if (r) tasks[id] = { ...r, status: "pending", note: `Reset at ${now.toISOString()}: no run was working on it any more.` };
  }
  const rev = block.meta.rev + 1;
  return { ids, file: serializeFile(body, { ...block, meta: { rev, body_rev: rev, body_by: "server" }, ...(block.tasks && { tasks }) }) };
}
