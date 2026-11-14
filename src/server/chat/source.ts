import type { ChatEvent, ChatMessage } from "../../shared/chat";
import type { ChatAgent } from "../agent";
import type { Reply } from "../suggest";

/**
 * Where a chat's agent comes from and where what it gives goes (`index.ts` is the channel, written once). Two sources:
 * a task's (`task.ts`: the agent kept behind a suggestion, lent by the page's loop, `agentMachine` `chatOpen`/
 * `chatClose`) and the page's (`page.ts`: its own lasting agent, recorded in `block.agent.chat`).
 */

export type { ChatAgent };

/** A run in flight that a chat looks in on until it ends (its agent is the loop's until then). */
export interface RunWatch {
  history(): ChatMessage[];
  /** Calls `f` when the run ends, with its error if it failed; the returned function stops listening. */
  onEnd(f: (end: { error?: string }) => void): () => void;
}

/** What `lend` gives: an agent (`told`: its conversation already knows what the chat is for), a run to look in on, or why not. */
export type Lent =
  | { agent: ChatAgent; told?: boolean }
  | { watch: RunWatch }
  | { refused: { status: number; code: string; message: string } };

export interface ChatSource {
  /** The log events' prefix (`chat`, `pichat`) and the fields that say which chat. */
  readonly log: string;
  readonly fields: Record<string, string>;
  /** Lends the chat an agent, or a run to look in on, or says why it can't. */
  lend(): Promise<Lent>;
  /** Whether a live chat's agent no longer fits (the page's model changed): it is let go and a fresh one lent. */
  stale?(agent: ChatAgent): boolean;
  /** How long an agent stays with a chat no window looks at and no reply runs on, before `giveBack`. 0: at once. */
  keepMs(): number;
  /** The chat is over (`reason`): the agent goes back where it came from, or snoozes. */
  giveBack(agent: ChatAgent, reason: string): Promise<void>;
  /** Said before the writer's first message of a chat whose agent hasn't been told what it is for. */
  intro(): string;
  /** A reply tool's call, checked while the reply runs: why it can't be used, or null. */
  check(reply: Reply): string | null;
  /** Puts what a finished reply gave on the page; what to tell the chat. */
  apply(reply: string | Reply): Promise<ChatEvent[]>;
  /** New chat: forgets the conversation (only the page's chat has one to forget). */
  forget?(): Promise<void>;
  /** What the chat is doing may have changed; `seen`: a window opened; `unseen`: a reply ended with none open. */
  notify?(what: "changed" | "seen" | "unseen"): void;
  /** A reply has started (true) or ended (false): for the page to say the agent is working in the chat. */
  onBusy?(busy: boolean): void;
}
