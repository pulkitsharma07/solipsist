/**
 * A chat with an agent, behind a suggestion or page-wide: the conversation as the page
 * shows it, and the events that change it as the agent streams. Used by the server (an engine turns its own events
 * into these) and by the page (`applyChatEvent`).
 */

/**
 * One part of a message: text, the model's thinking, or a tool call with its result once it has one. `reply`: one of
 * Solipsist's own tools (`agent/replyTools.ts`), which is not work the agent did but the result it gave back, so the
 * chat shows it apart from the agent's own calls (`ReplyCard`).
 */
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; brief: string; args: string; result?: string; isError?: boolean; running?: boolean; durationMs?: number; reply?: boolean };

export type ChatTool = Extract<ChatBlock, { type: "tool" }>;

/**
 * Solipsist's own tools, by the names the chat shows them under (`agent/replyTools.ts` defines them; an engine of its
 * own may name them longer, as an MCP server's `mcp__solipsist__suggest`, which its stream shortens). `test/chat.test.ts`
 * holds this list to the server's.
 */
export const REPLY_TOOL_NAMES = ["suggest", "answer", "decline"] as const;
/** Whether a tool call is one of Solipsist's: what the engine said, or, for a stream that doesn't say, its name. */
export const isReplyTool = (b: Pick<ChatTool, "name" | "reply">) => b.reply ?? (REPLY_TOOL_NAMES as readonly string[]).includes(b.name);

/** What a call to one of Solipsist's tools says, as the chat shows it. */
export interface ReplyCall {
  tool: "suggest" | "answer" | "decline";
  /** What the writer reads it as: Suggestion, Answer, Declined. */
  label: string;
  /** `suggest`: the markdown it proposes, and where it goes ("at · inline"). */
  markdown?: string;
  where?: string;
  /** `suggest`: changes to other blocks of the page, applied with the result. */
  edits?: { before: string; after: string }[];
  answer?: string;
  reason?: string;
  note?: string;
}

const LABEL: Record<string, string> = { suggest: "Suggestion", answer: "Answer", decline: "Declined" };

/**
 * A call to one of Solipsist's tools, read from its arguments for the chat to show; null when they can't be read (a
 * call still streaming in, or one clipped short), and the chat shows it as any other tool call instead.
 */
export function readReplyCall(b: Pick<ChatTool, "name" | "args" | "reply">): ReplyCall | null {
  const tool = b.name as ReplyCall["tool"];
  if (!LABEL[tool] || !isReplyTool(b)) return null;
  let args: Record<string, unknown>;
  try { args = JSON.parse(b.args || "{}") as Record<string, unknown>; } catch { return null; }
  if (!args || typeof args !== "object") return null;
  const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
  const edits = Array.isArray(args.edits)
    ? (args.edits as unknown[]).filter((e): e is { before: string; after: string } => !!e && typeof e === "object" && typeof (e as any).before === "string" && typeof (e as any).after === "string")
    : undefined;
  return {
    tool,
    label: LABEL[tool]!,
    ...(typeof args.markdown === "string" && { markdown: args.markdown.trim() }),
    ...(str("mode") && { where: [str("mode"), str("place")].filter(Boolean).join(" · ") }),
    ...(edits?.length && { edits }),
    ...(str("answer") && { answer: str("answer") }),
    ...(str("reason") && { reason: str("reason") }),
    ...(str("note") && { note: str("note") }),
  };
}

/** What a reply cost and how fast it came: tokens in and out, dollars, and output tokens a second. */
export interface ChatStats { model?: string; input?: number; output?: number; costUsd?: number; ms?: number; tokensPerSec?: number }

/**
 * `user`: what the writer said in the chat. `task`: a prompt Solipsist sent the agent (a run on its task).
 * `assistant`: the agent's reply; `streaming` while it comes in.
 */
export interface ChatMessage {
  id: string;
  role: "user" | "task" | "assistant";
  blocks: ChatBlock[];
  at: number;
  stats?: ChatStats;
  error?: string;
  streaming?: boolean;
  /** While streaming, seen by the page: when the first text came, and how much has come, for a live rate. */
  live?: { firstAt: number; chars: number };
}

/** What changes a conversation. An engine sends all but `history`, `busy`, `revised` and `warning`, which the server adds. */
export type ChatEvent =
  /**
   * The whole conversation, when the chat opens, and again once it has the agent. `watching`: a run is on the
   * task (its first, say), so the chat only looks in until it ends; then this comes again without it.
   */
  | { t: "history"; messages: ChatMessage[]; busy: boolean; model?: string; watching?: boolean; steers?: boolean }
  /** A message starts (or is replaced whole, at its end). */
  | { t: "message"; message: ChatMessage }
  /** More text or thinking in block `block` of message `id`. */
  | { t: "delta"; id: string; block: number; kind: "text" | "thinking"; delta: string }
  /** A tool call in block `block` of message `id`, as soon as the model has written it. */
  | { t: "tool"; id: string; block: number; tool: Extract<ChatBlock, { type: "tool" }> }
  /** The result of tool call `toolId`. */
  | { t: "tool_result"; toolId: string; result: string; isError: boolean; durationMs?: number }
  /** Whether the agent is working on something the writer said. */
  | { t: "busy"; busy: boolean }
  /** The agent's reply carried a new suggestion: it is on the card now. */
  | { t: "revised"; created?: boolean }
  | { t: "warning"; message: string };

const blank = (kind: "text" | "thinking"): ChatBlock => ({ type: kind, text: "" });

/** The conversation after event `e`. `now` is when it arrived (for the live rate). Pure: a new array when it changed. */
export function applyChatEvent(messages: ChatMessage[], e: ChatEvent, now = Date.now()): ChatMessage[] {
  const at = (id: string) => messages.findIndex((m) => m.id === id);
  const put = (i: number, m: ChatMessage) => messages.map((x, j) => (j === i ? m : x));
  switch (e.t) {
    case "history": return e.messages;
    case "message": {
      const i = at(e.message.id);
      return i < 0 ? [...messages, e.message] : put(i, e.message);
    }
    case "delta": {
      const i = at(e.id);
      if (i < 0) return messages;
      const m = messages[i]!;
      const blocks = [...m.blocks];
      while (blocks.length <= e.block) blocks.push(blank(e.kind));
      const b = blocks[e.block]!;
      blocks[e.block] = b.type === "text" || b.type === "thinking" ? { ...b, text: b.text + e.delta } : b;
      const live = m.live ?? { firstAt: now, chars: 0 };
      return put(i, { ...m, blocks, live: { ...live, chars: live.chars + e.delta.length } });
    }
    case "tool": {
      const i = at(e.id);
      if (i < 0) return messages;
      const blocks = [...messages[i]!.blocks];
      while (blocks.length < e.block) blocks.push(blank("text"));
      blocks[e.block] = e.tool;
      return put(i, { ...messages[i]!, blocks });
    }
    case "tool_result": {
      let changed = false;
      const next = messages.map((m) => {
        if (!m.blocks.some((b) => b.type === "tool" && b.id === e.toolId)) return m;
        changed = true;
        return { ...m, blocks: m.blocks.map((b) => (b.type === "tool" && b.id === e.toolId ? { ...b, result: e.result, isError: e.isError, running: false, ...(e.durationMs !== undefined && { durationMs: e.durationMs }) } : b)) };
      });
      return changed ? next : messages;
    }
    default: return messages;
  }
}

/** About four characters a token: the rate shown while a reply streams, before the model says how many it used. */
export const liveRate = (m: ChatMessage, now = Date.now()) => {
  if (!m.live || now - m.live.firstAt < 300) return undefined;
  return m.live.chars / 4 / ((now - m.live.firstAt) / 1000);
};

const CHAT_OPEN = "<chat>";
const CHAT_CLOSE = "</chat>";

/**
 * What the agent is sent when the writer says `text` in a chat. `intro` is said before it, outside the tags, on the first
 * message of a chat (the `chat.first` and `pi-chat.first` prompts, `src/server/prompts.ts`); the writer's words are inside
 * the tags, so the conversation's history tells them from Solipsist's own prompts (`chatRole`).
 */
export function chatMessage(text: string, intro = ""): string {
  return `${intro ? `${intro}\n\n` : ""}${CHAT_OPEN}\n${text}\n${CHAT_CLOSE}`;
}

/** The target of the page-wide chat from the page's chat button (`src/server/chat/page.ts`): `/api/pages/:id/chat/page`. */
export const PAGE_CHAT = "page";

/**
 * What a reading's run is called where a task's id would be, on the page's stream and in the log (`reader/`). Longer
 * than any task id, so it can never be mistaken for one: a reading has no marker in the page and no record.
 */
export const REVIEW = "reading";

/** Whether a user message in the history was the writer's (in the chat) or Solipsist's (a run's prompt), and what to show. */
export function chatRole(content: string): { role: "user" | "task"; text: string } {
  const start = content.lastIndexOf(CHAT_OPEN);
  const end = content.lastIndexOf(CHAT_CLOSE);
  if (start >= 0 && end > start && content.trimEnd().endsWith(CHAT_CLOSE)) return { role: "user", text: content.slice(start + CHAT_OPEN.length, end).trim() };
  return { role: "task", text: content };
}
