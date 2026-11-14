import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_CHAT, type ChatEvent } from "../../shared/chat";
import type { TaskAgent } from "../../shared/docfile";
import { pageFile, type ChatAgent } from "../agent";
import { publish } from "../agent/bus";
import type { AgentEngine, AgentSession } from "../agent/engine";
import { engines, parseChoice } from "../agent/engines";
import { imagesDir, waitMs } from "../agent/page";
import { pageChatChanged } from "../agent/pageChatStatus";
import { readSettings, writeSettings } from "../agent/settings";
import { readModifyWrite, withLock } from "../files";
import { pagesDir, root } from "../runtime";
import { log, why } from "../log";
import { promptText, renderPrompt } from "../prompts";
import { suggestOnPage, type Reply } from "../suggest";
import type { ChatSource } from "./source";

/**
 * The page-wide chat from the page's chat button: an agent of its own that knows which page the writer is on and
 * proposes changes as suggestions at the end of the page (`suggestOnPage`). It never touches the page's tasks.
 *
 * It lasts beyond its windows: idle and unwatched, it stays `agent.wait_ms`, then snoozes (closed). Its conversation is
 * recorded in the page's agent settings (`block.agent.chat`), so an engine that keeps it on disk takes it up again on
 * the next open, after a restart too. A change of the page's model, or New chat (`forget`), starts a fresh one.
 */

/** Pages whose chat finished a reply while no window was open, until one opens (the button shows it). */
const unread = new Set<string>();
export const pageChatUnread = (id: string) => unread.has(id);

/**
 * The engine and model the page-wide chat runs on: the page's choice (`agent/settings.ts`), if that engine keeps
 * conversations, else the first one that does.
 */
function chatChoice(id: string): { engine: AgentEngine; model: string } | undefined {
  const c = parseChoice(readSettings(id).model);
  if (c?.engine.chats) return { engine: c.engine, model: c.model };
  const engine = engines().find((e) => e.chats);
  return engine && { engine, model: engine.models()[0]!.id };
}
const sameChoice = (a: { engine: string; model: string }, b: { engine: string; model: string }) => a.engine === b.engine && a.model === b.model;

/** Its system prompt: the page chat's own, and for an engine without the reply tools, the envelope instead. */
const system = (id: string, engine: AgentEngine) =>
  [renderPrompt("pi-chat.system", { name: engine.title, file: pageFile(id) }), ...(engine.replyTools ? [] : [promptText("protocol.envelope")])].join("\n\n");

export function pageSource(id: string): ChatSource {
  return {
    log: "pichat",
    fields: { page: id },
    async lend() {
      const picked = chatChoice(id);
      if (!picked) return { refused: { status: 409, code: "no_agent", message: "No agent that can chat is set up." } };
      const { engine, model } = picked;
      const unavailable = engine.unavailable();
      if (unavailable) return { refused: { status: 409, code: "unavailable", message: unavailable } };
      const saved = readSettings(id).saved.chat;
      const resume = saved && sameChoice(saved, { engine: engine.name, model }) ? saved.session : undefined;
      const scratch = mkdtempSync(join(tmpdir(), "solip-pi-chat-"));
      const begin = (from?: string) => engine.start({
        id, file: pageFile(id), images: imagesDir(id), root: root(), scratch, model,
        system: system(id, engine), replyTools: true,
        ...(from && { resume: from }),
        onStep: () => {}, onStream: (e: ChatEvent) => publish(id, PAGE_CHAT, e),
      });
      let started: AgentSession;
      try {
        mkdirSync(pagesDir(), { recursive: true });
        // A conversation that can't be taken up again (its files gone) is not a reason to refuse the chat: a new one starts.
        started = await (resume ? begin(resume).catch((e) => { log("pichat.resume_failed", { page: id, message: why(e) }); return begin(); }) : begin());
      } catch (e: any) {
        rmSync(scratch, { recursive: true, force: true });
        return { refused: { status: 500, code: "start_failed", message: `The agent couldn't be started: ${e?.message ?? e}` } };
      }
      // Its scratch directory goes with it.
      const session: AgentSession = { ...started, close: () => started.close().finally(() => rmSync(scratch, { recursive: true, force: true })) };
      const resumed = !!resume && (session.history?.() ?? []).length > 0;
      log("pichat.open", { page: id, engine: engine.name, model, resumed });
      // Recorded, so the next open (after a snooze or a restart) takes it up again; a fresh one replaces the old record.
      if (started.sessionId && started.sessionId !== saved?.session) {
        const ref: TaskAgent = { engine: engine.name, model, session: started.sessionId };
        await writeSettings(id, { chat: ref }).catch((e) => log("server.error", { kind: "pichat record", message: why(e) }));
      } else if (!started.sessionId && saved) {
        await writeSettings(id, { chat: null }).catch(() => {});
      }
      return { agent: { session, ref: { engine: engine.name, model, session: started.sessionId ?? "" } }, told: resumed };
    },
    stale(agent: ChatAgent) {
      const p = chatChoice(id);
      return !p || !sameChoice(agent.ref, { engine: p.engine.name, model: p.model });
    },
    keepMs: () => waitMs(),
    async giveBack(agent, reason) {
      await agent.session.close().catch(() => {});
      log("pichat.close", { page: id, reason });
    },
    intro: () => renderPrompt("pi-chat.first", { file: pageFile(id) }),
    check(reply: Reply) {
      try { return suggestOnPage(readFileSync(pageFile(id), "utf8"), reply).error ?? null; } catch (e: any) { return String(e?.message ?? e); }
    },
    async apply(reply) {
      const r = await withLock(id, () => readModifyWrite(id, (src) => {
        if (src === null) return { result: {} as { error?: string; file?: string } };
        const f = suggestOnPage(src, reply);
        return { file: f.file, result: f };
      })).catch((e: any) => ({ error: String(e?.message ?? e) }) as { error?: string; file?: string });
      if (r.error) return [{ t: "warning", message: `Your suggestion can't be used: ${r.error}` }];
      return r.file ? [{ t: "revised", created: true }] : [];
    },
    async forget() {
      // The record goes first, so the page hears "none" and not a moment of "snoozed".
      if (readSettings(id).saved.chat) await writeSettings(id, { chat: null });
      unread.delete(id);
    },
    notify(what) {
      if (what === "seen") unread.delete(id);
      if (what === "unseen") unread.add(id);
      pageChatChanged(id);
    },
  };
}
