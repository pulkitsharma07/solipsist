// Pi, end to end in a fake DOM: the real engine on its scripted `faux` model (`test/e2e/pi-script.ts`). Covers what the
// scripted engine can't: the reply tools (a bad call fixed in the same run, an answer, edits, a decline), the envelope
// as fallback, kept agents (an ask again continues the same conversation), the chat revising a suggestion with a tool,
// several runs at once, and the page's agents stopping with its tab mid-run.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile, type TaskRecord } from "../../src/shared/docfile";
import { scriptedPi } from "../e2e/pi-script";
import { startApp, type App, type PageView } from "./app";

setDefaultTimeout(30_000);
const TABLE = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
let app: App;
beforeAll(async () => {
  app = await startApp({ AGENT_WAIT_MS: "120000", AGENT_CMD: "" }, {
    engines: async (root) => {
      const dir = join(root, "pi");
      mkdirSync(dir, { recursive: true });
      return [await scriptedPi(root, dir)];
    },
  });
});
afterAll(() => app.close());
let open: PageView[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

async function page(id: string, markdown: string) {
  app.write(id, markdown);
  const p = await app.open(id);
  open.push(p);
  return p;
}
const body = (id: string) => parseFile(app.file(id)).markdown;
const record = (id: string, task: string): TaskRecord | undefined => app.records(id)[task];
/** What the scripted model was asked, in order. */
const requests = (task: string): { task: string; chat: boolean; failed: boolean; users: number; system: boolean; inMessage: boolean; askedAgain: boolean }[] => {
  try { return readFileSync(join(app.root, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.task === task); } catch { return []; }
};
const preview = (p: PageView, task: string) => p.$(`.sug-preview[data-sug="${task}"]`);
const decision = (d: string) => document.querySelector(`.sug-card [data-decision="${d}"]`) as HTMLElement | null;
async function decide(p: PageView, d: string) {
  await p.until(`the card's ${d} button`, () => !!decision(d));
  p.click(decision(d)!);
}
async function accept(p: PageView, task: string) {
  p.click(preview(p, task)!);
  await decide(p, "accepted");
}
const shows = (p: PageView, task: string, text: string) => p.until(`${task}'s suggestion`, () => preview(p, task)?.textContent === text, 10_000);

test("a reply tool call that can't be used is fixed in the same run: the writer sees only the fixed suggestion", async () => {
  const p = await page("tools", "# Tools\n\nThe plan is <!-- gen:tls --> done.\n");
  await shows(p, "tls", "fixed by the tool");
  // One run: the model saw its call refused and made it again, in the same conversation.
  expect(requests("tls").map((r) => r.failed)).toEqual([false, true]);
  expect(record("tools", "tls")).toMatchObject({ status: "suggested", suggestion: "fixed by the tool", note: "Fixed my call.", failures: 0 });
  expect(record("tools", "tls")!.agent).toMatchObject({ engine: "pi", session: expect.any(String) });
  expect(body("tools")).toBe("# Tools\n\nThe plan is <!-- gen:tls:sug --> done.");
  await accept(p, "tls");
  await p.until("the result in the file", () => body("tools") === "# Tools\n\nThe plan is fixed by the tool done." && p.saveLabel === "Saved");
});

test("the answer tool: the card shows the answer, and nothing goes in the page", async () => {
  const p = await page("answer", '# Answer\n\n<!-- sel:ans "is this right?" -->Water boils at 90°C.<!-- /sel:ans -->\n');
  await p.until("the chip", () => !!p.$(".sug-answer"), 10_000);
  p.click(p.$(".sug-answer")!);
  await p.until("the answer on the card", () => document.querySelector(".sug-card .sug-answer-text")?.textContent?.includes("100°C at sea level") === true);
  expect(record("answer", "ans")).toMatchObject({ status: "suggested", answer: "No: water boils at 100°C at sea level." });
  expect(body("answer")).toBe('# Answer\n\n<!-- sel:ans:sug "is this right?" -->Water boils at 90°C.<!-- /sel:ans:sug -->');
});

test("the suggest tool with edits only: the table is marked for removal, and Accept removes it", async () => {
  const p = await page("edits", `# Edits\n\n<!-- sel:edt "remove the table" -->Below.<!-- /sel:edt -->\n\n${TABLE}\n\nAfter.\n`);
  await p.until("the table marked", () => p.$('.sug-old-block[data-sug="edt"]')?.textContent?.includes("3 Sep") === true, 10_000);
  expect(body("edits")).toContain("| Web | 3 Sep |");
  p.click(p.$(".sug-chip")!);
  await decide(p, "accepted");
  await p.until("the table gone, the request's text kept", () => body("edits") === "# Edits\n\nBelow.\n\nAfter." && p.saveLabel === "Saved");
});

test("declined with the tool; Ask again goes to the same agent, which goes on with the same conversation", async () => {
  const p = await page("again", "# Again\n\nA spot: <!-- gen:dcl -->\n");
  await p.until("the chip", () => !!p.$(".sug-declined"), 10_000);
  expect(p.$(".sug-declined")!.textContent).toBe("Declined: Nothing says what goes here.");
  const session = record("again", "dcl")!.agent!.session;
  p.click(p.$(".sug-declined")!);
  await decide(p, "asked_again");
  await shows(p, "dcl", "second try, same agent");
  // The second prompt continued the first conversation; the protocol is in the system prompt both times, in no message.
  expect(requests("dcl").map((r) => [r.users, r.system, r.inMessage, r.askedAgain])).toEqual([[1, true, false, false], [2, true, false, true]]);
  expect(record("again", "dcl")).toMatchObject({ status: "suggested", asked_again: 1, agent: { session } });
});

test("a reply with no tool call: the text envelope still makes the suggestion", async () => {
  const p = await page("envelope", "# Envelope\n\nSay <!-- gen:env --> here.\n");
  await shows(p, "env", "by the envelope");
  await accept(p, "env");
  await p.until("the result in the file", () => body("envelope") === "# Envelope\n\nSay by the envelope here." && p.saveLabel === "Saved");
});

test("three placeholders run at once; Accept all puts every result in", async () => {
  const p = await page("many", "# Many\n\nOne <!-- gen:ma1 -->.\n\nTwo <!-- gen:ma2 -->.\n\nThree <!-- gen:ma3 -->.\n");
  for (const task of ["ma1", "ma2", "ma3"]) await shows(p, task, `filled ${task}`);
  const down = (e: Element) => e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  down(p.$(".sug-count")!);
  const item = () => ([...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]).find((m) => m.textContent?.includes("Accept all"));
  await p.until("the menu", () => !!item());
  down(item()!);
  await p.until("every result in the file", () => body("many") === "# Many\n\nOne filled ma1.\n\nTwo filled ma2.\n\nThree filled ma3." && p.saveLabel === "Saved");
});

test("closing the tab mid-run leaves the agent working; opening it again shows the run live, and its suggestion arrives", async () => {
  const first = await page("slow", "# Slow\n\nWait <!-- gen:slo --> here.\n");
  // A step's note (the `ls` and its result), not the bare "Agent is working…" an acknowledged task shows anyway.
  const note = (p: PageView) => !!p.$(".agent-note.working.tool_result");
  await first.until("the step's note", () => note(first), 10_000);
  await first.close();
  await Bun.sleep(600);
  expect(body("slow")).toBe("# Slow\n\nWait <!-- gen:slo:ack --> here."); // still being worked on
  const p = await app.open("slow");
  open.push(p);
  // Told what is in flight as it opens: the run and its last step, replayed.
  await p.until("the step's note, replayed", () => note(p));
  writeFileSync(join(app.root, "release-slo"), "");
  await shows(p, "slo", "slow but done");
  // One run all along: the `ls`, then the suggestion once let go.
  expect(requests("slo").length).toBe(2);
});

test("turning the agent off in the agent panel stops the run in flight: the placeholder waits again", async () => {
  const p = await page("off", "# Off\n\nStop <!-- gen:off --> here.\n");
  await p.until("the step's note", () => !!p.$(".agent-note.working.tool_result"), 10_000);
  p.click(".statusbar .debug-toggle");
  await p.until("the switch", () => !!p.$(".debug .agent-switch"));
  p.click(p.$(".debug .agent-switch")!);
  await p.until("the ack reset", () => body("off") === "# Off\n\nStop <!-- gen:off --> here.");
  await p.until("the switch off", () => /Agent off/.test(p.$(".debug .agent-switch")?.textContent ?? ""));
  await Bun.sleep(600);
  expect(requests("off").length).toBe(2); // nothing started again
});

test("the chat on a suggestion: a bad suggest call is fixed in the chat's turn, the card is revised, and the agent goes back to waiting", async () => {
  const p = await page("chat", "# Chat\n\nThe rollout <!-- gen:cht --> went well.\n");
  await shows(p, "cht", "with no trouble at all");
  p.click(preview(p, "cht")!);
  await p.until("the card's chat button", () => !!document.querySelector('.sug-card [data-action="chat"]'));
  p.click(document.querySelector('.sug-card [data-action="chat"]')!);
  const modal = () => document.querySelector(".chat-modal") as HTMLElement | null;
  const box = () => document.querySelector(".chat-compose textarea") as HTMLTextAreaElement | null;
  await p.until("the chat open on the agent", () => !!modal() && !!box() && !box()!.disabled && !(document.querySelector(".chat-status")?.textContent ?? "").includes("Waking"));
  p.fill(box()!, "Can you make it shorter?");
  await Bun.sleep(10);
  p.press("Enter", box()!);
  await shows(p, "cht", "smoothly");
  // Both calls show in the chat, as Solipsist's own (not the agent's work): the refused one and the one that counted.
  // (The run's own suggestion is a card too, at the top: the conversation starts with the run.)
  const cards = () => [...modal()!.querySelectorAll(".chat-reply")];
  await p.until("the chat's reply cards", () => cards().length >= 3);
  expect(modal()!.querySelectorAll(".chat-reply.refused")).toHaveLength(1);
  expect(modal()!.querySelector(".chat-reply.refused")!.textContent).toContain("Not used");
  expect(cards().at(-1)!.querySelector(".chat-reply-body")!.textContent).toBe("smoothly");
  expect(cards().at(-1)!.textContent).toContain("Shorter, as asked.");
  expect(requests("cht").filter((r) => r.chat).map((r) => r.failed)).toEqual([false, true]);
  expect(record("chat", "cht")).toMatchObject({ status: "suggested", suggestion: "smoothly", note: "Shorter, as asked." });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await p.until("the chat gone", () => !modal());
  await accept(p, "cht");
  await p.until("the revised result in the file", () => body("chat") === "# Chat\n\nThe rollout smoothly went well." && p.saveLabel === "Saved");
});

test("no page logged an error", () => expect(app.errors).toEqual([]));
