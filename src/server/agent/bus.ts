import type { ChatEvent } from "../../shared/chat";
import { runtime } from "../runtime";

/**
 * What each task's agent streams (`StartOptions.onStream`), passed on to the chats open on it. The agent loop
 * and the chat both start agents; whoever started one, its stream comes here.
 */
type Listener = (e: ChatEvent) => void;
const key = (id: string, task: string) => `${id}/${task}`;

export function publish(id: string, task: string, e: ChatEvent) {
  for (const f of runtime().bus.get(key(id, task)) ?? []) f(e);
}

/** Listens to task `task`'s agent; the returned function stops. */
export function listen(id: string, task: string, f: Listener): () => void {
  const k = key(id, task);
  const listeners = runtime().bus;
  const set = listeners.get(k) ?? new Set<Listener>();
  listeners.set(k, set.add(f));
  return () => { set.delete(f); if (!set.size) listeners.delete(k); };
}
