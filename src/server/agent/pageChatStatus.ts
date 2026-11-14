/**
 * What the page-wide chat's agent (`src/server/chat/page.ts`) is doing, for the page's chat button: told in the agent
 * stream's hello and as `pichat` events. Kept apart from the chat (`chat/index.ts` sets it), so the agent stream can read it
 * without importing the chat.
 *
 * - `none`: no agent, and no conversation kept.
 * - `snoozed`: no agent now; its conversation is kept, the next open takes it up again.
 * - `waiting`: the agent is up and idle, nobody looking (it snoozes after `agent.wait_ms`).
 * - `open`: a chat window is open on it, idle.
 * - `working`: a reply is in flight, looked at or not.
 * `unread`: a reply finished while no window was open; cleared when one opens.
 */
export type PageChatState = "none" | "snoozed" | "waiting" | "open" | "working";
export interface PageChatStatus { state: PageChatState; unread?: boolean }

let provider: (id: string) => PageChatStatus = () => ({ state: "none" });
/** Set by the chat: how to tell a page's status. */
export const providePageChatStatus = (f: (id: string) => PageChatStatus) => { provider = f; };
export const pageChatStatus = (id: string): PageChatStatus => provider(id);

const listeners = new Map<string, Set<(s: PageChatStatus) => void>>();
/** Calls `f` with the page's status each time it may have changed; the returned function stops it. */
export function onPageChat(id: string, f: (s: PageChatStatus) => void): () => void {
  const set = listeners.get(id) ?? new Set();
  listeners.set(id, set.add(f));
  return () => { set.delete(f); if (!set.size) listeners.delete(id); };
}

const last = new Map<string, string>();
/** Tells those listening, when the page's status is not what it last told them. */
export function pageChatChanged(id: string) {
  const s = provider(id);
  const key = JSON.stringify(s);
  if (last.get(id) === key) return;
  last.set(id, key);
  for (const f of listeners.get(id) ?? []) f(s);
}
