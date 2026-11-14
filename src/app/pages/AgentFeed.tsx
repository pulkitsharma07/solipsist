import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentEvent } from "../doc/client";
import { suggestionKey } from "../editor/suggestions";
import { nextRunAt } from "../../shared/docfile";
import type { AgentLink } from "./DebugPanel";
import { NoteIcon } from "./NoteIcon";
import { stackCards } from "./stackCards";
import { keyLabel } from "../keys";

/** How long a note may be before it is cut short; the rest shows on hover. */
export const FEED_CHARS = 140;

export const truncate = (s: string, n = FEED_CHARS) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

/**
 * What a note says: waiting to be picked up, or the step the run in flight is on (null: none yet). Beside a suggestion,
 * where the agent kept behind it stands: waiting for the writer until `until`,
 * snoozed, or in the chat.
 */
export type Note = (
  | { mode: "waiting" }
  | { mode: "working"; step: { key: string; kind: "tool" | "tool_result" | "text" | "error"; label: string; line: string; detail: string } | null; chat?: boolean }
  | { mode: "idle"; until: number; finishedAt?: number }
  | { mode: "snoozed"; finishedAt?: number }
  /** `busy`: the agent is answering in the chat. */
  | { mode: "chatting"; busy?: boolean }
  /** After the writer took the result: nothing is known of its agent in this stream. */
  | { mode: "kept" }
) & {
  /** The engine of the agent the note is about, when the stream says (a task not picked up yet has none). */
  engine?: string;
  /** The writer took the result: accepted (its marker gone), or kept as a button. */
  after?: "accepted" | "button";
  /** The agent declined the task: its reason (the record's `note`), shown in place of "Done". */
  declined?: string;
  /** A button: when its request last ran (epoch ms), and when its schedule runs it next, from its record. */
  lastRun?: number;
  nextRun?: number;
};

/** When the agent finished its last run, if the event says. */
const finishedOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? { finishedAt: v } : {});

/** Where the agent kept behind suggestion `id` stands, from the current stream's events (null: none was kept). */
function keptNote(cur: AgentEvent[], id: string): Note | null {
  for (let i = cur.length - 1; i >= 0; i--) {
    const e = cur[i]!;
    if (e.event === "hello") {
      const s = (e.agents as Record<string, string> | undefined)?.[id];
      return s === "chatting" ? { mode: "chatting" } : s === "snoozed" ? { mode: "snoozed", ...finishedOf((e.finished as Record<string, unknown> | undefined)?.[id]) } : null;
    }
    if (e.task !== id) continue;
    if (e.event === "wait") return { mode: "idle", until: Number(e.until), ...finishedOf(e.finishedAt) };
    if (e.event === "snooze" || e.event === "chat_end") return { mode: "snoozed", ...finishedOf(e.finishedAt) };
    if (e.event === "chat") return { mode: "chatting" };
    if (e.event === "chat_busy") return { mode: "chatting", ...(e.busy === true && { busy: true }) };
    if (e.event === "start") return null;
  }
  return null;
}

/**
 * The note beside a task's loader. None while the agent is off or runs in another tab, or once the task
 * is done. Acknowledged: the newest step (tool call, tool result, text, error) of the run in flight. Pending: "waiting",
 * unless something went wrong since the last run started (a permission prompt nobody could answer, say): that error.
 * Given the task's `id`, only the runs sent to work on it count, since several run at once.
 */
export function agentNote(all: AgentEvent[], link: AgentLink, state: string, id?: string): Note | null {
  const note = baseNote(all, link, state, id);
  if (!note || id === undefined) return note;
  // Whose agent it is, from the newest event about the task that says (or the stream's greeting).
  const cur = all.slice(Math.max(0, all.findLastIndex((e) => e.event === "hello")));
  const engine = engineFor(cur, id);
  return engine ? { ...note, engine } : note;
}

function engineFor(cur: AgentEvent[], id: string): string | undefined {
  for (let i = cur.length - 1; i >= 0; i--) {
    const e = cur[i]!;
    if (e.event === "hello") { const g = (e.engines as Record<string, string> | undefined)?.[id]; return typeof g === "string" ? g : undefined; }
    if (e.task === id && typeof e.engine === "string") return e.engine;
  }
  return undefined;
}

function baseNote(all: AgentEvent[], link: AgentLink, state: string, id?: string): Note | null {
  if (link === "paused" || link === "refused") return null;
  // Run numbers start again when the stream reconnects: only the current stream's count.
  const cur = id === undefined ? all : all.slice(Math.max(0, all.findLastIndex((e) => e.event === "hello")));
  if (state === "sug") return id === undefined ? null : keptNote(cur, id);
  // The result was taken: the note stays, saying so, with where its agent stands if the stream knows.
  if (state === "accepted" || state === "btn") return id === undefined ? null : { ...(keptNote(cur, id) ?? { mode: "kept" }), after: state === "btn" ? "button" : "accepted" };
  if (state !== "pending" && state !== "ack") return null;
  const mine = id === undefined ? null : new Set(cur.filter((e) => e.event === "start" && e.task === id).map((e) => e.run));
  const events = mine ? cur.filter((e) => mine.has(e.run)) : all;
  // A run whose agent keeps a conversation can be looked in on from the chat.
  const chat = state === "ack" && id !== undefined && !!cur.findLast((e) => e.event === "start" && e.task === id)?.chat;
  const working = (step: Extract<Note, { mode: "working" }>["step"]): Note => ({ mode: "working", step, ...(chat && { chat }) });
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event === "start") break;
    if (e.event !== "step" || !(e.kind === "tool" || e.kind === "tool_result" || e.kind === "text" || e.kind === "error")) continue;
    if (state === "pending" && e.kind !== "error") continue;
    const text = String(e.text ?? "");
    const detail = String(e.detail ?? text);
    const key = `${e.run}-${i}`;
    if (e.kind === "tool") {
      const name = String(e.name ?? text.split(" ")[0] ?? "tool");
      return working({ key, kind: "tool", label: name, line: truncate(String(e.brief ?? text.slice(name.length))), detail });
    }
    if (e.kind === "tool_result") return working({ key, kind: "tool_result", label: "", line: truncate(text) || "(empty)", detail });
    if (e.kind === "error") return working({ key, kind: "error", label: "error", line: truncate(text), detail });
    return working({ key, kind: "text", label: "", line: truncate(text), detail });
  }
  return state === "pending" ? { mode: "waiting" } : working(null);
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/** A time, with its day when it isn't today. */
const when = (ms: number) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? clock(ms) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(ms)}`;
};

/** "Chat" and its key, as the hints name it. */
const chatKey = () => `Chat (${keyLabel("Mod-Alt-c")})`;
/** What hovering a kept agent's note says. `asked` false: the result is taken, so there is nothing to ask again. */
const keptHint = (note: Note, asked = true) =>
  note.mode === "idle" ? `The agent is still here${note.finishedAt ? ` (it finished at ${clock(note.finishedAt)})` : ""}: ${chatKey()}${asked ? " or Ask again" : ""} talks to it. It snoozes at ${clock(note.until)}.`
    : note.mode === "snoozed" ? `The agent is snoozed${note.finishedAt ? `; it finished at ${clock(note.finishedAt)}` : ""}: ${chatKey()}${asked ? " or Ask again" : ""} wakes it, with its conversation.`
      : note.mode === "chatting" ? (note.busy ? "The agent is answering in the chat." : "The chat with the agent is open.") : undefined;

/** One note. A new step replaces the last one and fades in (its key changes); hovering shows the whole step. */
export function AgentNote({ note, top, engine = "pi", onEl, onChat }: { note: Note; top: number; /** The page's engine: the mark of a note whose agent isn't known yet. */ engine?: string; onEl?(el: HTMLElement | null): void; onChat?(): void }) {
  const step = note.mode === "working" ? note.step : null;
  // The whole note opens the chat, wherever there is an agent to talk to: one kept behind a suggestion, or on a run a Pi agent is working.
  const chat = onChat && (note.mode === "idle" || note.mode === "snoozed" || note.mode === "chatting" || note.mode === "kept" || (note.mode === "working" && !!note.chat)) ? onChat : undefined;
  // A button says when its request last ran: its text rewrites itself, with no diff to show for it.
  const ranLast = note.after === "button" && note.lastRun ? `Last run ${when(note.lastRun)}` : undefined;
  const taken = ranLast ?? (note.after === "button" ? "Kept as a button" : "Accepted");
  // Once the result is taken there is nothing to ask again: only the chat is left to offer.
  const title = note.declined !== undefined ? `Declined: ${note.declined}${keptHint(note) ? `\n${keptHint(note)}` : ""}`
    : ranLast ? `This button's request last ran at ${when(note.lastRun!)}.${note.nextRun ? ` Its schedule runs it next at ${when(Math.max(note.nextRun, Date.now()))}.` : ""}${chat ? " Click to chat with its agent." : ""}`
    : note.mode === "kept" ? (chat ? `${taken}. ${chatKey()} talks to the agent that made it, with its conversation.` : taken)
    : note.after && (note.mode === "idle" || note.mode === "snoozed") ? `${taken}. ${keptHint(note, false)}`
      : keptHint(note);
  return (
    <div ref={onEl} className={`agent-note ${note.mode}${note.declined !== undefined ? " declined" : ""}${step ? ` ${step.kind}` : ""}${chat ? " clickable" : ""}`} style={{ top }} tabIndex={step || chat ? 0 : -1} title={title} aria-live="polite" onClick={chat} onKeyDown={chat && ((e) => { if (e.key === "Enter" && e.target === e.currentTarget) chat(); })}>
      <NoteIcon note={note} engine={note.engine ?? engine} />
      <div key={step?.key ?? note.mode} className="note-line">
        {note.declined !== undefined ? <><b>Declined</b><span>{note.declined}</span></>
          : note.mode === "waiting" ? <span>Waiting for agent to pick the task…</span>
          : note.mode === "idle" ? <span>{note.after ? taken : "Done"}</span>
          : note.mode === "kept" ? <span>{taken}</span>
          : note.mode === "snoozed" && ranLast ? <span>{ranLast}</span>
          : note.mode === "snoozed" ? <span>{note.after ? `${taken} · snoozed` : "Snoozed"}{note.finishedAt ? ` · finished ${clock(note.finishedAt)}` : ""}</span>
          : note.mode === "chatting" ? <span>{note.busy ? "Working…" : "In chat"}</span>
          : !step ? <span>Agent is working…</span>
          : <>{step.label && <b>{step.label}</b>}<span>{step.line}</span></>}
      </div>
      {step && <pre className="note-detail">{step.detail}</pre>}
    </div>
  );
}

const GAP = 4;

/**
 * A task the agent declined: its note says why (the reason the `decline` gave, kept as the record's `note`), whether
 * or not its agent is still here. Anything else is left as it is.
 */
export function declinedNote(note: Note | null, state: string, record: { status?: string; note?: string } | undefined, link: AgentLink): Note | null {
  if (state !== "sug" || record?.status !== "declined" || link === "paused" || link === "refused") return note;
  const reason = record.note?.trim() || "No reason given";
  return { ...(note ?? { mode: "kept" }), declined: reason };
}

/**
 * The agent's progress in the right margin, outside the page, level with each task's loader: "waiting" beside
 * one that waits, the current step beside one the agent has picked up. Reads the loaders from the page, so it follows
 * their states and positions as they change.
 */
export function AgentNotes({ editor, events, link, engine, onChat }: { editor: Editor | null; events: AgentEvent[]; link: AgentLink; engine?: string; onChat?(id: string): void }) {
  const col = useRef<HTMLDivElement>(null);
  const [spots, setSpots] = useState<{ id: string; state: string; top: number }[]>([]);
  const els = useRef<Record<string, HTMLElement | null>>({});

  const measure = () => {
    const root = col.current;
    if (!root || !editor) return;
    const base = root.getBoundingClientRect().top;
    const at = (el: HTMLElement, id: string, state: string) => { const r = el.getBoundingClientRect(); return { id, state, top: r.top + r.height / 2 - base }; };
    const loaders = [...editor.view.dom.querySelectorAll<HTMLElement>(".task-loader[data-state]")]
      .filter((el) => el.dataset.state === "pending" || el.dataset.state === "ack")
      .map((el) => at(el, el.dataset.id ?? "", el.dataset.state!));
    // A suggestion's loader is hidden (its preview shows instead): the note goes level with the first thing it draws.
    const sugs = new Map<string, HTMLElement>();
    for (const el of editor.view.dom.querySelectorAll<HTMLElement>("[data-sug]")) if (!sugs.has(el.dataset.sug!)) sugs.set(el.dataset.sug!, el);
    // A result the writer took: beside where it landed (`acceptedSpots.ts`), or beside its button.
    const taken = [
      ...[...editor.view.dom.querySelectorAll<HTMLElement>("[data-accepted]")].map((el) => at(el, el.dataset.accepted!, "accepted")),
      ...[...editor.view.dom.querySelectorAll<HTMLElement>(".task-button[data-task-button]")].map((el) => at(el, el.dataset.taskButton!, "btn")),
    ];
    const found = [...loaders, ...[...sugs].map(([id, el]) => at(el, id, "sug")), ...taken].sort((a, b) => a.top - b.top);
    // Loaders on nearby lines: their notes share the room around them. A note is centred on its top, and may wrap.
    const half = (id: string) => (els.current[id]?.offsetHeight ?? 28) / 2;
    const stacked = stackCards(found.map((s) => ({ top: s.top - half(s.id), height: half(s.id) * 2 })), GAP);
    const next = found.map((s, i) => ({ ...s, top: Math.round(stacked[i]! + half(s.id)) }));
    setSpots((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };

  useLayoutEffect(measure);
  useEffect(() => {
    if (!editor) return;
    const f = () => requestAnimationFrame(measure);
    editor.on("transaction", f);
    window.addEventListener("resize", f);
    // A loader changes state in place, without a transaction of its own.
    const watch = new MutationObserver(f);
    watch.observe(editor.view.dom, { subtree: true, attributes: true, attributeFilter: ["data-state"] });
    return () => { editor.off("transaction", f); window.removeEventListener("resize", f); watch.disconnect(); };
  });

  return (
    <div className="agent-notes" ref={col} aria-label="Agent activity">
      {spots.map((s) => {
        const record = editor ? suggestionKey.getState(editor.state)?.records[s.id] : undefined;
        const base = declinedNote(agentNote(events, link, s.state, s.id), s.state, record, link);
        // A button: when it last ran, and when its schedule runs it next, from its record.
        const ran = s.state === "btn" && record?.finished ? Date.parse(record.finished) : NaN;
        const next = s.state === "btn" ? nextRunAt(record) : null;
        const note = base && { ...base, ...(Number.isFinite(ran) && { lastRun: ran }), ...(next !== null && { nextRun: next }) };
        // Once the result is taken, the chat is there only if its agent's conversation was kept (the record says).
        const talk = onChat && (note?.mode !== "kept" || !!record?.agent);
        return note && <AgentNote key={s.id} note={note} top={s.top} engine={engine} onEl={(el) => { els.current[s.id] = el; }} onChat={talk ? () => onChat!(s.id) : undefined} />;
      })}
    </div>
  );
}
