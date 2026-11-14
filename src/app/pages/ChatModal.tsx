import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyChatEvent, isReplyTool, liveRate, PAGE_CHAT, readReplyCall, type ChatBlock, type ChatMessage, type ChatStats, type ChatTool } from "../../shared/chat";
import { openChatStream, sayInChat, stopChat } from "../doc/client";
import { ModelSelect, type AgentModelOption } from "./DebugPanel";
import { keyLabel } from "../keys";

/**
 * The chat being opened: the page, the task it is about, and what to call it. `draft`: what the message box starts
 * with, for the writer to finish and send (a review question carried into the page chat).
 */
export interface ChatState { task: string; title: string; draft?: string }

/** The page's model picker, shown in the page-wide chat: the page's choice, and what to offer; and its New chat. */
export interface ChatModels { model: string; models: AgentModelOption[]; onModel(m: string): void; onNew?(): void }

/**
 * The chat with the agent kept behind a suggestion. Opening it lends the agent to
 * the chat (its conversation so far shows); the reply streams in as it comes: text, thinking, tool calls with their
 * results, and what each reply cost and how fast it came. A new suggestion in a reply goes on the card at once. Closing
 * it gives the agent back to the page. Escape or the close button closes it. Opened while the agent is on a run (its
 * first), it shows that run as it goes, and the writer can talk once it ends. The page-wide chat works the same way:
 * closing it leaves a reply going, and opening it again shows the conversation where it is; New chat starts over.
 */
export function ChatModal({ page, chat, models, onClose }: { page: string; chat: ChatState; models?: ChatModels; onClose(): void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  /** Looking in on a run (the task's first, say): nothing to say or stop until it ends. */
  const [watching, setWatching] = useState(false);
  const [model, setModel] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState(chat.draft ?? "");
  const [, tick] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Whether the log follows the reply: until the writer scrolls up, and again once they are back at the bottom. */
  const follow = useRef(true);
  /** Where the log was last left, for the next scroll to be read against. */
  const lastTop = useRef(0);
  /** While the writer holds the scrollbar: the log is theirs, and nothing moves it until they let go. */
  const holding = useRef(false);
  /** How many messages there are now, for where a notice goes. */
  const count = useRef(0);
  /** Whether the agent takes a message while it replies (steering): then Send stays next to Stop. */
  const [steers, setSteers] = useState(false);

  useEffect(() => {
    let n = 0, now: ChatMessage[] = [];
    return openChatStream(page, chat.task, {
      onEvent: (e) => {
        if (e.t === "history") { setOpened(true); setModel(e.model); setBusy(e.busy); setWatching(!!e.watching); setSteers(!!e.steers); }
        // A message sent mid-reply shows as queued until the agent takes it in; then it is in the conversation.
        if (e.t === "message" && e.message.role === "user") {
          const said = e.message.blocks.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
          setNotices((x) => { const i = x.findIndex((q) => q.kind === "queued" && q.said === said); return i < 0 ? x : x.filter((_, j) => j !== i); });
        }
        if (e.t === "busy" && !e.busy) setWatching(false);
        if (e.t === "busy") setBusy(e.busy);
        now = applyChatEvent(now, e);
        if (e.t === "warning") setNotices((x) => [...x, { key: n++, kind: "warning", text: e.message, after: now.length }]);
        if (e.t === "revised") setNotices((x) => [...x, { key: n++, kind: "revised", text: e.created ? "A suggestion was added to the page." : "Your suggestion was updated on the page.", after: now.length }]);
        count.current = now.length;
        setMessages(now);
      },
      onError: setError,
    });
  }, [page, chat.task]);

  // The live rate moves while a reply streams.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [busy]);

  // Follows the reply as it streams, unless the writer has scrolled up to read. The log is moved only when it isn't
  // already at the end: it renders many times a second while a reply streams, and every write of its own makes
  // another `scroll` event to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !follow.current || holding.current) return;
    const end = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - end) > 1) el.scrollTop = end;
    lastTop.current = el.scrollTop;
  });
  /**
   * Where the log has got to: at the end, it follows the reply again. It is never *stopped* from here, only by the
   * writer's own scrolling below — a log that follows a reply writes its own scroll position several times a second,
   * and a browser's smooth scrolling catching up with one of those writes looks exactly like the writer scrolling up.
   * Reading that as theirs is what used to leave the log stuck above the newest messages, with nothing to bring it
   * back but another scroll of their own. Only a move *down* to the end counts: the browser reports the log's own
   * write a frame late, and if the writer wheeled up in between, that report (still at the end, the smooth scroll not
   * yet moving) would otherwise turn following back on under them.
   */
  const scrolled = (el: HTMLElement) => {
    if (el.scrollTop > lastTop.current && el.scrollHeight - el.scrollTop - el.clientHeight < 4) follow.current = true;
    lastTop.current = el.scrollTop;
  };
  // The writer's own scrolling, as they do it: a wheel up, a drag up, or the scrollbar held. Their gesture is the one
  // thing a reply streaming in can't imitate, so it alone stops the log following, at once and for certain.
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let y = 0;
    const left = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    const theirs = () => { follow.current = false; };
    /**
     * Scrolled past the end: the writer has asked for the newest, so the log follows again. Waiting for it to come to
     * rest at the bottom isn't enough — a reply streaming in makes the log taller than the scroll was ever going to
     * reach, so it lands a little short and the writer is left behind by the very reply they scrolled down to read.
     */
    const theEnd = (by: number) => { if (by >= left() - 1) follow.current = true; };
    const wheel = (e: WheelEvent) => { if (e.deltaY < 0) theirs(); else if (e.deltaY > 0) theEnd(e.deltaY); };
    const touch = (e: TouchEvent) => { y = e.touches[0]?.clientY ?? 0; };
    const drag = (e: TouchEvent) => { const at = e.touches[0]?.clientY ?? y; if (at > y + 2) theirs(); else if (at < y - 2) theEnd(y - at); y = at; };
    // The scrollbar: while it is held the log is the writer's, wherever they take it; where they leave it decides.
    const down = (e: PointerEvent) => { if (e.offsetX > el.clientWidth) { holding.current = true; theirs(); } };
    const up = () => {
      if (!holding.current) return;
      holding.current = false;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 4) follow.current = true;
    };
    const key = (e: KeyboardEvent) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) theirs(); };
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touch, { passive: true });
    el.addEventListener("touchmove", drag, { passive: true });
    el.addEventListener("pointerdown", down);
    el.addEventListener("keydown", key);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touch);
      el.removeEventListener("touchmove", drag);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("keydown", key);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);
  // Focused once it can be sent from, with the caret after anything it started with, where the writer goes on.
  useEffect(() => {
    const box = input.current;
    if (!opened || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [opened]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const send = async () => {
    const text = draft.trim();
    if (!text || watching || (busy && !steers)) return;
    setDraft("");
    // What they send, and the reply to it, come into view wherever they were reading.
    follow.current = true;
    holding.current = false;
    const midReply = busy;
    const why = await sayInChat(page, chat.task, text);
    if (why) { setDraft(text); setNotices((x) => [...x, { key: Date.now(), kind: "warning", text: why, after: count.current }]); }
    else if (midReply) setNotices((x) => [...x, { key: Date.now(), kind: "queued", text: `Sent mid-reply: “${text}”. It reads this after its current step.`, said: text, after: Infinity }]);
  };

  return (
    <ChatView
      chat={chat} models={models} messages={messages} notices={notices} busy={busy} watching={watching} steers={steers} opened={opened} error={error} model={model}
      draft={draft} onDraft={setDraft} onSend={() => void send()} onStop={() => void stopChat(page, chat.task)} onClose={onClose}
      listRef={list} inputRef={input} onScroll={scrolled}
    />
  );
}

/** What `ChatView` shows: the conversation and the state around it, and what the writer can do. */
export interface ChatViewProps {
  chat: ChatState;
  models?: ChatModels;
  messages: ChatMessage[];
  notices?: Notice[];
  busy: boolean;
  /** Looking in on a run: nothing to say or stop until it ends. */
  watching?: boolean;
  /** The agent takes a message while it replies: Send stays beside Stop. */
  steers?: boolean;
  /** The agent is lent to the chat (until then: "Waking the agent…"). */
  opened: boolean;
  error: string | null;
  model?: string;
  draft: string;
  onDraft(v: string): void;
  onSend(): void;
  onStop(): void;
  onClose(): void;
  listRef?: React.Ref<HTMLDivElement>;
  inputRef?: React.Ref<HTMLTextAreaElement>;
  onScroll?(el: HTMLElement): void;
}

/** The chat window itself, with nothing of its own to remember: the header, the log, the box to write in. */
export function ChatView({ chat, models, messages, notices = [], busy, watching = false, steers = false, opened, error, model, draft, onDraft, onSend, onStop, onClose, listRef, inputRef, onScroll }: ChatViewProps) {
  return (
    <>
      <div className="chat-backdrop" onClick={onClose} />
      <section className="chat-modal" role="dialog" aria-label={`Chat: ${chat.title}`}>
        <header>
          <div className="chat-title">
            <h2>{chat.title}</h2>
            <div className="meta">
              <span className={`dot${busy ? " dot-live" : ""}`} />
              <span className="chat-status">{error ? "" : !opened ? "Waking the agent…" : `${watching ? "On its run · " : ""}${chatStatus(messages, busy)}`}</span>
              <Totals messages={messages} model={model} />
            </div>
          </div>
          {chat.task === PAGE_CHAT && models && <ModelSelect className="chat-model" model={models.model} models={models.models} onModel={models.onModel} title="The page's model. Changing it starts a new chat on it." />}
          {chat.task === PAGE_CHAT && models?.onNew && <button type="button" className="chat-new btn btn-ghost" title="Forget this conversation and start a new one" onClick={models.onNew}>New chat</button>}
          <button type="button" className="chat-close btn btn-ghost icon-btn" aria-label="Close the chat" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" /></svg>
          </button>
        </header>
        <div className="chat-log" ref={listRef} onScroll={(e) => onScroll?.(e.currentTarget)}>
          {error ? <p className="chat-error">{error}</p> : <ChatLog messages={messages} notices={notices} />}
        </div>
        <footer className="chat-compose">
          <div className="chat-compose-box">
            <textarea
              ref={inputRef}
              value={draft}
              rows={Math.min(8, Math.max(1, draft.split("\n").length))}
              placeholder={!opened ? "" : watching ? "The agent is on its run: you can write once it is done." : busy && steers ? "Add to what it is doing: it reads this after its current step" : chat.task === PAGE_CHAT ? `Ask ${chat.title.replace(/^Chat with /, "")} about this page` : "Ask about this suggestion"}
              disabled={!opened || !!error}
              onChange={(e) => onDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); } }}
            />
            {busy && !watching && <button type="button" className={`btn ${steers ? "" : "btn-primary"}`.trim()} onClick={onStop}>Stop</button>}
            {/* Mid-reply, an engine that takes a message (steering) keeps Send beside Stop. */}
            {(!busy || watching || steers) && (
              <button type="button" className="btn btn-primary icon-btn chat-send" aria-label="Send" title={busy && steers ? "Send now: it reads this after its current step" : undefined} disabled={!draft.trim() || !opened || watching || (busy && !steers)} onClick={onSend}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M3 6l4-4 4 4" /></svg>
              </button>
            )}
          </div>
          <p className="chat-keys"><span><kbd>↵</kbd> send</span><span><kbd>{keyLabel("Shift-↵")}</kbd> new line</span><span><kbd>esc</kbd> close</span></p>
        </footer>
      </section>
    </>
  );
}

/** What the agent is doing now, in a word or two. */
export function chatStatus(messages: ChatMessage[], busy: boolean): string {
  if (!busy) return "Ready";
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.streaming) {
    const running = last?.blocks.find((b) => b.type === "tool" && b.running);
    return running?.type === "tool" ? `Running ${running.name}…` : "Thinking…";
  }
  const b = last.blocks.at(-1);
  return !b ? "Thinking…" : b.type === "thinking" ? "Thinking…" : b.type === "tool" ? (isReplyTool(b) ? "Giving its result…" : `Calling ${b.name}…`) : "Writing…";
}

const num = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/** The conversation's model and cost so far; the tokens in and out are in its tooltip. */
function Totals({ messages, model }: { messages: ChatMessage[]; model?: string }) {
  let input = 0, output = 0, cost = 0;
  for (const m of messages) { input += m.stats?.input ?? 0; output += m.stats?.output ?? 0; cost += m.stats?.costUsd ?? 0; }
  const tokens = input > 0 || output > 0 ? `${num(input)} in · ${num(output)} out` : "";
  return (
    <span className="chat-totals" title={`This conversation so far${tokens ? `: ${tokens}` : ""}${cost > 0 ? `, ${usd(cost)}` : ""}`}>
      {model && <span>{model.replace(/^[a-z]+:~?/, "")}</span>}
      {cost > 0 && <span>{usd(cost)}</span>}
    </span>
  );
}

/** Something the server said about the chat, shown after the message it came after (`after` messages in). */
/** `queued`: a message sent mid-reply, until the agent takes it in (`said` is what the writer wrote). */
export interface Notice { key: number; kind: "warning" | "revised" | "queued"; text: string; after: number; said?: string }

/** The conversation: the writer's words, Solipsist's prompts folded away, the agent's replies, and the notices between. */
export function ChatLog({ messages, notices = [], now = Date.now() }: { messages: ChatMessage[]; notices?: Notice[]; now?: number }) {
  const at = (i: number) => notices.filter((x) => Math.min(x.after, messages.length) === i).map((x) => <p key={`n${x.key}`} className={`chat-notice ${x.kind}`}>{x.text}</p>);
  if (!messages.length && !notices.length) return <p className="chat-empty">No conversation yet.</p>;
  // `now` only to the message that streams (it is the live rate's): every other message keeps the props it had, so a
  // long conversation isn't rendered again on every word of a reply — which is what makes scrolling it stutter.
  return <>{at(0)}{messages.map((m, i) => <Fragment key={m.id}><Message m={m} now={m.streaming ? now : 0} />{at(i + 1)}</Fragment>)}</>;
}

const Message = memo(function Message({ m, now }: { m: ChatMessage; now: number }) {
  const text = m.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  if (m.role === "task") {
    return (
      <details className="chat-msg task">
        <summary>Task from Solipsist <span className="muted">({num(Math.round(text.length / 4))} tokens)</span></summary>
        <pre>{text}</pre>
      </details>
    );
  }
  if (m.role === "user") return <div className="chat-msg user"><Text text={text} /></div>;
  // Thinking and the agent's own tool calls fold into one line of work; text stays outside it, and so does a call to
  // one of Solipsist's tools: that is the result the writer decides on, not work. The turn's stats stay under the
  // reply, folded or not.
  const parts: ({ work: Work[] } | { text: ChatBlock } | { reply: ChatTool })[] = [];
  for (const b of m.blocks) {
    if (b.type === "text") parts.push({ text: b });
    else if (b.type === "tool" && isReplyTool(b)) parts.push({ reply: b });
    else { const last = parts.at(-1); if (last && "work" in last) last.work.push(b); else parts.push({ work: [b] }); }
  }
  const live = m.streaming ? liveRate(m, now) : undefined;
  const lastIndex = parts.length - 1;
  return (
    <div className={`chat-msg assistant${m.streaming ? " streaming" : ""}`}>
      {parts.map((p, i) => "work" in p
        ? <WorkFold key={i} blocks={p.work} streaming={!!m.streaming && i === lastIndex} />
        : "reply" in p ? <ReplyCard key={i} b={p.reply} />
        : <Block key={i} b={p.text} />)}
      {m.streaming && !m.blocks.some((b) => (b.type === "text" || b.type === "thinking") && b.text) && !m.blocks.some((b) => b.type === "tool") && <span className="chat-caret" aria-label="Thinking" />}
      {m.error && <p className="chat-msg-error">{/abort/i.test(m.error) ? "Stopped." : m.error}</p>}
      <Stats stats={m.stats} live={live} />
    </div>
  );
});

type Work = Exclude<ChatBlock, { type: "text" }>;

/**
 * A run of thinking and tool calls, folded into one line: "Worked for 41s · 2 tools" (or what it is doing now, while it
 * streams). Open while the turn streams, so the writer sees the work happen; closed after, unless a tool failed (a
 * failure must not hide) or the writer opened it.
 */
function WorkFold({ blocks, streaming }: { blocks: Work[]; streaming: boolean }) {
  const tools = blocks.filter((b): b is Extract<Work, { type: "tool" }> => b.type === "tool");
  const failed = tools.filter((t) => t.isError).length;
  const ms = tools.reduce((n, t) => n + (t.durationMs ?? 0), 0);
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? (streaming || tools.some((t) => t.running) || failed > 0);
  const running = tools.find((t) => t.running);
  const label = streaming
    ? (running ? `Running ${running.name}…` : "Thinking…")
    : `${ms >= 500 ? `Worked for ${ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`}` : "Thought"}${tools.length ? ` · ${tools.length} ${tools.length === 1 ? "tool" : "tools"}` : ""}`;
  return (
    <details className="chat-work" open={open}>
      <summary onClick={(e) => { e.preventDefault(); setManual(!open); }}>
        <svg className="chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>
        <span>{label}</span>
        {failed > 0 && <span className="chat-work-failed"> · {failed} failed</span>}
      </summary>
      <div className="chat-work-body">
        {blocks.map((b, i) => <Block key={i} b={b} />)}
      </div>
    </details>
  );
}

function Block({ b }: { b: ChatBlock }) {
  if (b.type === "text") return b.text ? <Text text={b.text} /> : null;
  if (b.type === "thinking") return b.text ? <details className="chat-thinking"><summary><span>Thinking</span> <i>{b.text.replace(/\s+/g, " ").trim().slice(0, 90)}</i></summary><pre>{b.text}</pre></details> : null;
  return <Tool b={b} />;
}

/**
 * A call to one of Solipsist's own tools (`suggest`, `answer`, `decline`): not work the agent did but what it has given
 * back, so it is shown apart from the agent's own calls — the suggestion as it will read on the page, the answer, or
 * the reason it declined, with its note. A call the page refused says so, and the agent's next one takes its place; a
 * call whose arguments can't be read yet (one still streaming in) is shown as any other tool call.
 */
export function ReplyCard({ b }: { b: ChatTool }) {
  const call = readReplyCall(b);
  if (!call) return <Tool b={b} />;
  const state = b.running ? "running" : b.isError ? "refused" : "done";
  return (
    <div className={`chat-reply ${call.tool} ${state}`}>
      <div className="chat-reply-head">
        <span className="chat-reply-tag">Solipsist</span>
        <span className="chat-reply-label">{call.label}</span>
        {call.where && <span className="chat-reply-where">{call.where}</span>}
        {b.running && <span className="chat-reply-state">sending…</span>}
        {b.isError && <span className="chat-reply-state">not used</span>}
      </div>
      {call.markdown !== undefined && <div className="chat-reply-body">{call.markdown || "(nothing: the text goes)"}</div>}
      {call.answer && <div className="chat-reply-body">{call.answer}</div>}
      {call.reason && <div className="chat-reply-reason">{call.reason}</div>}
      {call.edits?.map((e, i) => (
        <Fragment key={i}>
          <div className="chat-edit del">{e.before || "(nothing)"}</div>
          <div className="chat-edit add">{e.after || "(removed)"}</div>
        </Fragment>
      ))}
      {call.note && <p className="chat-reply-note">{call.note}</p>}
      {b.isError && b.result && <p className="chat-reply-refused">{b.result}</p>}
    </div>
  );
}

/** A tool call: its name and what it is about, how it went, and its arguments and result folded away. */
export function Tool({ b }: { b: Extract<ChatBlock, { type: "tool" }> }) {
  const state = b.running ? "running" : b.isError ? "error" : "done";
  return (
    <details className={`chat-tool ${state}`}>
      <summary>
        <span className="chat-tool-icon" aria-label={state}>{b.running ? "" : b.isError ? "✕" : "✓"}</span>
        <b>{b.name}</b>
        {b.brief && <span className="chat-tool-brief">{b.brief}</span>}
        {b.durationMs !== undefined && <span className="muted">{b.durationMs < 1000 ? `${b.durationMs} ms` : `${(b.durationMs / 1000).toFixed(1)} s`}</span>}
      </summary>
      <pre className="chat-tool-args">{b.args}</pre>
      {b.result !== undefined && <pre className="chat-tool-result">{b.result || "(empty)"}</pre>}
    </details>
  );
}

/** Under a reply: the model, tokens in and out, the rate (live while it streams), the time and the cost. */
export function Stats({ stats, live }: { stats?: ChatStats; live?: number }) {
  const parts: string[] = [];
  if (live !== undefined) parts.push(`~${Math.round(live)} tok/s`);
  if (stats?.input) parts.push(`${num(stats.input)} in`);
  if (stats?.output) parts.push(`${num(stats.output)} out`);
  if (stats?.tokensPerSec) parts.push(`${Math.round(stats.tokensPerSec)} tok/s`);
  if (stats?.ms) parts.push(`${(stats.ms / 1000).toFixed(1)} s`);
  if (stats?.costUsd) parts.push(usd(stats.costUsd));
  return parts.length ? <div className="chat-stats">{parts.join(" · ")}</div> : null;
}

const SEGMENT = /(```[\s\S]*?(?:```|$)|<suggestion\b[^>]*>[\s\S]*?(?:<\/suggestion>|$)|<edit\b[^>]*>[\s\S]*?(?:<\/edit>|$)|<answer\b[^>]*>[\s\S]*?(?:<\/answer>|$)|<note>[\s\S]*?(?:<\/note>|$)|<decline>[\s\S]*?(?:<\/decline>|$))/g;

const LABEL: Record<string, string> = { suggestion: "Suggestion", edit: "Edit", answer: "Answer", note: "Note", decline: "Declined" };
const side = (body: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`).exec(body)?.[1]?.trim() ?? "";

/** The agent's text: code in blocks, its envelope (a suggestion, an edit, an answer, a note, a decline) set apart, the rest as written. */
export function Text({ text }: { text: string }) {
  return (
    <div className="chat-text">
      {text.split(SEGMENT).map((part, i) => {
        if (!part) return null;
        if (part.startsWith("```")) return <pre key={i} className="chat-code">{part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}</pre>;
        const tag = /^<(suggestion|edit|answer|note|decline)\b[^>]*>([\s\S]*?)(?:<\/\1>)?$/.exec(part);
        if (tag) {
          return (
            <div key={i} className={`chat-envelope ${tag[1]}`}>
              <span className="chat-envelope-label">{LABEL[tag[1]!]}</span>
              {tag[1] === "edit" ? (
                <>
                  <div className="chat-edit del">{side(tag[2]!, "before") || "(nothing)"}</div>
                  <div className="chat-edit add">{side(tag[2]!, "after") || "(removed)"}</div>
                </>
              ) : <div>{tag[2]!.trim()}</div>}
            </div>
          );
        }
        return <Fragment key={i}>{part.trim() && <p>{part.trim()}</p>}</Fragment>;
      })}
    </div>
  );
}
