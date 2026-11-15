import { PAGE_CHAT, type ChatEvent } from "../../shared/chat";
import type { PutRequest } from "../../server/put";
import type { AgentModelOption } from "../pages/ModelPicker";

export interface FileMsg { rev: number; file: string; path?: string }
export type PutReply = { ok: true } & FileMsg | { ok: false; code: string; file?: string; rev?: number };

const j = async (res: Response) => res.json().catch(() => ({}));
/** Every body is sent as JSON: the server refuses any other (`src/server/guard.ts`), so a website can't post to it. */
const JSON_BODY = { "content-type": "application/json" };
/** A page's address in the API: its id, which may hold slashes, is one segment. */
const pageApi = (id: string) => `/api/pages/${encodeURIComponent(id)}`;

export async function listPages(): Promise<{ id: string; title: string; mtime: number; unsynced?: boolean }[]> {
  return (await fetch("/api/pages")).json();
}

/** A new page; in a project, at `path`. Undefined when it couldn't be made. */
export async function createPage(path?: string): Promise<string | undefined> {
  return (await j(await fetch("/api/pages", { method: "POST", ...(path !== undefined && { headers: JSON_BODY, body: JSON.stringify({ path }) }) }))).id;
}

export interface SetupInfo { project: boolean; needed: boolean; changed: boolean; found: string[]; searchPaths: string[]; capped: boolean }
export async function getSetup(): Promise<SetupInfo> {
  return (await fetch("/api/setup")).json();
}
export async function addFiles(paths: string[]): Promise<{ failed: string[] }> {
  return (await fetch("/api/setup", { method: "POST", headers: JSON_BODY, body: JSON.stringify({ paths }) })).json();
}
export async function getSyncState(id: string): Promise<boolean> {
  return !!(await j(await fetch(`${pageApi(id)}/sync`))).unsynced;
}
type Outcome = { ok: true } | { ok: false; code: string };
const outcome = async (res: Response): Promise<Outcome> => (res.ok ? { ok: true } : { ok: false, code: (await j(res)).error?.code ?? `http_${res.status}` });
export const syncDoc = async (id: string, force: boolean) => outcome(await fetch(`${pageApi(id)}/sync`, { method: "POST", headers: JSON_BODY, body: JSON.stringify({ force }) }));
export const reloadDoc = async (id: string, discard: boolean) => outcome(await fetch(`${pageApi(id)}/reload`, { method: "POST", headers: JSON_BODY, body: JSON.stringify({ discard }) }));

export async function getPage(id: string): Promise<FileMsg> {
  const res = await fetch(`${pageApi(id)}`);
  if (!res.ok) throw new Response(null, { status: res.status, statusText: (await j(res)).error?.message });
  return res.json();
}

/** `keepalive` lets the last save finish while the page is closing. */
export async function putPage(id: string, body: PutRequest, keepalive = false): Promise<PutReply> {
  const res = await fetch(`${pageApi(id)}`, { method: "PUT", headers: JSON_BODY, body: JSON.stringify(body), keepalive });
  const data = await j(res);
  if (res.ok) return { ok: true, ...data };
  return { ok: false, code: data.error?.code ?? `http_${res.status}`, file: data.file, rev: data.rev };
}

/**
 * The page's event stream, read with fetch (not EventSource) so a refusal (`already_open`) can be told apart from a
 * dropped connection. Reconnects after 2 s, resuming from the last rev.
 */
export function openEvents(id: string, on: {
  onFile(m: FileMsg): void;
  onState(s: "live" | "offline" | "refused"): void;
}) {
  const ac = new AbortController();
  let lastId = "";
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${pageApi(id)}/events`, { signal: ac.signal, headers: lastId ? { "Last-Event-ID": lastId } : {} });
        if (res.status === 409) return on.onState("refused");
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        on.onState("live");
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message", data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
              else if (line.startsWith("id: ")) lastId = line.slice(4);
            }
            if (!data) continue;
            if (event === "file") on.onFile(JSON.parse(data));
          }
        }
      } catch {
        if (ac.signal.aborted) return;
      }
      on.onState("offline");
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ac.abort();
}

export interface AgentEvent { event: string; at: number; run?: number; [k: string]: unknown }

/**
 * The page's agent stream (Pi agents run in a loop by the server, whether a tab is open or not: opening it again hears
 * what is in flight first). Retries every 2 s.
 */
export function openAgent(id: string, on: { onEvent(e: AgentEvent): void; onState(s: "live" | "offline" | "refused"): void }) {
  const ac = new AbortController();
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${pageApi(id)}/agent`, { signal: ac.signal });
        if (res.status === 409) { on.onState("refused"); await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        on.onState("live");
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message", data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (data) on.onEvent({ event, ...JSON.parse(data) });
          }
        }
      } catch {
        if (ac.signal.aborted) return;
      }
      on.onState("offline");
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ac.abort();
}

/**
 * What the model picker offers: the shortlist it shows at a glance, and every model the engines can run, which it
 * searches. Read once, when the picker is first opened — the catalog is hundreds of models long. Null if it can't be.
 */
export async function getAgentModels(): Promise<{ models: AgentModelOption[]; catalog: AgentModelOption[] } | null> {
  try {
    const res = await fetch("/api/agent/models");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** How often the button of request `task` runs on its own, page open or not (ms), or null for only when pressed. False when refused. */
export async function scheduleButton(id: string, task: string, every: number | null): Promise<boolean> {
  try {
    return (await fetch(`${pageApi(id)}/tasks/${encodeURIComponent(task)}/schedule`, { method: "POST", headers: JSON_BODY, body: JSON.stringify({ every }) })).ok;
  } catch {
    return false;
  }
}

/**
 * Changes the page's agent settings, which the server keeps in the page's file: `on` (the switch in the status bar;
 * agents keep working when the tab closes, so off is the only way to stop them) and `model` (`engine:model`; a run in
 * flight finishes on the old one). Resolves to what the page has now, or null when the server refused.
 */
export async function saveAgentSettings(id: string, patch: { on?: boolean; model?: string }): Promise<{ on: boolean; model: string } | null> {
  try {
    const res = await fetch(`${pageApi(id)}/agent`, { method: "POST", headers: JSON_BODY, body: JSON.stringify(patch) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * One reading of the page (`reader/`): the agent raises questions, which arrive as margin comments through the
 * watcher like any other change to the file. Nothing is written into the body, so there is nothing to apply here.
 */
export async function reviewPage(id: string): Promise<{ placed: string[] } | { error: string }> {
  try {
    // `pageApi`, not the id as it comes: a page's id holds the folder it is in (`docs2/w8s1jmmy`), and a raw slash
    // makes a path the route can't match — it falls through to `/api/*` and answers 501.
    const res = await fetch(`${pageApi(id)}/review`, { method: "POST" });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: body?.error?.message ?? "The review failed." };
    // The ids, not a count: the tab stays busy until they are really on the page, which is a moment later, when the
    // watcher pushes the file the review wrote.
    return { placed: (body?.placed ?? []) as string[] };
  } catch (e: any) {
    return { error: String(e?.message ?? e) };
  }
}

/** The chat on `target`: a task's id (the agent kept behind its suggestion) or `PAGE_CHAT` (the page-wide one). */
const chatUrl = (id: string, target: string) => `${pageApi(id)}/chat/${target}`;

/**
 * The chat on `task` (a task's id or `PAGE_CHAT`): an event stream that opens it (the server lends it the agent) and
 * that closes it when aborted. `onError` says why it couldn't open; it is not retried.
 */
export function openChatStream(id: string, task: string, on: { onEvent(e: ChatEvent): void; onError(message: string): void }) {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(chatUrl(id, task), { signal: ac.signal });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        return on.onError(body?.error?.message ?? `HTTP ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
          if (data) on.onEvent(JSON.parse(data));
        }
      }
      if (!ac.signal.aborted) on.onError("The chat was closed by the server.");
    } catch (e: any) {
      if (!ac.signal.aborted) on.onError(String(e?.message ?? e));
    }
  })();
  return () => ac.abort();
}

/** Says `text` in the chat on `task`; the reply streams in. Null when sent, else why not. */
export async function sayInChat(id: string, task: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(chatUrl(id, task), { method: "POST", headers: JSON_BODY, body: JSON.stringify({ text }) });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return body?.error?.message ?? `HTTP ${res.status}`;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

/** New chat: the page-wide chat's agent is closed and its conversation forgotten; the next open starts afresh. */
export async function forgetPageChat(id: string) {
  await fetch(chatUrl(id, PAGE_CHAT), { method: "DELETE" }).catch(() => {});
}

/** Stops the agent's reply in flight in the chat on `task`. */
export async function stopChat(id: string, task: string) {
  await fetch(`${chatUrl(id, task)}/stop`, { method: "POST" }).catch(() => {});
}

export interface SupportView { show: boolean; days: number; url: string }

/** Whether to ask the writer to buy a licence (`src/server/support.ts`); null when the server can't say. */
export async function getSupport(): Promise<SupportView | null> {
  try {
    const res = await fetch("/api/support");
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The writer's answer to the strip: ask again later, or they have bought one. */
export async function answerSupport(action: "later" | "paid") {
  await fetch("/api/support", { method: "POST", headers: JSON_BODY, body: JSON.stringify({ action }) }).catch(() => {});
}
