// The agent, end to end in a fake DOM: the writer asks with Mod-., the server's loop runs the (scripted) model, the
// suggestion shows in the page, and the writer decides; with the races a real page has: the writer typing, deleting or
// leaving while a run works, runs failing, the agents turned off, many at once.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { Gate, startApp, type App, type PageView } from "./app";

setDefaultTimeout(20_000);
let app: App;
/** The page on disk, without the comments block (its trailing newline aside). */
const body = (p: PageView) => app.body(p.id).trimEnd();
beforeAll(async () => { app = await startApp({ AGENT_CONCURRENCY: "2", AGENT_MAX_RUNS: "6" }); });
afterAll(() => app.close());
let open: PageView[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  const { stopAllPages } = await import("../../src/server/agent/pageAgents");
  await stopAllPages("test over");
  app.model.runs = [];
  app.model.peak = 0;
  app.model.script = () => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: " Hello." });
});

let n = 0;
/** A fresh page with `markdown`, opened. */
async function page(markdown: string) {
  const id = `p${++n}`;
  app.write(id, markdown);
  const p = await app.open(id);
  open.push(p);
  return p;
}
/** Asks at the end of `after` (a point) and returns the task's id once its run has started. */
async function ask(p: PageView, after: string) {
  const before = app.model.runs.length;
  p.caret(after);
  p.press("Mod-.");
  await p.until("the run to start", () => app.model.runs.length > before);
  return app.model.runs.at(-1)!.task;
}
const status = (p: PageView, task: string) => app.records(p.id)[task]?.status;

test("accept puts the suggestion in the page; reject leaves the page as it was; both are recorded", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.\n");
  app.model.script = (r) => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: r.n === 1 ? " Alpha." : " Beta." });
  const a = await ask(p, "One.");
  await p.until("first suggestion", () => status(p, a) === "suggested" && p.$$(".sug-preview").length === 1);
  const b = await ask(p, "Two.");
  await p.until("second suggestion", () => status(p, b) === "suggested" && p.$$(".sug-preview").length === 2);

  p.caret("One.");
  p.press("Mod-Alt-y");
  p.caret("Two.");
  p.press("Mod-Alt-n");
  await p.until("both decided on disk", () => status(p, a) === "accepted" && status(p, b) === "rejected");
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne. Alpha.\n\nTwo.");
  expect(p.$$(".sug-preview")).toHaveLength(0);
  expect(p.markdown.trim()).toBe(app.body(p.id).trim());
});

test("the writer types elsewhere while the run works: both their text and the suggestion survive", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.\n");
  const gate = new Gate();
  app.model.script = async () => { await gate.wait(); return { kind: "suggestion", mode: "at", place: "inline", suggestion: " Agent." }; };
  const task = await ask(p, "One.");
  await p.until("acked on disk", () => status(p, task) === "ack");
  p.caret("Two.");
  for (const w of [" a", " b", " c"]) { p.type(w); await Bun.sleep(25); }
  await p.saved();
  gate.release();
  await p.until("the suggestion", () => status(p, task) === "suggested" && !!p.$(".sug-preview"));
  p.caret("One.");
  p.press("Mod-Alt-y");
  await p.until("accepted", () => status(p, task) === "accepted");
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne. Agent.\n\nTwo. a b c");
});

test("the writer deletes the placeholder while its run works: nothing lands, the record says dropped", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async () => { await gate.wait(); return { kind: "suggestion", mode: "at", place: "inline", suggestion: " Late." }; };
  const task = await ask(p, "One.");
  await p.until("acked", () => status(p, task) === "ack");
  p.removeMarker(task);
  await p.saved();
  gate.release();
  await p.until("dropped", () => status(p, task) === "dropped");
  await Bun.sleep(100);
  expect(body(p)).toBe("# A\n\nOne.");
  expect(p.$(".sug-preview")).toBeNull();
});

test("the writer changes the text a range run read: the card warns that accepting replaces their newer text, and it does", async () => {
  const p = await page("# A\n\nThe quick brown fox.\n\nEnd.\n");
  const gate = new Gate();
  app.model.script = async () => { await gate.wait(); return { kind: "suggestion", mode: "replace", place: "inline", suggestion: "A slow red fox." }; };
  const before = app.model.runs.length;
  p.select("The quick brown fox.");
  p.press("Mod-.");
  // A range kind with an optional instruction asks for it first: Enter sends none.
  await p.until("the instruction box", () => !!document.querySelector(".task-ask"));
  const input = document.querySelector(".task-ask textarea, .task-ask input") as HTMLTextAreaElement;
  p.press("Enter", input);
  await p.until("the run", () => app.model.runs.length > before);
  const task = app.model.runs.at(-1)!.task;
  await p.until("acked", () => status(p, task) === "ack");
  p.replace("quick", "very quick");
  await p.saved();
  gate.release();
  await p.until("the suggestion", () => status(p, task) === "suggested" && !!p.$(".sug-preview"));
  expect(app.records(p.id)[task]!.saw).toBe("The quick brown fox.");
  p.click(p.$(".sug-preview")!);
  await p.until("the card's warning", () => /changed after the suggestion was made\. Accepting replaces your newer text/.test(document.querySelector(".sug-stale")?.textContent ?? ""));
  p.click(p.button("Accept")!);
  await p.until("accepted", () => status(p, task) === "accepted");
  await p.saved();
  expect(body(p)).toBe("# A\n\nA slow red fox.\n\nEnd.");
});

test("a decline shows as declined; failed runs are retried, and the third in a row declines it", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.\n");
  app.model.script = (r) => (r.task && app.model.runsFor(r.task).length === 1 && r.n === 1 ? { kind: "decline", note: "Nothing to add." } : { fail: "model down" });
  const a = await ask(p, "One.");
  await p.until("declined", () => status(p, a) === "declined" && !!p.$(".sug-declined"));
  const b = await ask(p, "Two.");
  await p.until("declined after three failures", () => status(p, b) === "declined", 8000);
  expect(app.model.runsFor(b)).toHaveLength(3);
  expect(app.records(p.id)[b]!.failures).toBe(3);
});

test("a reply the server can't use is a failure, not a broken page: an edit of text that isn't there", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = (r) => (app.model.runsFor(r.task).length === 1 ? { kind: "suggestion", edits: [{ before: "Not in the page.", after: "x" }] } : { kind: "suggestion", mode: "at", place: "inline", suggestion: " Fixed." });
  const task = await ask(p, "One.");
  await p.until("the second try's suggestion", () => status(p, task) === "suggested");
  expect(app.model.runsFor(task)).toHaveLength(2);
  expect(body(p)).toBe("# A\n\nOne.<!-- gen:" + task + ":sug -->");
});

test("turning the agents off stops the run and sets the placeholder back to waiting; on again, it runs again", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async (r) => { if (app.model.runsFor(r.task).length === 1) await gate.wait(); return { kind: "suggestion", mode: "at", place: "inline", suggestion: " Second." }; };
  const task = await ask(p, "One.");
  await p.until("acked", () => status(p, task) === "ack");
  // The switch is in the agent panel, which the status bar opens.
  p.click(p.button(/messages in a panel/)!);
  await p.until("the agent panel open", () => !!p.button(/background agent is/));
  p.click(p.button(/background agent is running/)!);
  await p.until("back to pending", () => status(p, task) === "pending");
  await p.until("the run to be stopped and its agent closed", () => app.model.runs[0]!.ended && app.model.open === 0);
  expect(app.records(p.id)[task]!.suggestion).toBeUndefined(); // the stopped run gave nothing
  await p.until("the switch to say it is stopped", () => !!p.button(/background agent is stopped/));
  p.click(p.button(/background agent is stopped/)!);
  await p.until("the suggestion from the second run", () => status(p, task) === "suggested", 8000);
  expect(app.body(p.id)).toContain(`<!-- gen:${task}:sug -->`);
});

test("closing the tab mid-run: the run goes on, and the page opened again shows its suggestion", async () => {
  const p = await page("# A\n\nOne.\n");
  const gate = new Gate();
  app.model.script = async () => { await gate.wait(); return { kind: "suggestion", mode: "at", place: "inline", suggestion: " Meanwhile." }; };
  const task = await ask(p, "One.");
  await p.until("acked", () => status(p, task) === "ack");
  await p.close();
  gate.release();
  await app.until("suggested with no tab", () => status(p, task) === "suggested");
  const again = await app.open(p.id);
  open.push(again);
  await again.until("the suggestion in the reopened page", () => again.$(".sug-preview")?.textContent === " Meanwhile.");
});

test("many at once: never more runs than the page's concurrency, and every one lands", async () => {
  const lines = ["One.", "Two.", "Three.", "Four.", "Five."];
  const p = await page(`# A\n\n${lines.join("\n\n")}\n`);
  app.model.script = async (r) => { await Bun.sleep(60); return { kind: "suggestion", mode: "at", place: "inline", suggestion: ` S${r.n}.` }; };
  for (const l of lines) { p.caret(l); p.press("Mod-."); }
  await p.until("five suggestions", () => p.$$(".sug-preview").length === 5, 10000);
  expect(app.model.peak).toBeLessThanOrEqual(2);
  expect(Object.values(app.records(p.id)).map((r) => r.status)).toEqual(["suggested", "suggested", "suggested", "suggested", "suggested"]);
});

test("a suggestion that edits another block: accepting it applies the edit too, in the page and on disk", async () => {
  const p = await page("# A\n\nOne.\n\nOld line.\n");
  app.model.script = () => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: " Done.", edits: [{ before: "Old line.", after: "New line." }] });
  const task = await ask(p, "One.");
  await p.until("suggested", () => status(p, task) === "suggested" && !!p.$(".sug-preview"));
  expect(p.$$(".sug-old-block").length).toBeGreaterThan(0); // the edited block shows as the old text
  p.caret("One.");
  p.press("Mod-Alt-y");
  await p.until("accepted", () => status(p, task) === "accepted");
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne. Done.\n\nNew line.");
});

test("ask again from the card: the next run is told what was turned down, and its suggestion replaces the first", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = (r) => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: r.prompt.includes("Take one.") ? " Take two." : " Take one." });
  const task = await ask(p, "One.");
  await p.until("first", () => p.$(".sug-preview")?.textContent === " Take one.");
  p.click(p.$(".sug-preview")!); // pins the card
  await p.until("the card", () => !!p.button("Ask again"));
  p.click(p.button("Ask again")!);
  await p.until("second", () => p.$(".sug-preview")?.textContent === " Take two.", 8000);
  expect(app.model.runsFor(task)).toHaveLength(2);
  expect(app.records(p.id)[task]!.asked_again).toBe(1);
});

test("an answer to a question shows as Answered and changes nothing in the page", async () => {
  const p = await page("# A\n\nOne.\n");
  app.model.script = () => ({ kind: "answer", answer: "It is a list." });
  const task = await ask(p, "One.");
  await p.until("answered", () => !!app.records(p.id)[task]?.answer && !!p.$(".sug-answer"));
  expect(body(p)).toBe(`# A\n\nOne.<!-- gen:${task}:sug -->`);
});

// The cards' buttons, by what they decide.
const decision = (d: string) => document.querySelector(`.sug-card [data-decision="${d}"]`) as HTMLElement | null;
async function decide(p: PageView, d: string) {
  await p.until(`the card's ${d} button`, () => !!decision(d));
  p.click(decision(d)!);
}
const preview = (p: PageView, task: string) => p.$(`.sug-preview[data-sug="${task}"]`);
const pageSays = (text: string) => (document.body.textContent ?? "").includes(text);

test("the agent's result arrives as a suggestion; Accept puts it in the page, Undo brings the suggestion back", async () => {
  app.model.script = () => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: "filled by the agent", note: "Filled it." });
  const p = await page("# Agent\n\nThe plan is <!-- gen:abc --> done.\n");
  await p.until("the suggestion", () => preview(p, "abc")?.textContent === "filled by the agent");
  expect(body(p)).toBe("# Agent\n\nThe plan is <!-- gen:abc:sug --> done."); // nothing in the page yet
  await p.until("the count", () => pageSays("1 suggestion"));
  p.click(preview(p, "abc")!);
  await p.until("the note on the card", () => pageSays("Filled it."));
  await decide(p, "accepted");
  await p.until("the result in the file", () => body(p) === "# Agent\n\nThe plan is filled by the agent done." && p.saveLabel === "Saved");
  await p.until("the decision recorded", () => status(p, "abc") === "accepted");
  expect(p.$$(".sug-count")).toHaveLength(0);
  p.press("Mod-z");
  await p.until("the suggestion back in the page", () => !!preview(p, "abc"));
  await p.until("the suggestion back in the file", () => body(p) === "# Agent\n\nThe plan is <!-- gen:abc:sug --> done." && status(p, "abc") === "suggested");
});

test("the agent switch is the page's, kept in its file: off survives reopening; on takes the entry out again", async () => {
  const p = await page("# Switch\n\nJust words.\n");
  /** The switch in the agent panel, opened from the status bar if it isn't open yet. */
  const agentSwitch = async (v: PageView) => {
    if (!v.$(".debug .agent-switch")) v.click(".statusbar .debug-toggle");
    await v.until("the switch", () => !!v.$(".debug .agent-switch"));
    return v.$(".debug .agent-switch")!;
  };
  const says = (v: PageView, word: string) => v.until(`the switch to say ${word}`, () => v.$(".debug .agent-switch b")?.textContent === word);
  await agentSwitch(p);
  await says(p, "on");
  p.click(await agentSwitch(p));
  await says(p, "off");
  await p.until("off in the file", () => /"agent":\s*\n\s*"on": false/.test(app.file(p.id)));
  await p.close();
  const again = await app.open(p.id);
  open.push(again);
  await agentSwitch(again);
  await says(again, "off");
  again.click(await agentSwitch(again));
  await says(again, "on");
  await again.until("on: nothing in the file", () => !/"on":/.test(app.file(p.id)));
});

test("rejecting a result after a request leaves the writer's text as it was", async () => {
  app.model.script = () => ({ kind: "suggestion", mode: "after", place: "blocks", suggestion: "- Vendor lead times\n- The Q3 freeze" });
  const p = await page("# List\n\n<!-- sel:lst -->List two risks<!-- /sel:lst -->\n");
  await p.until("the suggestion", () => preview(p, "lst")?.textContent?.includes("The Q3 freeze") === true);
  p.click(preview(p, "lst")!);
  await decide(p, "rejected");
  await p.until("the request gone from the file, its text kept", () => body(p) === "# List\n\nList two risks" && p.saveLabel === "Saved");
  await p.until("the decision recorded", () => status(p, "lst") === "rejected");
  expect(p.text).not.toContain("The Q3 freeze");
});

test("a request about a table below it: the table is marked for removal, and Accept removes it", async () => {
  app.model.script = () => ({ kind: "suggestion", edits: [{ before: "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |", after: "" }], note: "Removed the old table." });
  const p = await page("# Table\n\n<!-- sel:tbl -->Remove this table<!-- /sel:tbl -->\n\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n\nAfter.\n");
  await p.until("the table marked", () => p.$('.sug-old-block[data-sug="tbl"]')?.textContent?.includes("3 Sep") === true);
  expect(body(p)).toContain("| Web | 3 Sep |"); // nothing changed yet
  p.click(p.$(".sug-chip")!);
  await p.until("the card", () => pageSays("Removes a table"));
  await decide(p, "accepted");
  await p.until("the table gone from the file, the request's text kept", () => body(p) === "# Table\n\nRemove this table\n\nAfter." && p.saveLabel === "Saved");
  await p.until("the decision recorded", () => status(p, "tbl") === "accepted");
});

test("a declined request shows why; Ask again sends it back, and the next result arrives", async () => {
  app.model.script = (r) => (app.model.runsFor(r.task).length === 1 ? { kind: "decline", note: "Nothing says what goes here." } : { kind: "suggestion", mode: "at", place: "inline", suggestion: "second try" });
  const p = await page("# Again\n\nA spot: <!-- gen:dcl -->\n");
  await p.until("the chip", () => !!p.$(".sug-declined"));
  expect(p.$(".sug-declined")!.textContent).toBe("Declined: Nothing says what goes here.");
  p.click(p.$(".sug-declined")!);
  await decide(p, "asked_again");
  await p.until("the next result", () => preview(p, "dcl")?.textContent === "second try");
  expect(app.file(p.id)).toMatch(/"asked_again": 1/);
});

test("a selection with an instruction: rewritten in place, or answered after it; without one, followed up", async () => {
  const p = await page("# Sel\n\nThe rollout went reasonably well for most of the teams.\n\nWe ship behind a canary.\n\nList two risks.\n");
  app.model.script = (r) => (
    r.prompt.includes("<instruction>make it shorter</instruction>") ? { kind: "suggestion", mode: "replace", place: "inline", suggestion: "went well" }
    : r.prompt.includes("<instruction>give an example</instruction>") ? { kind: "suggestion", mode: "after", place: "inline", suggestion: "For example, 5% of traffic first." }
    : { kind: "suggestion", mode: "after", place: "inline", suggestion: "(vendors, the freeze)" }
  );
  /** Selects `text`, presses Cmd+., types `instruction` and Enter; then accepts the suggestion that arrives. */
  const request = async (text: string, instruction: string, shown: string) => {
    p.select(text);
    p.press("Mod-.");
    await p.until("the instruction box", () => !!document.querySelector(".task-ask textarea"));
    const box = document.querySelector(".task-ask textarea") as HTMLTextAreaElement;
    if (instruction) p.fill(box, instruction);
    p.press("Enter", box);
    await p.until("the box gone", () => !document.querySelector(".task-ask textarea"));
    const found = () => p.$$(".sug-preview").find((e) => e.textContent?.includes(shown));
    await p.until(`the suggestion "${shown}"`, () => !!found());
    p.click(found()!);
    await decide(p, "accepted");
  };

  await request("went reasonably well for most of the teams", "make it shorter", "went well");
  await p.until("the rewrite in the file", () => body(p).includes("The rollout went well.\n") && p.saveLabel === "Saved");
  await request("We ship behind a canary.", "give an example", "For example");
  await p.until("the example after the text", () => body(p).includes("We ship behind a canary. For example, 5% of traffic first.\n") && p.saveLabel === "Saved");
  await request("List two risks.", "", "(vendors, the freeze)");
  await p.until("the follow-up after the task", () => body(p) === "# Sel\n\nThe rollout went well.\n\nWe ship behind a canary. For example, 5% of traffic first.\n\nList two risks. (vendors, the freeze)" && p.saveLabel === "Saved");
  expect(body(p)).not.toContain("<!--");
});

test("no agent outlives the page: after every run, everything the engine opened is closed once the page stops", async () => {
  const p = await page("# A\n\nOne.\n");
  await ask(p, "One.");
  await p.until("suggested", () => !!p.$(".sug-preview"));
  await p.close();
  const { stopAllPages } = await import("../../src/server/agent/pageAgents");
  await stopAllPages("test over");
  expect(app.model.open).toBe(0);
});
