// The chat window on every kind of reply, in a fake DOM: the fake agent of `test/chat-harness/agent.ts` streams text,
// thinking, tool calls and their errors, a new suggestion, a refused one, a failed run and a stopped one. How the log
// scrolls needs real layout and stays in `test/e2e/chat.e2e.ts`.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { useState } from "react";
import { ChatModal } from "../../src/app/pages/ChatModal";
import { chatRoutes } from "../chat-harness/agent";
import { clickOn, fillBox, pressKey, startApp, type App } from "./app";

setDefaultTimeout(20_000);
let app: App;
beforeAll(async () => { app = await startApp({}, { routes: chatRoutes(0.1) }); });
afterAll(() => app.close());

function Harness({ task }: { task: string }) {
  const [open, setOpen] = useState(true);
  return (
    <main>
      {!open && <button type="button" onClick={() => setOpen(true)}>Open the chat</button>}
      {open && <ChatModal page="harness" chat={{ task, title: `Harness · ${task}` }} onClose={() => setOpen(false)} />}
    </main>
  );
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const box = () => $(".chat-compose textarea") as HTMLTextAreaElement | null;
const status = () => $(".chat-status")?.textContent ?? "";
const allText = () => document.body.textContent ?? "";
const button = (label: string) => ($$("button") as HTMLButtonElement[]).find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
const until = (what: string, ok: () => boolean, ms?: number) => app.until(what, ok, ms, () => `status: ${status()}\nlog: ${$(".chat-log")?.textContent?.slice(-400)}`);

let views: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const v of views.splice(0)) await v.close(); });

async function mount(task: string) {
  views.push(await app.mount(<Harness task={task} />));
}
/** The chat on conversation `task`, ready for the writer to type. */
async function open(task = "empty") {
  await mount(task);
  await until("the chat to be ready", () => !!box() && !box()!.disabled);
}
/** Says `text`, and waits for it to show in the log (so the reply has started). */
async function say(text: string) {
  const sent = $$(".chat-msg.user").length;
  fillBox(box()!, text);
  await Bun.sleep(10);
  pressKey(box()!, "Enter");
  await until(`"${text}" in the log`, () => $$(".chat-msg.user").length > sent);
}
/** The agent is done: not busy, and its reply is the last message, finished. */
const ready = () => until("the agent to be ready", () => status() === "Ready" && !!$$(".chat-msg").at(-1)?.matches(".assistant:not(.streaming)"));
const busy = () => until("the agent to be busy", () => status() !== "Ready");
/** Opens every finished turn's work fold (they close when a turn ends), as the writer would. */
const unfold = () => { for (const d of $$(".chat-work:not([open])") as HTMLDetailsElement[]) toggle(d); };
const toggle = (d: HTMLDetailsElement) => { d.open = !d.open; d.dispatchEvent(new Event("toggle")); };
const last = (sel: string) => $$(sel).at(-1)!;

test("a tool call streams in: running, then its result, then the answer", async () => {
  await open();
  await say("tool please");
  await until("the tool running", () => !!$(".chat-tool.running"));
  expect(status()).toMatch(/Running bash|Calling bash/);
  await until("the tool done", () => !!$(".chat-tool.done"));
  await ready();
  await until("the answer", () => allText().includes("The root has the usual folders"));
  // The turn's work is folded away once it ends.
  expect($$(".chat-work[open]")).toHaveLength(0);
  expect($$(".chat-work > summary").filter((s) => /1 tool/.test(s.textContent ?? ""))).toHaveLength(1);
  unfold();
  // Folded: name and argument; open, the arguments and the result.
  const tool = $(".chat-tool") as HTMLDetailsElement;
  expect(tool.querySelector("summary")!.textContent).toContain("bash");
  expect(tool.open).toBe(false);
  toggle(tool);
  await until("the result", () => tool.querySelector(".chat-tool-result")?.textContent?.includes("Applications") === true);
  expect(last(".chat-msg.user").textContent).toBe("tool please");
  expect(last(".chat-stats").textContent).toMatch(/tok\/s/);
  expect($(".chat-totals")!.getAttribute("title")).toMatch(/in · .* out/);
});

test("several tools, one failing, then a new suggestion and its notice after the reply", async () => {
  await open();
  await say("tools");
  await ready();
  await until("the notice", () => $(".chat-log")!.lastElementChild?.getAttribute("class") === "chat-notice revised");
  expect($$(".chat-tool.done")).toHaveLength(2);
  expect($$(".chat-tool.error")).toHaveLength(1);
  expect(last(".chat-envelope.suggestion").textContent).toContain("smoothly");
  await say("hello");
  await ready();
  expect($(".chat-log")!.lastElementChild!.getAttribute("class")).toContain("chat-msg assistant");
  expect($$(".chat-notice")).toHaveLength(1);
});

test("thinking folds, code is a block, envelopes are set apart", async () => {
  await open();
  await say("think");
  await ready();
  unfold();
  const thinking = last(".chat-thinking") as HTMLDetailsElement;
  expect(thinking.open).toBe(false);
  toggle(thinking);
  await until("the thinking", () => thinking.querySelector("pre")?.textContent?.includes("Right.") === true);
  await say("code");
  await ready();
  expect(last(".chat-code").textContent).toContain("console.log(line)");
  await say("decline");
  await ready();
  expect(last(".chat-envelope.decline").textContent).toContain("Nothing on the page");
});

test("a refused suggestion and a failed run are warnings; Stop stops a reply", async () => {
  await open();
  await say("bad");
  await ready();
  await until("the warning", () => allText().includes("can't be used"));
  await say("error");
  await ready();
  expect(last(".chat-msg-error").textContent).toContain("429");
  await say("slow");
  await busy();
  clickOn(button("Stop")!);
  await ready();
  expect(last(".chat-msg-error").textContent).toBe("Stopped.");
  // Sending while it answers does nothing: the button is Stop, and Enter is ignored.
  await say("slow");
  await busy();
  fillBox(box()!, "ignored");
  await Bun.sleep(10);
  pressKey(box()!, "Enter");
  await Bun.sleep(30);
  expect(box()!.value).toBe("ignored");
  clickOn(button("Stop")!);
  await ready();
});

test("Solipsist's own tools are the result, not the agent's work", async () => {
  await open();
  await say("reply please");
  await ready();
  const cards = () => $$(".chat-reply");
  await until("the three cards", () => cards().length === 3);
  // The call the page refused, the one that counted, then the answer.
  expect(cards()[0]!.getAttribute("class")).toContain("refused");
  expect(cards()[0]!.textContent).toContain("not used");
  expect(cards()[0]!.textContent).toContain("goes `at`");
  expect(cards()[1]!.querySelector(".chat-reply-body")!.textContent).toBe("smoothly");
  expect(cards()[1]!.textContent).toContain("at · inline");
  expect(cards()[1]!.textContent).toContain("Shorter, as asked.");
  expect(cards()[1]!.querySelector(".chat-edit.add")!.textContent).toContain("went smoothly");
  expect(cards()[2]!.getAttribute("class")).toContain("answer");
  // Never folded away as the agent's work, and never counted as one of its tools.
  expect($$(".chat-work .chat-reply")).toHaveLength(0);
  expect($$(".chat-work > summary").filter((s) => /tool/.test(s.textContent ?? ""))).toHaveLength(0);
});

test("a chat with no agent says why; Escape closes, and it opens again", async () => {
  await open("empty");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until("the window gone", () => !$(".chat-modal"));
  clickOn(button("Open the chat")!);
  await until("the chat to be ready", () => !!box() && !box()!.disabled);
  await say("hello");
  await ready();
  await views.pop()!.close();

  await mount("gone");
  await until("why", () => allText().includes("This suggestion has no agent to chat with."));
  expect(box()!.disabled).toBe(true);
});

test("the chat talks on the one channel, /chat/:target", async () => {
  const from = app.requests.length;
  await open("empty");
  await say("hello");
  await ready();
  const paths = app.requests.slice(from);
  expect(paths).toContain("/api/pages/harness/chat/empty");
  expect(paths.filter((p) => p.includes("/agent/chat/") || p.includes("/pi-chat"))).toEqual([]);
});

test("no page logged an error", () => expect(app.errors).toEqual([]));
