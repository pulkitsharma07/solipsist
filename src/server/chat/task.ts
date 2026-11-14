import { readFileSync } from "node:fs";
import type { ChatEvent } from "../../shared/chat";
import { parseFile } from "../../shared/docfile";
import { giveBack, pageFile, takeAgent, tellPage, watchRun } from "../agent";
import { readModifyWrite, withLock } from "../files";
import { log } from "../log";
import { renderPrompt } from "../prompts";
import { suggestFromTaskChat, type Reply } from "../suggest";
import type { ChatSource } from "./source";

/**
 * The chat behind a suggestion: the agent kept after task `task`'s run, lent by the page's loop (`takeAgent`: the
 * one waiting, or its conversation woken from disk) and given back to it (`giveBack`: it waits again) as soon as no
 * window is open and no reply is in flight; the loop does the waiting and snoozing. Opened while a run is on the task,
 * the chat looks in on it (`watchRun`) and takes the agent when it ends. A suggestion in a reply replaces the card's.
 */
export function taskSource(id: string, task: string): ChatSource {
  const taskType = (src: string) => parseFile(src).block.tasks?.[task]?.type;
  return {
    log: "chat",
    fields: { page: id, task },
    async lend() {
      const got = await takeAgent(id, task);
      if (got === "working") {
        const watch = watchRun(id, task);
        return watch ? { watch } : { refused: { status: 409, code: "working", message: "The agent is working on this request, and it keeps no conversation to show. Try again once it is done." } };
      }
      if ("error" in got) return { refused: { status: 409, code: "no_agent", message: got.error } };
      return { agent: got };
    },
    keepMs: () => 0,
    // The margin pill says "Working…" while the agent answers in the chat (`chat_busy`).
    onBusy: (busy) => tellPage(id, "chat_busy", { task, busy }),
    giveBack: (agent) => giveBack(id, task, agent),
    intro: () => renderPrompt("chat.first", { placeholder: task }),
    check(reply: Reply) {
      try {
        const src = readFileSync(pageFile(id), "utf8");
        const t = taskType(src);
        return t ? suggestFromTaskChat(src, { id: task, taskType: t }, reply).error ?? null : null;
      } catch (e: any) { return String(e?.message ?? e); }
    },
    async apply(reply) {
      const r = await withLock(id, () => readModifyWrite(id, (src) => {
        if (src === null) return { result: {} as { error?: string; file?: string; created?: boolean } };
        const t = taskType(src);
        const f = t ? suggestFromTaskChat(src, { id: task, taskType: t }, reply) : {};
        return { file: f.file, result: f };
      })).catch((e: any) => ({ error: String(e?.message ?? e) }) as { error?: string; file?: string; created?: boolean });
      const told: ChatEvent[] = [];
      if (r.error) { told.push({ t: "warning", message: `Your new suggestion can't be used: ${r.error}` }); log("chat.revise_refused", { page: id, task, message: r.error }); }
      else if (r.file && r.created) { told.push({ t: "revised", created: true }); log("chat.suggested", { page: id, task }); }
      else if (r.file) { told.push({ t: "revised" }); tellPage(id, "revised", { task }); log("chat.revised", { page: id, task }); }
      return told;
    },
  };
}
