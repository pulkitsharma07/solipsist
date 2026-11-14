import { isScalar, parseDocument, Scalar, stringify, visit } from "yaml";
import type { Anchor } from "./anchor";

export type CommentStatus = "open" | "orphaned" | "dismissed";

export interface CommentEntry {
  id: string;
  status: CommentStatus;
  thinker: string;
  title: string;
  gloss?: string;
  body?: string;
  importance?: "high" | "low";
  /** Why it is in the text, in the reviewer's own voice: two to four sentences, shown when the card is open. */
  description?: string;
  /**
   * A picture the reviewer drew for this question, as the page would write the path (`images/<page id>/x.svg`),
   * shown in the open card. It is a file in the page's own image folder, the only place a reviewer may write. An
   * animated SVG animates in an `<img>`; a script inside one does not run, which is why it is served that way.
   */
  image?: string;
  /**
   * The `engine:model` the reviewer ran on when it raised this. Shown in the question's own window, so the writer
   * can see who asked — the same question from a small model and a large one is not the same question.
   */
  model?: string;
  /** What it was scored out of 10 (`review.curator`). Decides which comment holds a block when they compete. */
  score?: number;
  /** When the writer first opened the card. Absent means unread, so a better comment may take its place. */
  opened_at?: string;
  anchor: Anchor;
  created: string;
  /** The rev that added it. Informational. */
  created_rev: number;
  orphaned_at?: string;
}

export interface Meta {
  /** +1 on every write of the file, by anyone. */
  rev: number;
  /** The rev at which the body last changed, and who changed it: a tab's client id, "disk" (a hand edit, the agent), or "server". */
  body_rev: number;
  body_by: string | null;
}

/**
 * Where a suggestion goes: `at` a point's spot, `replace` a range's text, or `after` a range. `inline` content stays
 * inside the block; `blocks` are whole blocks.
 */
export type SuggestionMode = "at" | "replace" | "after";
export type SuggestionPlace = "inline" | "blocks";

/**
 * A change a suggestion makes elsewhere in the page: the whole top-level blocks `before` (as markdown, found by what
 * they say) replaced by `after` (empty: removed).
 */
export interface SuggestionEdit { before: string; after: string }

/** The agent that made a suggestion and is kept after it: its conversation, to wake or chat with. */
export interface TaskAgent { engine: string; model: string; session: string }

/**
 * - `suggested` / `declined`: the run is over and its result (or its reason) waits for the writer, the marker at `:sug`.
 * - `accepted` / `rejected`: the writer decided. `edited`: the writer removed a `:sug` marker by hand.
 * - `dropped`: the writer deleted the marker while its run was working; the proposal is kept here.
 * - `button`: the marker is at `:btn`, around a result the writer kept as a button; nothing waits for them.
 */
export type TaskStatus = "pending" | "ack" | "suggested" | "declined" | "accepted" | "rejected" | "edited" | "dropped" | "button";

/** What is kept about one marker, under its id. It stays after the marker is removed from the page. */
export interface TaskRecord {
  /** The task type (`gen`, `sel`, …). */
  type: string;
  created_by: "writer" | "agent";
  /** For one the agent made: the id of the marker it was working on at the time. */
  created_from?: string;
  created: string;
  acked?: string;
  finished?: string;
  status: TaskStatus;
  /** One short line: what was done, or why nothing was. */
  note?: string;
  /** The suggestion: where it goes and the markdown to put there (canonical; empty means delete, for `replace`). */
  mode?: SuggestionMode;
  place?: SuggestionPlace;
  suggestion?: string;
  /** Changes to other blocks of the page that come with it, applied on Accept. */
  edits?: SuggestionEdit[];
  /**
   * The agent's answer to a question about the text (markdown), in place of a suggestion: shown to the writer, put in
   * nothing. The marker waits at `:sug` until they dismiss it.
   */
  answer?: string;
  /** A range's text as the run read it, so the page can tell when it changed since. */
  saw?: string;
  /** When the writer accepted or rejected it. */
  reviewed?: string;
  /** Runs in a row whose reply couldn't be used. */
  failures?: number;
  /** How many times the writer asked again. */
  asked_again?: number;
  /**
   * The writer accepted a result as a button: the task can be run again, and a run's
   * result then goes straight into the page. `at`: when, so an Undo of that very decision can take it away.
   */
  button?: {
    at: string;
    /** It runs on its own this often (ms, one of `BUTTON_EVERY`), page open or not (the server's schedule). Absent: only when pressed. */
    every?: number;
    /** When the writer set `every`: the first run on its own is that long after. */
    from?: string;
  };
  /** The writer asked again for a result that can be a button: the runs are told so, and held to it. */
  wants_button?: boolean;
  /** The agent behind the suggestion, for an engine that keeps its conversation (Pi). */
  agent?: TaskAgent;
}

/**
 * The page's agent settings, set from the page and kept in its file so a reload, a second browser and the terminal
 * view agree. Only what differs from the default is written: `on` is absent while the agents are on, `model` while the
 * page uses the default (an `engine:model` choice).
 */
export interface AgentSettings {
  /**
   * False: the writer turned the page's agents off.
   */
  on?: boolean;
  model?: string;
  /** The page-wide chat's conversation (`src/server/chat/page.ts`), kept so it can be taken up again. */
  chat?: TaskAgent;
  /**
   * The page's one lasting agent in single-agent mode (`agent.single_agent`), kept so the next request takes its
   * conversation up again after it has snoozed, or after a restart.
   */
  solo?: TaskAgent;
}

export interface CommentsBlock {
  meta: Meta;
  /**
   * Keys of the block this build doesn't know, written back as they were read: a newer build can add one without a
   * format bump, and an older build editing the page doesn't drop it.
   */
  extra?: Record<string, unknown>;
  agent?: AgentSettings;
  comments: Record<string, CommentEntry>;
  /** Each task's record, by id. Absent until there is something in it. */
  tasks?: Record<string, TaskRecord>;
}

export interface DocFile {
  markdown: string;
  block: CommentsBlock;
  /** The page format the file was written in (`FORMAT`); a file from before the number was written is format 1. */
  format: number;
  /** Set when the comments block was there but unreadable: the caller keeps a copy of the file aside. */
  problem?: "bad-block";
}

/**
 * The page format this build reads and writes: the hidden block's keys and meanings and the marker comments' syntax.
 * Raised only for a change an older build would get wrong (`CONTRIBUTING.md`, "What a version number promises"); a new
 * key needs no raise, since every build keeps the keys it doesn't know (`extra`). A page in a higher format than this
 * is shown but never written: the server refuses every write to it (`readModifyWrite`), and the page says why.
 * Every format's pages are kept in `test/fixtures/format-<n>/`, which every later build must open and round-trip.
 */
export const FORMAT = 1;

/** A `format` as written: absent is 1 (files from before it was written); anything but a whole number is unreadable, so newer. */
const formatValue = (x: unknown) => (x === undefined ? 1 : typeof x === "number" && Number.isInteger(x) && x >= 1 ? x : Number.POSITIVE_INFINITY);

export const BLOCK_NAME = "solip-comments";
const OPEN = `<!-- ${BLOCK_NAME}\n`;
const CLOSE = /\n-->\s*$/;
/** The end of a block with text after it. */
const AFTER_CLOSE = "\n-->\n";

export const emptyBlock = (): CommentsBlock => ({ meta: { rev: 0, body_rev: 0, body_by: null }, comments: {} });

/**
 * Splits a file into its markdown body and the comments block: the last `<!-- solip-comments` comment, and only if
 * it runs to the very end of the file. Text the writer types can't fake one: the markdown serializer writes `<` as
 * `&lt;`. Text after a block that reads fine was added below it by hand (`echo … >> page.md`): it is the end of the body.
 */
export function parseFile(src: string): DocFile {
  const at = src.lastIndexOf(`\n${OPEN}`);
  const start = at === -1 && src.startsWith(OPEN) ? 0 : at === -1 ? -1 : at + 1;
  if (start === -1) return { markdown: src, block: emptyBlock(), format: 1 };
  const rest = src.slice(start + OPEN.length);
  const close = rest.match(CLOSE);
  if (!close) {
    const end = rest.indexOf(AFTER_CLOSE);
    const after = end === -1 ? "" : rest.slice(end + AFTER_CLOSE.length).trim();
    if (!after || !parseBlock(rest.slice(0, end))) return { markdown: src, block: emptyBlock(), format: 1 };
    const before = src.slice(0, start).trimEnd();
    return parseFile(`${before ? `${before}\n\n` : ""}${after}\n\n${src.slice(start, start + OPEN.length + end + AFTER_CLOSE.length)}`);
  }
  const markdown = canonicalBody(src.slice(0, start));
  const parsed = parseBlock(rest.slice(0, close.index));
  if (!parsed) return { markdown, block: emptyBlock(), problem: "bad-block", format: 1 };
  const { format, meta, comments, agent: savedAgent, tasks, extra: _never, ...unknown } = parsed as Partial<CommentsBlock> & Record<string, unknown>;
  const agent = agentSettings(savedAgent);
  return {
    markdown,
    format: formatValue(format),
    block: { meta: { ...emptyBlock().meta, ...meta }, comments: comments ?? {}, ...(agent && { agent }), ...(tasks && { tasks }), ...(Object.keys(unknown).length && { extra: unknown }) },
  };
}

/**
 * The format of a file, read cheaply (no YAML): the block's top-level `format` line, which `serializeFile` writes first.
 * The same answer as `parseFile(src).format` for any file this or an older build wrote.
 */
export function formatOf(src: string): number {
  const at = src.lastIndexOf(`\n${OPEN}`);
  const start = at === -1 ? (src.startsWith(OPEN) ? 0 : -1) : at + 1;
  if (start === -1) return 1;
  const line = src.slice(start + OPEN.length).match(/^"?format"?:[ \t]*(.*)$/m);
  if (!line) return 1;
  const n = Number(line[1]!.trim());
  return formatValue(Number.isNaN(n) ? line[1] : n);
}

/** The agent settings a file holds, read strictly (anything else in the block is ignored); undefined when it holds none. */
function agentSettings(x: unknown): AgentSettings | undefined {
  if (!x || typeof x !== "object") return undefined;
  const { on, model, chat, solo, ...unknown } = x as Record<string, unknown>;
  const out: AgentSettings = {
    // Kept as written: a newer build's setting, which this one doesn't use.
    ...unknown,
    ...(typeof on === "boolean" && { on }),
    ...(typeof model === "string" && model.trim() && { model: model.trim() }),
    ...(agentRef(chat) && { chat: agentRef(chat)! }),
    ...(agentRef(solo) && { solo: agentRef(solo)! }),
  };
  return Object.keys(out).length ? out : undefined;
}

/** One recorded conversation in the settings (the chat's, the lasting agent's), read strictly; null when it isn't one. */
function agentRef(x: unknown): TaskAgent | null {
  const c = x && typeof x === "object" ? x as Record<string, unknown> : null;
  if (!c || ![c.engine, c.model, c.session].every((v) => typeof v === "string" && v)) return null;
  return { engine: c.engine as string, model: c.model as string, session: c.session as string };
}

/**
 * The block's text as an object, or null when it isn't a YAML mapping. The block used to be JSON, which is also YAML, so
 * old files read the same. Keys are kept as written: an id such as `1e5` stays that text and is not read as a number.
 */
function parseBlock(text: string): Partial<CommentsBlock> | null {
  const doc = parseDocument(text);
  if (doc.errors.length) return null;
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && typeof pair.key.value !== "string") pair.key = new Scalar(pair.key.source ?? String(pair.key.value));
    },
  });
  const value = doc.toJS();
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<CommentsBlock>) : null;
}

/**
 * The block as YAML. Every string is double-quoted, so `<` and `>` can be written as \u003c / \u003e (a valid escape in
 * a double-quoted string) and nothing in a comment can end the block early. Lines are never folded.
 */
const encodeBlock = (block: CommentsBlock) =>
  stringify(block, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "QUOTE_DOUBLE", lineWidth: 0 })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .trimEnd();

/**
 * The body as the file stores it: the one definition used wherever a body is stored, sent or compared. Blank is empty;
 * otherwise trailing blank lines are dropped but not the spaces on the last line: an empty list item at the very end is
 * "2. ", and without its space ("2.") it would read back as text.
 */
export const canonicalBody = (markdown: string) => (markdown.trim() === "" ? "" : markdown.replace(/(?:\r?\n[ \t]*)+$/, ""));

export function serializeFile(markdown: string, block: CommentsBlock): string {
  const body = canonicalBody(markdown);
  // The format first, so `formatOf` can read it without parsing; then any keys this build doesn't know, as they were.
  const { extra, ...known } = block;
  return `${body ? `${body}\n\n` : ""}${OPEN}${encodeBlock({ format: FORMAT, ...extra, ...known } as CommentsBlock)}\n-->\n`;
}
