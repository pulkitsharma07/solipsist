// Persisting agents in the page: the margin note beside a suggestion whose agent was
// kept (waiting, snoozed, in the chat), the Chat button on its card and its keys, and the chat modal.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TextSelection } from "@tiptap/pm/state";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "../src/app/doc/client";
import { Server, Tab } from "./browser-tab";

const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  document.body.innerHTML = "";
});

const at = Date.now();
async function note(events: AgentEvent[], state = "sug", id = "abc") {
  const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
  const n = agentNote(events, "live", state, id);
  return n ? renderToStaticMarkup(<AgentNote note={n} top={0} />) : "";
}
const ran: AgentEvent[] = [
  { event: "hello", at },
  { event: "start", at, run: 1, task: "abc" },
  { event: "end", at, run: 1, task: "abc", ok: true },
];

describe("the margin note beside a suggestion", () => {
  test("its agent kept: Done, with when it snoozes on hover; then Snoozed; In chat while the chat has it", async () => {
    const waiting = await note([...ran, { event: "wait", at, run: 1, task: "abc", until: at + 300_000 }]);
    expect(waiting).toContain("Done");
    expect(waiting).toContain("ni-done"); // a check, not the agent's blinking mark
    expect(waiting).not.toContain("pi-logo");
    expect(waiting).toContain("agent-note idle");
    expect(waiting).toContain("It snoozes at");
    expect(await note([...ran, { event: "wait", at, run: 1, task: "abc", until: at }, { event: "snooze", at, run: 1, task: "abc" }])).toContain("Snoozed");
    expect(await note([...ran, { event: "snooze", at, run: 1, task: "abc" }, { event: "chat", at, run: 1, task: "abc" }])).toContain("In chat");
    expect(await note([...ran, { event: "chat", at, run: 1, task: "abc" }, { event: "chat_end", at, run: 0, task: "abc" }])).toContain("Snoozed");
  });

  test("a snoozed agent says when it finished: from the snooze, from the hello after a reload, and while it waits on hover", async () => {
    const done = new Date(2026, 10, 1, 15, 42).getTime();
    const clock = new Date(done).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(await note([...ran, { event: "snooze", at, run: 1, task: "abc", finishedAt: done }])).toContain(`Snoozed · finished ${clock}`);
    expect(await note([{ event: "hello", at, agents: { abc: "snoozed" }, finished: { abc: done } }])).toContain(`finished ${clock}`);
    expect(await note([...ran, { event: "wait", at, run: 1, task: "abc", until: at + 1000, finishedAt: done }])).toContain(`it finished at ${clock}`);
    // An older server says nothing of it: no time, nothing broken.
    expect(await note([...ran, { event: "snooze", at, run: 1, task: "abc" }])).not.toContain("finished");
  });

  test("after a reload, from the stream's hello; another placeholder's events don't count", async () => {
    expect(await note([{ event: "hello", at, agents: { abc: "snoozed" } }])).toContain("Snoozed");
    expect(await note([{ event: "hello", at, agents: { abc: "chatting" } }])).toContain("In chat");
    expect(await note([...ran, { event: "wait", at, run: 2, task: "xyz", until: at }])).toBe("");
  });

  test("no agent kept, or the agent off: no note", async () => {
    expect(await note(ran)).toBe("");
    const { agentNote } = await import("../src/app/pages/AgentFeed");
    expect(agentNote([...ran, { event: "wait", at, run: 1, task: "abc", until: at }], "paused", "sug", "abc")).toBeNull();
  });
});

describe("the margin note beside a placeholder an agent is working on", () => {
  test("a run whose engine keeps its conversation (Pi) offers Chat, to look in on it; another doesn't", async () => {
    const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
    const working = (chat: boolean) => agentNote([{ event: "hello", at }, { event: "start", at, run: 1, task: "abc", ...(chat && { chat }) }], "live", "ack", "abc")!;
    const opened: string[] = [];
    expect(working(true)).toMatchObject({ mode: "working", chat: true });
    expect(renderToStaticMarkup(<AgentNote note={working(true)} top={0} onChat={() => opened.push("abc")} />)).toContain("clickable");
    expect(renderToStaticMarkup(<AgentNote note={working(false)} top={0} onChat={() => {}} />)).not.toContain("clickable");
    // The agent dot stands for the agent.
    expect(renderToStaticMarkup(<AgentNote note={working(true)} top={0} />)).toContain("pi-logo");
  });

  test("the engine's mark shows while its agent works, from the run's start (not the page's); the note keeps whose agent it is", async () => {
    const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
    const mark = (n: ReturnType<typeof agentNote>, page?: string) => (renderToStaticMarkup(<AgentNote note={n!} top={0} engine={page} />).match(/(pi)-logo/) ?? [])[1];
    const hello = { event: "hello", at } as const;
    // A run of another engine's: its start says so, whatever the page is on (an engine without a mark of its own gets Pi's).
    const running = agentNote([hello, { event: "start", at, run: 1, task: "abc", engine: "fake" }], "live", "ack", "abc");
    expect(running).toMatchObject({ mode: "working", engine: "fake" });
    expect(mark(running, "pi")).toBe("pi");
    expect(mark(agentNote([hello, { event: "start", at, run: 1, task: "abc", engine: "pi" }], "live", "ack", "abc"), "fake")).toBe("pi");
    // Not picked up yet: no agent, so no engine (and a clock, not a mark).
    const waiting = agentNote([hello], "live", "pending", "abc");
    expect(waiting!.engine).toBeUndefined();
    expect(mark(waiting, "fake")).toBeUndefined();
    // A kept agent: the wait says whose; after a reload, the greeting does; the page's choice has no say.
    const waits = agentNote([hello, { event: "wait", at, run: 1, task: "abc", engine: "fake", until: at }], "live", "sug", "abc");
    expect(waits).toMatchObject({ mode: "idle", engine: "fake" });
    const reloaded = agentNote([{ ...hello, agents: { abc: "snoozed" }, engines: { abc: "pi" } }], "live", "sug", "abc");
    expect(reloaded).toMatchObject({ mode: "snoozed", engine: "pi" });
    // Another task's events don't give it a note.
    expect(agentNote([hello, { event: "start", at, run: 1, task: "xyz", engine: "fake" }, { event: "wait", at, run: 1, task: "xyz", engine: "fake", until: at }], "live", "sug", "abc")).toBeNull();
  });

  test("each state of the pill has its own icon: a clock, the engine's mark, a check, a moon, a bubble, a warning", async () => {
    const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
    const html = (n: ReturnType<typeof agentNote>) => renderToStaticMarkup(<AgentNote note={n!} top={0} />);
    const hello = { event: "hello", at } as const;
    const ran = [hello, { event: "start", at, run: 1, task: "abc", engine: "pi" } as const];
    const icon = (h: string) => (h.match(/note-icon (ni-[a-z]+)/) ?? [])[1];
    expect(icon(html(agentNote([hello], "live", "pending", "abc")))).toBe("ni-wait");
    expect(html(agentNote(ran, "live", "ack", "abc"))).toContain("pi-logo note-icon ni-work");
    expect(icon(html(agentNote([...ran, { event: "wait", at, run: 1, task: "abc", until: at }], "live", "sug", "abc")))).toBe("ni-done");
    expect(icon(html(agentNote([...ran, { event: "snooze", at, run: 1, task: "abc" }], "live", "sug", "abc")))).toBe("ni-sleep");
    expect(icon(html(agentNote([...ran, { event: "chat", at, run: 1, task: "abc" }], "live", "sug", "abc")))).toBe("ni-chat");
    expect(icon(html(agentNote([...ran, { event: "step", at, run: 1, kind: "error", text: "boom" }], "live", "ack", "abc")))).toBe("ni-warn");
    // Done reads as done, in words and by its check.
    expect(html(agentNote([...ran, { event: "wait", at, run: 1, task: "abc", until: at }], "live", "sug", "abc"))).toContain("Done");
  });

  test("the page's model picker is in the page-wide chat only, with the page's model selected and engines that can't run greyed out", async () => {
    const { ChatModal } = await import("../src/app/pages/ChatModal");
    const { PAGE_CHAT } = await import("../src/shared/chat");
    const models = { model: "fake:large", onModel: () => {}, models: [
      { id: "pi:a", engine: "Pi", title: "A" },
      { id: "fake:large", engine: "Fake", title: "Large" },
      { id: "fake:small", engine: "Fake", title: "Small", unavailable: "Set FAKE_KEY" },
    ] };
    const page = renderToStaticMarkup(<ChatModal page="p" chat={{ task: PAGE_CHAT, title: "Chat with Fake" }} models={models} onClose={() => {}} />);
    expect(page).toContain('class="model-pick chat-model"');
    // Closed, the picker is its trigger, naming the page's model; its list and search are in test/model-picker.test.tsx.
    expect(page).toContain('<span class="model-name">Large</span>');
    // A suggestion's chat is with the agent that made it: no picker, whatever is passed.
    const card = renderToStaticMarkup(<ChatModal page="p" chat={{ task: "abc", title: "Suggestion" }} models={models} onClose={() => {}} />);
    expect(card).not.toContain("model-pick");
    expect(renderToStaticMarkup(<ChatModal page="p" chat={{ task: PAGE_CHAT, title: "Chat with Pi" }} onClose={() => {}} />)).not.toContain("model-pick");
  });

  test("EngineIcon: Pi's mark, for pi and anything else", async () => {
    const { EngineIcon, engineOf } = await import("../src/app/pages/EngineIcon");
    expect(renderToStaticMarkup(<EngineIcon engine="pi" />)).toContain("pi-logo");
    expect(renderToStaticMarkup(<EngineIcon engine="other" />)).toContain("pi-logo");
    expect(renderToStaticMarkup(<EngineIcon />)).toContain("pi-logo");
    expect(engineOf("fake:large")).toBe("fake");
    expect(engineOf("pi:~deepseek/deepseek-flash-latest")).toBe("pi");
  });

  test("⌥⌘C and vim's gc on it open the chat too", async () => {
    const server = new Server("The deadline is end of Q3 <!-- gen:abc --> for all teams.");
    const tab = new Tab(server.src);
    document.body.append(tab.editor.view.dom);
    await tab.save(server);
    server.handEdit((md) => md.replace("<!-- gen:abc -->", "<!-- gen:abc:ack -->"));
    tab.receive(server.src);
    const { markerSpots } = await import("../src/shared/docfile");
    const pos = markerSpots(tab.doc, "abc")!.points[0]!;
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, pos)));
    tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: mac, ctrlKey: !mac, altKey: true, bubbles: true, cancelable: true }));
    expect(tab.chats).toEqual(["abc"]);
    const { setVim } = await import("../src/app/editor/vim");
    setVim(tab.editor, true);
    for (const key of ["Escape", "g", "c"]) tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(tab.chats).toEqual(["abc", "abc"]);
  });
});

const reply = `<suggestion mode="at" place="inline">\n(30 September)\n</suggestion>`;
const PI = { engine: "pi", model: "m", session: "s-1" };
async function suggested(agent?: typeof PI) {
  const server = new Server("The deadline is end of Q3 <!-- gen:abc --> for all teams.");
  const tab = new Tab(server.src);
  document.body.append(tab.editor.view.dom);
  await tab.save(server);
  server.agentRun("abc", reply, undefined, agent);
  tab.receive(server.src);
  return tab;
}
const openCard = (tab: Tab) => {
  tab.editor.view.dom.querySelector<HTMLElement>('[data-sug="abc"]')!.click();
  return document.querySelector<HTMLElement>(".sug-card")!;
};
const chatButton = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('button[data-action="chat"]')!;

describe("Chat on the card", () => {
  test("with its agent kept: the button opens the chat on that suggestion and closes the card", async () => {
    const tab = await suggested(PI);
    const b = chatButton(openCard(tab));
    expect(b.textContent).toBe("Chat");
    expect(b.disabled).toBe(false);
    b.click();
    expect(tab.chats).toEqual(["abc"]);
    expect(document.querySelector(".sug-card")).toBeNull();
  });

  test("with none kept: shown, disabled, saying why", async () => {
    const tab = await suggested();
    const b = chatButton(openCard(tab));
    expect(b.disabled).toBe(true);
    expect(b.title).toContain("kept");
  });

  test("⌥⌘C and vim's gc at the suggestion open it too; not where there is no agent", async () => {
    const tab = await suggested(PI);
    const { suggestionsIn } = await import("../src/app/editor/suggestions");
    const s = suggestionsIn(tab.state)[0]!;
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, s.to)));
    tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: mac, ctrlKey: !mac, altKey: true, bubbles: true, cancelable: true }));
    expect(tab.chats).toEqual(["abc"]);
    const { setVim } = await import("../src/app/editor/vim");
    setVim(tab.editor, true);
    for (const key of ["Escape", "g", "c"]) tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(tab.chats).toEqual(["abc", "abc"]);

    const none = await suggested();
    const t = suggestionsIn(none.state)[0]!;
    none.dispatch(none.state.tr.setSelection(TextSelection.create(none.doc, t.to)));
    none.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: mac, ctrlKey: !mac, altKey: true, bubbles: true, cancelable: true }));
    expect(none.chats).toEqual([]);
  });
});

describe("the chat's conversation (applyChatEvent)", () => {
  test("a reply streams in: text and thinking by delta, a tool call then its result, and the whole reply at its end", async () => {
    const { applyChatEvent, liveRate } = await import("../src/shared/chat");
    let m = applyChatEvent([], { t: "history", messages: [{ id: "h0", role: "task", blocks: [{ type: "text", text: "the task" }], at }], busy: false });
    m = applyChatEvent(m, { t: "message", message: { id: "u1", role: "user", blocks: [{ type: "text", text: "shorter" }], at } });
    m = applyChatEvent(m, { t: "message", message: { id: "a1", role: "assistant", blocks: [], at, streaming: true } });
    m = applyChatEvent(m, { t: "delta", id: "a1", block: 0, kind: "thinking", delta: "Hmm" }, at);
    m = applyChatEvent(m, { t: "delta", id: "a1", block: 1, kind: "text", delta: "Sure" }, at + 100);
    m = applyChatEvent(m, { t: "delta", id: "a1", block: 1, kind: "text", delta: ", here." }, at + 1000);
    m = applyChatEvent(m, { t: "tool", id: "a1", block: 2, tool: { type: "tool", id: "t1", name: "read", brief: "/a.md", args: "{}", running: true } });
    expect(m.at(-1)!.blocks).toEqual([{ type: "thinking", text: "Hmm" }, { type: "text", text: "Sure, here." }, { type: "tool", id: "t1", name: "read", brief: "/a.md", args: "{}", running: true }]);
    expect(liveRate(m.at(-1)!, at + 1000)).toBeCloseTo(14 / 4, 5); // 14 characters in a second, about 4 a token
    m = applyChatEvent(m, { t: "tool_result", toolId: "t1", result: "text", isError: false, durationMs: 12 });
    expect(m.at(-1)!.blocks[2]).toMatchObject({ result: "text", running: false, durationMs: 12 });
    const before = m;
    expect(applyChatEvent(m, { t: "tool_result", toolId: "nope", result: "", isError: false })).toBe(before);
    m = applyChatEvent(m, { t: "message", message: { id: "a1", role: "assistant", blocks: [{ type: "text", text: "Sure, here." }], at, stats: { output: 5, tokensPerSec: 50 } } });
    expect(m.map((x) => x.id)).toEqual(["h0", "u1", "a1"]);
    expect(m.at(-1)!.streaming).toBeUndefined();
  });

  test("the writer's words and Solipsist's prompts told apart", async () => {
    const { chatMessage, chatRole } = await import("../src/shared/chat");
    expect(chatRole(chatMessage("make it <b>shorter</b>", "Intro."))).toEqual({ role: "user", text: "make it <b>shorter</b>" });
    expect(chatRole(chatMessage("again"))).toEqual({ role: "user", text: "again" });
    expect(chatRole("You are working on the page x. <page-file>… <chat>quoted</chat> …</page-file>").role).toBe("task");
  });
});

describe("the chat's view", () => {
  const html = async (el: (m: typeof import("../src/app/pages/ChatModal")) => any) => renderToStaticMarkup(el(await import("../src/app/pages/ChatModal")));

  test("the task folded away, the writer's words, and a reply with its envelope set apart, a tool call and its stats", async () => {
    const out = await html(({ ChatLog }) => (
      <ChatLog messages={[
        { id: "h0", role: "task", blocks: [{ type: "text", text: "You are working on the page…" }], at },
        { id: "u1", role: "user", blocks: [{ type: "text", text: "shorter please" }], at },
        { id: "a1", role: "assistant", at, stats: { model: "m", input: 1200, output: 34, tokensPerSec: 41.6, ms: 2300, costUsd: 0.00042 }, blocks: [
          { type: "tool", id: "t1", name: "read", brief: "/docs/a.md", args: "{}", result: "Plan", durationMs: 1500 },
          { type: "text", text: 'Here.\n<suggestion mode="at" place="inline">\nshort\n</suggestion>\n<note>Cut it.</note>' },
        ] },
      ]} />
    ));
    expect(out).toContain("<details class=\"chat-msg task\"><summary>Task from Solipsist");
    expect(out).toContain("shorter please");
    expect(out).toContain("chat-tool done");
    expect(out).toContain("<b>read</b>");
    expect(out).toContain("1.5 s");
    expect(out).toMatch(/chat-envelope suggestion.*Suggestion.*short/);
    expect(out).toMatch(/chat-envelope note.*Cut it\./);
    expect(out).toContain("1.2k in · 34 out · 42 tok/s · 2.3 s · $0.0004");
  });

  test("an <edit> and an <answer> in a reply are set apart, not shown as raw tags", async () => {
    const { Text } = await import("../src/app/pages/ChatModal");
    const out = renderToStaticMarkup(<Text text={"Sure.\n<edit><before>\nOld.\n</before><after></after></edit>\n<answer>Yes.</answer>\nDone."} />);
    expect(out).not.toContain("&lt;edit");
    expect(out).not.toContain("&lt;before");
    expect(out).toMatch(/chat-envelope edit.*Edit.*chat-edit del.*Old\..*chat-edit add.*\(removed\)/);
    expect(out).toMatch(/chat-envelope answer.*Answer.*Yes\./);
    expect(out).toContain("<p>Done.</p>");
  });

  test("thinking and tool calls fold into one work line, open while streaming, with the turn's stats under the reply", async () => {
    const blocks = [
      { type: "thinking", text: "Let me look at the page first." },
      { type: "tool", id: "t1", name: "read", brief: "a.md", args: "{}", result: "Plan", durationMs: 2000 },
      { type: "tool", id: "t2", name: "bash", brief: "ls", args: "{}", result: "x", durationMs: 1000 },
      { type: "text", text: "Done." },
    ];
    const done = await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, stats: { model: "m", input: 10, output: 5, ms: 3000 }, blocks } as any]} />);
    expect(done.match(/chat-work"/g)?.length).toBe(1);
    expect(done).toMatch(/<summary>.*Worked for 3s · 2 tools/);
    const fold = done.slice(done.indexOf("chat-work"), done.indexOf("Done."));
    expect(fold.match(/chat-tool done/g)?.length).toBe(2);
    expect(fold).not.toContain("chat-stats");
    expect(done.indexOf("chat-stats")).toBeGreaterThan(done.indexOf("Done.")); // under the reply, whether or not it worked first
    expect(done).not.toMatch(/<details class="chat-work" open/);
    const live = await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, streaming: true, blocks: [blocks[0]!, { ...blocks[1]!, running: true, result: undefined }] } as any]} />);
    expect(live).toMatch(/<details class="chat-work" open/);
    expect(live).toContain("Running read…");
    const failed = await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, blocks: [{ ...blocks[1]!, isError: true }, blocks[3]!] } as any]} />);
    expect(failed).toMatch(/<details class="chat-work" open/);
    expect(failed).toContain("1 failed");
    // work after text gets a fold of its own
    const after = await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, blocks: [blocks[3]!, blocks[1]!, blocks[3]!, blocks[2]!] } as any]} />);
    expect(after.match(/chat-work"/g)?.length).toBe(2);
  });

  test("a notice goes after the message it came after, not at the end of the log", async () => {
    const out = await html(({ ChatLog }) => (
      <ChatLog
        messages={[
          { id: "u1", role: "user", blocks: [{ type: "text", text: "first ask" }], at },
          { id: "a1", role: "assistant", blocks: [{ type: "text", text: "first reply" }], at },
          { id: "u2", role: "user", blocks: [{ type: "text", text: "second ask" }], at },
        ]}
        notices={[{ key: 1, kind: "revised", text: "Updated.", after: 2 }, { key: 2, kind: "warning", text: "Late.", after: 9 }]}
      />
    ));
    expect(out.indexOf("first reply")).toBeLessThan(out.indexOf("Updated."));
    expect(out.indexOf("Updated.")).toBeLessThan(out.indexOf("second ask"));
    expect(out.indexOf("second ask")).toBeLessThan(out.indexOf("Late."));
    expect(await html(({ ChatLog }) => <ChatLog messages={[]} notices={[{ key: 1, kind: "warning", text: "No agent.", after: 0 }]} />)).not.toContain("No conversation yet");
  });

  test("while streaming: a caret before the first word, a running tool spinning, and the live rate; an error and a stop said plainly", async () => {
    expect(await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", blocks: [], at, streaming: true }]} />)).toContain("chat-caret");
    const live = await html(({ ChatLog }) => <ChatLog now={at + 2000} messages={[{ id: "a", role: "assistant", at, streaming: true, live: { firstAt: at, chars: 400 }, blocks: [{ type: "text", text: "x" }, { type: "tool", id: "t", name: "bash", brief: "ls", args: "{}", running: true }] }]} />);
    expect(live).toContain("~50 tok/s");
    expect(live).toContain("chat-tool running");
    expect(await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, blocks: [], error: "Request was aborted" }]} />)).toContain("Stopped.");
    expect(await html(({ ChatLog }) => <ChatLog messages={[{ id: "a", role: "assistant", at, blocks: [], error: "429 rate limited" }]} />)).toContain("429 rate limited");
  });

  test("the status line follows the agent", async () => {
    const { chatStatus } = await import("../src/app/pages/ChatModal");
    const a = (blocks: any[], streaming = true) => [{ id: "a", role: "assistant" as const, at, blocks, streaming }];
    expect(chatStatus([], false)).toBe("Ready");
    expect(chatStatus([], true)).toBe("Thinking…");
    expect(chatStatus(a([{ type: "text", text: "hi" }]), true)).toBe("Writing…");
    expect(chatStatus(a([{ type: "tool", id: "t", name: "bash", brief: "", args: "", running: true }], false), true)).toBe("Running bash…");
  });

  test("the modal, before the conversation arrives", async () => {
    const out = await html(({ ChatModal }) => <ChatModal page="doc" chat={{ task: "abc", title: "Generate" }} onClose={() => {}} />);
    expect(out).toContain("Waking the agent…");
    expect(out).toContain("Generate");
    expect(out).toContain("<textarea");
  });
});
