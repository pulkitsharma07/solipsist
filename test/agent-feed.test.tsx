// The agent's note beside a task's loader: "waiting" before it is picked up, then only the step the run in
// flight is on, cut short with the rest kept for hover; none once done, or with the agent off.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "../src/app/doc/client";
import { keyLabel } from "../src/app/keys";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const at = Date.now();
const long = "x".repeat(300);
const run: AgentEvent[] = [
  { event: "start", at, run: 1 },
  { event: "step", at, run: 1, kind: "text", text: "From the run before." },
  { event: "end", at, run: 1, ok: true, durationMs: 10 },
  { event: "start", at, run: 2 },
  { event: "step", at, run: 2, kind: "tool", text: "Read {\"file_path\":\"/docs/a.md\"}", name: "Read", brief: "/docs/a.md", detail: "{\n  \"file_path\": \"/docs/a.md\"\n}" },
  { event: "step", at, run: 2, kind: "tool_result", text: long.slice(0, 200), detail: long },
  { event: "step", at, run: 2, kind: "init", text: "session abc" },
];

async function render(events: AgentEvent[], state: string, link: "live" | "offline" | "refused" | "paused" = "live") {
  const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
  const note = agentNote(events, link, state);
  return note ? renderToStaticMarkup(<AgentNote note={note} top={0} />) : "";
}

test("a waiting placeholder: it says so", async () => {
  const html = await render(run, "pending");
  expect(html).toContain("Waiting for agent to pick the task");
  expect(html).not.toContain("note-detail");
});

test("picked up: only the newest action of the run in flight, cut short, the whole of it for hover", async () => {
  const html = await render(run, "ack");
  expect(html).not.toContain("<b>"); // a result needs no label
  expect(html).not.toContain("/docs/a.md"); // an older step
  expect(html).not.toContain("session abc"); // not an action
  expect(html).toMatch(/<span>x{139}…<\/span>/);
  expect(html).toContain(long);
});

test("picked up, no step yet in this run: it says it is working", async () => {
  const html = await render([...run, { event: "end", at, run: 2, ok: true, durationMs: 1 }, { event: "start", at, run: 3 }], "ack");
  expect(html).toContain("Agent is working");
  expect(html).not.toContain("From the run before");
});

test("a tool call shows the tool and what it is about", async () => {
  const html = await render(run.slice(0, 5), "ack");
  expect(html).toContain("<b>Read</b><span>/docs/a.md</span>");
});

test("done, or the agent off or in another tab: no note", async () => {
  expect(await render(run, "done")).toBe("");
  expect(await render(run, "pending", "paused")).toBe("");
  expect(await render(run, "ack", "refused")).toBe("");
});

test("truncate cuts at the limit with an ellipsis and folds whitespace", async () => {
  const { truncate } = await import("../src/app/pages/AgentFeed");
  expect(truncate("a\n  b")).toBe("a b");
  expect(truncate("abcdefghij", 5)).toBe("abcd…");
  expect(truncate("abcde", 5)).toBe("abcde");
});

test("an error since the run started shows, in red, whether the placeholder waits or was picked up", async () => {
  const err: AgentEvent = { event: "step", at, run: 2, kind: "error", text: "Pi asked for permission (a yes or no), which can't be answered here, so it was refused: Allow? read" };
  for (const state of ["pending", "ack"]) {
    const html = await render([...run, err], state);
    expect(html).toContain("agent-note working error");
    expect(html).toContain("<b>error</b>");
    expect(html).toContain("Pi asked for permission");
  }
  // An error from a run before the last start is old news.
  expect(await render([err, { event: "start", at, run: 3 }], "pending")).toContain("Waiting for agent");
});

test("with several runs at once, each placeholder's note follows its own run", async () => {
  const { agentNote } = await import("../src/app/pages/AgentFeed");
  const both: AgentEvent[] = [
    { event: "hello", at },
    { event: "start", at, run: 1, taskType: "gen", task: "aaa" },
    { event: "start", at, run: 2, taskType: "gen", task: "bbb" },
    { event: "step", at, run: 1, kind: "text", text: "on aaa" },
    { event: "step", at, run: 2, kind: "text", text: "on bbb" },
  ];
  const line = (n: ReturnType<typeof agentNote>) => (n?.mode === "working" ? n.step?.line : n?.mode);
  expect(line(agentNote(both, "live", "ack", "aaa"))).toBe("on aaa");
  expect(line(agentNote(both, "live", "ack", "bbb"))).toBe("on bbb");
  expect(line(agentNote(both, "live", "pending", "ccc"))).toBe("waiting"); // no run on it yet
});

// After the writer takes a result: the note stays, saying so, with where the agent stands.
async function renderTaken(events: AgentEvent[], state: "accepted" | "btn", chat = true) {
  const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
  const note = agentNote(events, "live", state, "abc");
  return note ? renderToStaticMarkup(<AgentNote note={note} top={0} onChat={chat ? () => {} : undefined} />) : "";
}
const kept = [{ event: "hello", at }, { event: "start", at, run: 1, task: "abc", engine: "pi", chat: true }] as AgentEvent[];

test("accepted, the agent still here: Accepted, with the check, and the chat a click away", async () => {
  const html = await renderTaken([...kept, { event: "wait", at, run: 1, task: "abc", until: at + 300_000, finishedAt: at }], "accepted");
  expect(html).toContain("<span>Accepted</span>");
  expect(html).toContain("ni-done");
  expect(html).toContain("clickable");
});

test("accepted, the agent snoozed since: it says both", async () => {
  const html = await renderTaken([...kept, { event: "snooze", at, run: 1, task: "abc", finishedAt: at }], "accepted");
  expect(html).toContain("Accepted · snoozed");
  expect(html).toContain("ni-sleep");
});

test("accepted, nothing known of its agent in this stream: Accepted, clickable only when its conversation was kept", async () => {
  expect(await renderTaken([{ event: "hello", at }] as AgentEvent[], "accepted")).toContain("<span>Accepted</span>");
  expect(await renderTaken([{ event: "hello", at }] as AgentEvent[], "accepted")).toContain("clickable");
  expect(await renderTaken([{ event: "hello", at }] as AgentEvent[], "accepted", false)).not.toContain("clickable");
});

test("kept as a button: it says so", async () => {
  expect(await renderTaken([{ event: "hello", at }] as AgentEvent[], "btn")).toContain("<span>Kept as a button</span>");
});

test("with the agent off: no note, as for any other", async () => {
  const { agentNote } = await import("../src/app/pages/AgentFeed");
  expect(agentNote(kept, "paused", "accepted", "abc")).toBeNull();
});

test("an accepted note's hover offers the chat, not Ask again", async () => {
  const html = await renderTaken([...kept, { event: "snooze", at, run: 1, task: "abc", finishedAt: at }], "accepted");
  expect(html).toContain("title=\"Accepted. The agent is snoozed");
  expect(html).toContain(`Chat (${keyLabel("Mod-Alt-c")}) wakes it`);
  expect(html).not.toContain("Ask again");
});

test("in a chat: In chat, and Working… while the agent answers there; the bubble stays", async () => {
  const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
  const chatting = [...kept, { event: "chat", at, run: 0, task: "abc" }] as AgentEvent[];
  const html = (events: AgentEvent[]) => renderToStaticMarkup(<AgentNote note={agentNote(events, "live", "sug", "abc")!} top={0} />);
  expect(html(chatting)).toContain("<span>In chat</span>");
  const busy = [...chatting, { event: "chat_busy", at, run: 0, task: "abc", busy: true }] as AgentEvent[];
  expect(html(busy)).toContain("<span>Working…</span>");
  expect(html(busy)).toContain("ni-chat");
  expect(html([...busy, { event: "chat_busy", at, run: 0, task: "abc", busy: false }] as AgentEvent[])).toContain("<span>In chat</span>");
  // After the result was accepted, too.
  expect(renderToStaticMarkup(<AgentNote note={agentNote(busy, "live", "accepted", "abc")!} top={0} />)).toContain("<span>Working…</span>");
});

test("declined: the note gives the agent's reason instead of Done, kept agent or not; nothing with the agent off", async () => {
  const { AgentNote, agentNote, declinedNote } = await import("../src/app/pages/AgentFeed");
  const record = { status: "declined", note: "The section has no topic to go on: say what it is about." };
  const kept: AgentEvent[] = [{ event: "hello", at, run: 0 }, { event: "wait", at, run: 1, task: "abc", until: at + 60_000 }];
  for (const events of [kept, [{ event: "hello", at, run: 0 }] as AgentEvent[]]) {
    const note = declinedNote(agentNote(events, "live", "sug", "abc"), "sug", record, "live")!;
    const html = renderToStaticMarkup(<AgentNote note={note} top={0} />);
    expect(html).toContain("<b>Declined</b><span>The section has no topic to go on: say what it is about.</span>");
    expect(html).toContain("agent-note");
    expect(html).toContain(" declined");
    expect(html).toContain("ni-declined");
    expect(html).not.toContain(">Done<");
  }
  expect(declinedNote(null, "sug", { status: "declined" }, "live")!.declined).toBe("No reason given");
  expect(declinedNote(null, "sug", record, "paused")).toBeNull();
  expect(declinedNote(null, "sug", { status: "suggested", note: "x" }, "live")).toBeNull();
});

test("a button's note says when its request last ran, and its hover when its schedule runs it next", async () => {
  const { AgentNote, agentNote } = await import("../src/app/pages/AgentFeed");
  const ran = new Date(); ran.setHours(20, 56, 0, 0);
  const clock = ran.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const html = (events: AgentEvent[], extra: object) => renderToStaticMarkup(<AgentNote note={{ ...agentNote(events, "live", "btn", "abc")!, ...extra }} top={0} />);
  expect(html([{ event: "hello", at }] as AgentEvent[], { lastRun: ran.getTime() })).toContain(`<span>Last run ${clock}</span>`);
  // Its agent snoozed since: still just when it ran.
  const snoozed = html([...kept, { event: "snooze", at, run: 1, task: "abc", finishedAt: at }] as AgentEvent[], { lastRun: ran.getTime(), nextRun: ran.getTime() + 60_000 });
  expect(snoozed).toContain(`<span>Last run ${clock}</span>`);
  expect(snoozed).toContain("Its schedule runs it next at");
  // Never run since it became a button (no record time): it says what it is.
  expect(html([{ event: "hello", at }] as AgentEvent[], {})).toContain("<span>Kept as a button</span>");
});

