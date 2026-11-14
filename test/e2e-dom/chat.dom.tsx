// The chats, end to end in a fake DOM: the page chat from its button and the chat behind a suggestion, through the real
// chat window, the server's chat routes and a scripted agent. With what a writer does to them: leaving mid-reply,
// coming back, starting over, and a reply that changes the page.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Gate, startApp, type App, type PageView } from "./app";

setDefaultTimeout(20_000);
let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(() => app.close());
let open: PageView[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  const { stopAllPages } = await import("../../src/server/agent/pageAgents");
  const { closeChats } = await import("../../src/server/chat");
  await stopAllPages("test over");
  await closeChats("test over");
  app.model.runs = [];
});

let n = 0;
async function page(markdown: string) {
  const id = `c${++n}`;
  app.write(id, markdown);
  const p = await app.open(id);
  open.push(p);
  return p;
}
const modal = () => document.querySelector(".chat-modal") as HTMLElement | null;
const log = () => document.querySelector(".chat-log")?.textContent ?? "";
const launch = (p: PageView) => p.$(".pi-launch")!;
/** Says `text` in the open chat, as the writer would: types it, then Enter. */
async function say(p: PageView, text: string) {
  await p.until("the chat to be ready", () => { const ta = modal()?.querySelector("textarea") as HTMLTextAreaElement | null; return !!ta && !ta.disabled; });
  const ta = modal()!.querySelector("textarea") as HTMLTextAreaElement;
  p.fill(ta, text);
  await Bun.sleep(10);
  p.press("Enter", ta);
}
const closeChat = (p: PageView) => p.click(p.button("Close the chat")!);

test("the page chat: open it from the button, ask, and the reply shows in the window", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = (r) => ({ text: r.prompt.includes("what is this") ? "It is a short page." : "?" });
  p.click(launch(p));
  await p.until("the chat window", () => !!modal());
  await say(p, "what is this about?");
  await p.until("the reply", () => log().includes("It is a short page."));
  expect(log()).toContain("what is this about?");
  await p.until("the button back to open once the reply is over", () => launch(p).dataset.state === "open");
});

test("leaving mid-reply: the button shows it working, then a new reply; opening again shows it and clears the dot", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async () => { await gate.wait(); return { text: "Finished while you were away." }; };
  p.click(launch(p));
  await say(p, "take your time");
  await p.until("working", () => launch(p).dataset.state === "working");
  closeChat(p);
  await p.until("the window gone", () => !modal());
  expect(launch(p).dataset.state).toBe("working");
  expect(p.$(".pi-launch-ring")).not.toBeNull();
  gate.release();
  await p.until("the reply came: up and unread", () => launch(p).dataset.state === "waiting" && !!p.$(".pi-launch-dot"));
  p.click(launch(p));
  await p.until("the reply in the reopened chat", () => log().includes("Finished while you were away."));
  expect(log()).toContain("take your time");
  await p.until("the dot cleared", () => !p.$(".pi-launch-dot") && launch(p).dataset.state === "open");
});

test("a change the page chat proposes lands on the page as a suggestion, and the chat says so", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = () => ({ text: 'Here you go.\n\n<suggestion mode="at" place="blocks">\nA new closing line.\n</suggestion>' });
  p.click(launch(p));
  await say(p, "add a closing line");
  await p.until("the suggestion on the page", () => p.$(".sug-preview")?.textContent?.includes("A new closing line.") === true);
  await p.until("the chat's notice", () => log().includes("A suggestion was added to the page."));
});

test("New chat forgets the conversation: the window opens empty on a fresh agent", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = () => ({ text: "Remembered." });
  p.click(launch(p));
  await say(p, "remember me");
  await p.until("the reply", () => log().includes("Remembered."));
  const starts = app.model.starts.length;
  p.click(p.button("New chat")!);
  await p.until("an empty chat", () => !!modal() && !log().includes("Remembered.") && app.model.starts.length > starts);
  expect(app.model.starts.at(-1)!.resume).toBeUndefined();
  await p.until("the button back to open", () => launch(p).dataset.state === "open");
});

test("closing and opening the page chat quickly, again and again, keeps one agent and one conversation", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = () => ({ text: "Still one." });
  p.click(launch(p));
  await say(p, "hello");
  await p.until("the reply", () => log().includes("Still one."));
  const starts = app.model.starts.length;
  for (let i = 0; i < 5; i++) {
    closeChat(p);
    await Bun.sleep(i * 7);
    p.click(launch(p));
    await Bun.sleep(5);
  }
  await p.until("the conversation back", () => log().includes("Still one.") && log().includes("hello"));
  expect(app.model.starts.length).toBe(starts);
  const { openChats } = await import("../../src/server/chat");
  expect(openChats()).toEqual([`${p.id}/page`]);
});

test("the chat behind a suggestion: Mod-Alt-c opens it on the agent that made it, and a new suggestion in a reply replaces the card's", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = (r) => (r.task ? { kind: "suggestion", mode: "at", place: "inline", suggestion: " First take." } : { text: 'Better:\n\n<suggestion mode="at" place="inline">\n Second take.\n</suggestion>' });
  p.caret("One.");
  p.press("Mod-.");
  await p.until("the suggestion", () => p.$(".sug-preview")?.textContent === " First take.");
  const starts = app.model.starts.length;
  p.caret("One.");
  p.press("Mod-Alt-c");
  await p.until("the suggestion's chat", () => !!modal() && !!modal()!.querySelector("textarea:not([disabled])"));
  expect(app.model.starts.length).toBe(starts); // the agent kept after the run, not a new one
  await say(p, "make it better");
  await p.until("the card revised", () => p.$(".sug-preview")?.textContent === " Second take.");
  await p.until("the chat's notice", () => log().includes("Your suggestion was updated on the page."));
});

test("opening a suggestion's chat while its run still works: it looks in, then lets the writer talk once the run ends", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async (r) => { if (r.task) { await gate.wait(); return { kind: "suggestion", mode: "at", place: "inline", suggestion: " Done." }; } return { text: "Hi." }; };
  p.caret("One.");
  p.press("Mod-.");
  await p.until("the run", () => app.model.runs.length === 1);
  const task = app.model.runs[0]!.task;
  // The page must have heard it: the key acts on what the writer sees.
  await p.until("acked in the page", () => p.markdown.includes(`gen:${task}:ack`));
  p.caret("One.");
  p.press("Mod-Alt-c");
  await p.until("the chat, looking in", () => !!modal() && /On its run/.test(modal()!.textContent ?? ""));
  expect((modal()!.querySelector("textarea") as HTMLTextAreaElement).placeholder).toMatch(/once it is done/);
  gate.release();
  await p.until("free to talk", () => !/On its run/.test(modal()!.textContent ?? "") && !(modal()!.querySelector("textarea") as HTMLTextAreaElement).disabled);
  await say(p, "thanks");
  await p.until("the reply", () => log().includes("Hi."));
});

for (const how of ["Escape", "a click outside"] as const) {
  test(`the suggestion's chat closed (${how}) while its agent replies: the agent keeps working, the card gets its suggestion, and the chat opened again shows the reply`, async () => {
    const p = await page("# A\n\nOne.\n");
    const gate = new Gate();
    app.model.script = async (r) => {
      if (r.task) return { kind: "suggestion", mode: "at", place: "inline", suggestion: " First take." };
      await gate.wait();
      return { text: 'Here is a better one.\n\n<suggestion mode="at" place="inline">\n Second take.\n</suggestion>' };
    };
    p.caret("One.");
    p.press("Mod-.");
    await p.until("the suggestion", () => p.$(".sug-preview")?.textContent === " First take.");
    p.caret("One.");
    p.press("Mod-Alt-c");
    await say(p, "make it better");
    await p.until("the agent replying", () => app.model.runs.length === 2 && !app.model.runs[1]!.ended);
    const reply = app.model.runs[1]!;
    if (how === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else p.click(document.querySelector(".chat-backdrop")!);
    await p.until("the window gone", () => !modal());
    await Bun.sleep(100);
    expect(reply.aborted).toBe(false); // not stopped by the window closing
    expect(reply.ended).toBe(false);
    gate.release();
    await p.until("the card revised by the reply", () => p.$(".sug-preview")?.textContent === " Second take.");
    expect(reply.aborted).toBe(false);
    p.caret("One.");
    p.press("Mod-Alt-c");
    await p.until("the reply in the chat opened again", () => log().includes("Here is a better one."));
    expect(log()).toContain("make it better");
  });
}

test("the page chat mid-reply: Send stays beside Stop, a message sent then is queued, and the same reply takes it in", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async (r) => { await gate.wait(); const more = r.take(); return { text: `Done${more.length ? `, and also: ${more.join("; ")}` : ""}.` }; };
  p.click(launch(p));
  await say(p, "summarise the page");
  await p.until("busy", () => !!p.button("Stop"));
  expect(p.button("Send")).not.toBeNull(); // still there, beside Stop
  await say(p, "keep it to one line");
  await p.until("the queued notice", () => /Sent mid-reply: “keep it to one line”/.test(log()));
  expect(log()).not.toMatch(/still answering/);
  gate.release();
  await p.until("the reply answering both", () => log().includes("Done, and also: keep it to one line."));
  await p.until("the queued notice gone, the message in the conversation", () => !/Sent mid-reply/.test(log()) && log().includes("keep it to one line"));
  expect(app.model.runs.filter((r) => !r.task)).toHaveLength(1); // one reply, not a second run
});

test("the suggestion's chat mid-reply: a message sent then shapes the suggestion the reply puts on the card", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async (r) => {
    if (r.task) return { kind: "suggestion", mode: "at", place: "inline", suggestion: " First take." };
    await gate.wait();
    const more = r.take();
    return { text: `<suggestion mode="at" place="inline">\n ${more.includes("in French") ? "Deuxième prise." : "Second take."}\n</suggestion>` };
  };
  p.caret("One.");
  p.press("Mod-.");
  await p.until("the suggestion", () => p.$(".sug-preview")?.textContent === " First take.");
  p.caret("One.");
  p.press("Mod-Alt-c");
  await say(p, "make it better");
  await p.until("busy", () => !!p.button("Stop"));
  await say(p, "in French");
  await p.until("queued", () => /Sent mid-reply: “in French”/.test(log()));
  gate.release();
  await p.until("the card revised with the steered word", () => p.$(".sug-preview")?.textContent === " Deuxième prise.");
});

test("an engine that can't take a message mid-reply: only Stop while it replies, as before", async () => {
  app.model.steers = false;
  try {
    const p = await page("# A\n\nOne.\n");
    const gate = new Gate();
    app.model.script = async () => { await gate.wait(); return { text: "Done." }; };
    p.click(launch(p));
    await say(p, "go");
    await p.until("busy", () => !!p.button("Stop"));
    expect(p.button("Send")).toBeNull();
    gate.release();
    await p.until("Send back", () => !!p.button("Send") && !p.button("Stop"));
  } finally {
    app.model.steers = true;
  }
});
