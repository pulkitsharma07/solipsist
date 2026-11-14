import { EngineIcon } from "./EngineIcon";

/** What the page-wide chat's agent is doing (`src/server/agent/pageChatStatus.ts`), as the agent stream tells it. */
export type PageChatState = "none" | "snoozed" | "waiting" | "open" | "working";
export interface PageChatStatus { state: PageChatState; unread?: boolean }

/** What the button says of each state, after "Chat with <engine> about this page". */
const SAYS: Record<PageChatState, string> = {
  none: "",
  snoozed: "its conversation is kept",
  waiting: "its agent is up",
  open: "open",
  working: "it is replying",
};

/** Reads a status from the stream, or null when it isn't one. */
export function asPageChatStatus(x: unknown): PageChatStatus | null {
  const s = x as PageChatStatus | null;
  return s && typeof s === "object" && s.state in SAYS ? { state: s.state, ...(s.unread && { unread: true }) } : null;
}

/**
 * The page chat's button, top right of the sheet: the page's engine mark, and how its agent is. Quiet with no agent;
 * a held glow while the agent is up; a light running round its edge while it replies; a dot when a reply came while
 * the chat was closed. Still under reduced motion: the states show by colour alone.
 */
export function ChatLaunch({ engine, engineTitle, status = { state: "none" }, onOpen }: { engine: string; engineTitle: string; status?: PageChatStatus; onOpen(): void }) {
  const says = [SAYS[status.state], status.unread && "a new reply"].filter(Boolean).join(", ");
  const label = `Chat with ${engineTitle} about this page${says ? ` (${says})` : ""}`;
  return (
    <button type="button" className="pi-launch" data-state={status.state} title={label} aria-label={label} onClick={onOpen}>
      {status.state === "working" && <><span className="pi-launch-halo" aria-hidden="true" /><span className="pi-launch-ring" aria-hidden="true" /></>}
      <EngineIcon engine={engine} size={28} />
      {status.unread && <span className="pi-launch-dot" aria-hidden="true" />}
    </button>
  );
}
