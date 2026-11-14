import type { ChatEvent } from "../shared/chat";
import type { PageAgents } from "./agent/pageAgents";
import { config } from "./config";

/**
 * Everything the server keeps in memory about its agents, in one object: `runtime()` is the one instance, stored on
 * `globalThis` so a `bun --hot` reload reuses it (the old page agents stay reachable, `stopAllPages` sees them).
 * Tests call `resetRuntime()` to start clean.
 */
export interface Runtime {
  /** The pages whose agents are running, by id. */
  pages: Map<string, PageAgents>;
  /** The tasks whose agent the writer is chatting with, by page. */
  chats: Map<string, Set<string>>;
  /** Who wants to know when the run on a task ends, by `page/task`. */
  enders: Map<string, Set<(end: { error?: string }) => void>>;
  /** Listeners of each task's agent stream, by `page/task` (`agent/bus.ts`). */
  bus: Map<string, Set<(e: ChatEvent) => void>>;
  /**
   * Who hears that a page's file changed (`pageChanged`): the page's own agents, which wake on it instead of polling,
   * and the push to its tabs (`live.ts`).
   */
  changes: Set<(id: string) => void>;
  /** What the agents have cost since start (`agent/budget.ts`). */
  budget: {
    spent: number; reported: boolean;
    day: { key: string; spent: number } | null; month: { key: string; spent: number } | null;
    /** Runs today whose engine reported no cost, so the dollar limits never saw them (`agent/budget.ts`). */
    runs: { key: string; n: number } | null;
  };
}

const KEY = Symbol.for("solipsist.runtime");

export const newRuntime = (): Runtime => ({
  pages: new Map(),
  chats: new Map(),
  enders: new Map(),
  bus: new Map(),
  changes: new Set(),
  budget: { spent: 0, reported: false, day: null, month: null, runs: null },
});

export const runtime = (): Runtime => ((globalThis as any)[KEY] ??= newRuntime());

/** The folder new pages are made in and the server reads: one answer for the whole server, read from the config at each call. */
export const pagesDir = (): string => config().pagesDir;
/** Where Solipsist runs: the project root. The agent may read all of it; the one place the server asks for the working directory. */
export const root = (): string => config().projectRoot;

/** Tests: a fresh runtime. Page agents still running are not stopped (`stopAllPages` first). */
export const resetRuntime = (): Runtime => ((globalThis as any)[KEY] = newRuntime());

/** Says that page `id`'s file changed (our own write, or one from outside: `files.ts`, `live.ts`). */
export function pageChanged(id: string) {
  for (const f of runtime().changes) try { f(id); } catch (e) { console.error(e); }
}

/** Calls `f` with the page's id each time a page's file changes; the returned function stops it. */
export function onPageChanged(f: (id: string) => void): () => void {
  const set = runtime().changes;
  set.add(f);
  return () => void set.delete(f);
}
