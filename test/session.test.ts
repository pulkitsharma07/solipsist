// Every scenario and edge case of the plan, played by the real `DocSession` on a real Tiptap editor in a fake DOM
// (`test/browser-tab.ts`), against the server's pure functions (`test/sim.ts`'s `Server`).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { joinBackward } from "@tiptap/pm/commands";
import { addColumnBefore, addRowBefore, deleteColumn, deleteRow } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import { afterAll, afterEach, beforeAll, describe as group, expect, test } from "bun:test";
import { applyPut } from "../src/server/put";
import { deleteComment, emptyBlock, parseFile, serializeFile } from "../src/shared/docfile";
import { insertPoint, taskIds as genIds } from "../src/app/editor/markerCommands";
import { freshTexts } from "../src/app/editor/freshText";
import { newBlockTexts } from "../src/app/editor/newBlocks";
import { Server, Tab } from "./browser-tab";

/**
 * Cmd+. as the browser sends it (Cmd on a Mac, Ctrl elsewhere). On a selection it opens the instruction input; this
 * then types `say` into it and presses Enter. Returns whether the key was taken.
 */
const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform); // read before the fake DOM replaces navigator, as Tiptap did
function pressCmdDot(tab: Tab, say = ""): boolean {
  const taken = !tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
  const field = document.querySelector<HTMLTextAreaElement>(".task-ask textarea");
  if (field) {
    field.value = say;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }
  return taken;
}

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

group("5.3 scenarios and §3.5–3.6", () => {
const PAGE = `# Release plan

The deadline is end of Q3 for all teams.

Budget approval comes from finance, and headcount comes from finance too.

| Team | Owner | Due |
| --- | --- | --- |
| Data | Priya | Q3 for the platform team |
| Web | Sam | Q4 for the web team |

\`\`\`ts
const due = "Q3";
ship(due);
\`\`\`

The last paragraph is here, and it says nothing much.`;

/** A page, a tab on it that has saved once (so the file is canonical), and a helper to run the job on it. */
async function setup() {
  const server = new Server(PAGE);
  const tab = new Tab(server.src);
  await tab.save(server);
  const job = (...quotes: string[]) => server.job(server.markdown, quotes.map((quote) => ({ quote })));
  return { server, tab, job };
}

group("5.3 scenarios", () => {
  test("1. typing and saving; the SSE echo of its own save is ignored", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " More words.");
    const r = await tab.save(server);
    expect(r.ok).toBe(true);
    expect(server.markdown).toContain("nothing much. More words.");
    expect(tab.receive(server.src)).toBe("stale");
  });

  test("2. the job adds a comment while the writer is idle: it appears on the right text", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    expect(tab.receive(server.src)).toBe("applied");
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
    expect(server.markdown).not.toContain("<!--"); // the body never carries comments
  });

  test("3. a comment lands while the writer types elsewhere: placed at once, caret untouched", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("nothing much.", " Typing here");
    const caret = tab.state.selection.head;
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
    expect(tab.state.selection.head).toBe(caret);
  });

  test("4. a comment in the paragraph being typed waits for the pause", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("for all teams", " And more");
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBeNull();
    expect(tab.deferred).toEqual([id!]);
    tab.pause();
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });

  test("5. the job read old text; the writer has since deleted the sentence: comment never created", async () => {
    const { server, tab } = await setup();
    const readByJob = server.markdown;
    tab.remove("Budget approval comes from finance, and headcount comes from finance too.");
    await tab.save(server);
    const r = server.job(readByJob, [{ quote: "Budget approval comes from finance" }]);
    expect(r.placed).toEqual([]);
    expect(r.dropped).toEqual([{ quote: "Budget approval comes from finance", reason: "gone" }]);
  });

  test("6. the job writes while a save is in flight: the server leaves it alone, the tab places it", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("nothing much.", " Edit.");
    const inFlight = tab.makePut(); // sent before the job's write
    const { placed: [id] } = job("end of Q3 for all teams");
    const r = server.put(inFlight);
    expect(r.ok).toBe(true);
    expect(server.comment(id!).status).toBe("open"); // not in the request: untouched
    tab.onPutResult(r);
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });

  test("6b. same race, but the writer deleted the passage meanwhile: the tab orphans it, the server stores that", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams"); // placed on the latest file, which still has it
    tab.remove("The deadline is end of Q3 for all teams.");
    tab.onPutResult(server.put(tab.makePut()));
    expect(tab.highlighted(id!)).toBeNull();
    expect(server.comment(id!).status).toBe("open"); // server hasn't been told yet
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("8–9. deleting a highlighted passage orphans it; Undo brings it back", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("Budget approval comes from finance");
    tab.receive(server.src);
    tab.remove("Budget approval comes from finance, and headcount comes from finance too.");
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    tab.undo();
    expect(tab.highlighted(id!)).toBe("Budget approval comes from finance");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("open");
  });

  test("Undo after a comment appeared undoes the writer's edit, not the comment", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("nothing much.", " Oops.");
    tab.pause();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.undo();
    expect(tab.markdown).not.toContain("Oops.");
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });

  test("the tab's own state wins: a comment it orphaned isn't re-attached by an older file still saying open", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("Budget approval comes from finance");
    tab.receive(server.src);
    tab.remove("Budget approval comes from finance");
    tab.typeBefore(", and headcount", "Budget approval comes from finance"); // retyped by hand, not Undo
    job("The last paragraph is here"); // a new file arrives; it still says the first comment is open
    tab.receive(server.src);
    tab.pause();
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("10. editing inside a highlight: it follows the text, the server stores the new passage", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.replace("Q3", "Q4");
    expect(tab.highlighted(id!)).toBe("end of Q4 for all teams");
    await tab.save(server);
    expect(server.comment(id!).anchor.exact).toBe("end of Q4 for all teams");
  });

  test("11. copy-pasting a highlighted passage doesn't duplicate the comment", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.copyPaste("end of Q3 for all teams", "nothing much.");
    expect(tab.markdown).toContain("nothing much.end of Q3 for all teams");
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
    expect(tab.find("end of Q3 for all teams", 0).from).toBe(tab.find("end of Q3").from);
  });

  test("12. the same words twice: the comment lands on the one the model meant", async () => {
    const { server, tab } = await setup();
    // "comes from finance" is in the page twice; the model quotes the second with enough to be unique.
    const r = server.job(server.markdown, [{ quote: "headcount comes from finance too" }]);
    tab.receive(server.src);
    expect(tab.highlighted(r.placed[0]!)).toBe("headcount comes from finance too");
    // A bare quote that appears twice is refused rather than guessed.
    expect(server.job(server.markdown, [{ quote: "comes from finance" }]).dropped[0]!.reason).toBe("ambiguous");
  });

  test("13. missed files: the next one carries everything; an older one arriving late is ignored", async () => {
    const { server, tab, job } = await setup();
    const a = job("end of Q3 for all teams").placed[0]!;
    const older = server.src;
    const b = job("Budget approval comes from finance").placed[0]!;
    expect(tab.receive(server.src)).toBe("applied");
    expect(tab.receive(older)).toBe("stale");
    expect(Object.keys(tab.highlights).sort()).toEqual([a, b].sort());
  });

  test("14. a save that never arrived: the next one still works, and the job's comment survives", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("nothing much.", " First.");
    tab.makePut(); // lost
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.typeAfter("First.", " Second.");
    await tab.save(server);
    expect(server.markdown).toContain("First. Second.");
    expect(server.comment(id!).status).toBe("open");
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });

  test("14d. a highlight from plain text into bold changes nothing in the markdown, and a hand edit elsewhere merges", async () => {
    // Found by the property tests: the highlight split the bold, the page wrote `**budget** <strong>owner</strong>`,
    // and the next outside edit conflicted with a change the writer never made.
    const server = new Server("- Scope launch **budget owner**\n- Second item");
    const tab = new Tab(server.src);
    await tab.save(server);
    const before = tab.markdown;
    server.job(server.markdown, [{ quote: "Scope launch budget" }]);
    tab.receive(server.src);
    expect(tab.highlighted(Object.keys(server.block.comments)[0]!)).toBe("Scope launch budget");
    expect(tab.markdown).toBe(before);
    server.handEdit((md) => md.replace("Second item", "Second item, by hand"));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.markdown).toBe("- Scope launch **budget owner**\n- Second item, by hand");
  });

  test("14b. a save that never arrived, then a hand edit to the same sentence: the banner, and the typing kept", async () => {
    // Found by the browser smoke test: the lost save was taken as the base of the merge, which then said the writer
    // had changed nothing, and their version replaced the typing without a word.
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Mine.");
    tab.makePut(); // lost
    server.handEdit((md) => md.replace("nothing much.", "nothing much. Theirs."));
    expect(tab.receive(server.src)).toBe("conflict");
    expect(tab.markdown).toContain("nothing much. Mine.");
    expect(tab.markdown).not.toContain("Theirs.");
  });

  test("14c. a hand edit to the same sentence lands before the save that is out: the banner, then a 409, the typing kept", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Mine.");
    const req = tab.makePut();
    server.handEdit((md) => md.replace("nothing much.", "nothing much. Theirs."));
    expect(tab.receive(server.src)).toBe("conflict");
    tab.onPutResult(server.put(req));
    expect(tab.conflict).toBe(true);
    expect(tab.markdown).toContain("nothing much. Mine.");
    expect(tab.markdown).not.toContain("Theirs.");
  });

  test("17. two tabs: the stale one gets a 409, then reloads or keeps its own", async () => {
    const { server, tab: a } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("nothing much.", " From A.");
    await a.save(server);
    b.typeAfter("nothing much.", " From B.");
    const r = await b.save(server);
    expect(r.ok).toBe(false);
    expect(b.conflict).toBe(true);
    expect(server.markdown).toContain("From A.");
    await b.keepMine(server);
    expect(server.markdown).toContain("From B.");
    expect(server.markdown).not.toContain("From A.");
  });

  test("17b. a tab with no unsaved changes just reloads another tab's body", async () => {
    const { server, tab: a } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("nothing much.", " From A.");
    await a.save(server);
    expect(b.receive(server.src)).toBe("reloaded");
    expect(b.markdown).toContain("From A.");
  });

  test("18. a hand edit on disk: a clean tab reloads and re-anchors; a dirty one is stopped from overwriting it", async () => {
    const { server, tab, job } = await setup();
    const { placed: [kept, lost] } = job("end of Q3 for all teams", "Budget approval comes from finance");
    tab.receive(server.src);
    server.handEdit((md) => md.replace("Budget approval comes from finance, and headcount comes from finance too.", "Budget is TBD.").replace("# Release plan", "# Release plan\n\nAdded in vim."));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.highlighted(kept!)).toBe("end of Q3 for all teams");
    expect(tab.highlighted(lost!)).toBeNull();
    await tab.save(server);
    expect(server.comment(lost!).status).toBe("orphaned");

    const dirty = new Tab(server.src);
    dirty.typeAfter("nothing much.", " Unsaved.");
    server.handEdit((md) => `${md}\n\nAnother vim line.`);
    expect((await dirty.save(server)).ok).toBe(false);
    expect(server.markdown).toContain("Another vim line.");
  });

  test("22. the cap: extra comments are dropped", async () => {
    const { server, job } = await setup();
    const r = job(
      "end of Q3 for all teams", "Budget approval comes from finance", "headcount comes from finance too",
      "Q3 for the platform team", "Q4 for the web team", "The last paragraph is here",
    );
    expect(r.placed.length).toBe(4);
    expect(r.dropped.map((d) => d.reason)).toEqual(["cap-full", "cap-full"]);
  });

  test("the job won't overlap a live comment, and drops quotes the model got wrong", async () => {
    const { job } = await setup();
    job("end of Q3 for all teams");
    const r = job("The deadline is end of Q3", "deadline is at the end of the third quarter", "| Data | Priya |");
    expect(r.dropped.map((d) => d.reason)).toEqual(["overlaps", "not-in-read-text", "crosses-cells"]);
  });

  test("page reload: saved anchors put every highlight back exactly", async () => {
    const { server, tab, job } = await setup();
    job("end of Q3 for all teams", "Q3 for the platform team", 'const due = "Q3";');
    tab.receive(server.src);
    tab.paragraphBefore("The deadline", "A new opening paragraph.");
    await tab.save(server);
    const fresh = new Tab(server.src);
    expect(fresh.highlights).toEqual(tab.highlights);
  });
});

group("3.5 lines added above a comment", () => {
  test("on screen: the highlight moves with the text, and the save sends the new start", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("headcount comes from finance too");
    tab.receive(server.src);
    const before = server.comment(id!).anchor.start;
    tab.paragraphBefore("The deadline", "One new paragraph above.");
    tab.paragraphBefore("The deadline", "And a second one.");
    expect(tab.highlighted(id!)).toBe("headcount comes from finance too");
    await tab.save(server);
    expect(server.comment(id!).anchor.start).toBeGreaterThan(before);
  });

  test("not yet received: start is stale, but the comment is still found", async () => {
    const { server, tab } = await setup();
    const readByJob = server.markdown;
    tab.paragraphBefore("The deadline", "Inserted while the job was thinking, quite a long line of text.");
    await tab.save(server);
    const r = server.job(readByJob, [{ quote: "headcount comes from finance too" }]);
    tab.receive(server.src);
    expect(tab.highlighted(r.placed[0]!)).toBe("headcount comes from finance too");
  });

  test("not yet received, paragraph inserted directly before it: prefix broken, suffix finds it", async () => {
    const { server, tab } = await setup();
    const readByJob = server.markdown;
    tab.paragraphBefore("Budget approval", "Squeezed right in.");
    await tab.save(server);
    const r = server.job(readByJob, [{ quote: "Budget approval comes from finance" }]);
    tab.receive(server.src);
    expect(tab.highlighted(r.placed[0]!)).toBe("Budget approval comes from finance");
  });
});

group("3.6 tables and code", () => {
  test("a comment in a table cell survives edits in other cells, and is orphaned when its row is deleted", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("Q3 for the platform team");
    tab.receive(server.src);
    tab.typeAfter("Sam", " and Ana");
    expect(tab.highlighted(id!)).toBe("Q3 for the platform team");
    await tab.save(server);
    expect(server.markdown).toContain("Sam and Ana");
    tab.removeNodeAround("Priya", "tableRow");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("a comment across lines of a code block follows edits above it in the block", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job('const due = "Q3";\nship(due);');
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe('const due = "Q3";\nship(due);');
    tab.typeBefore('const due = "Q3";', "// plan\n");
    expect(tab.highlighted(id!)).toBe('const due = "Q3";\nship(due);');
    await tab.save(server);
    expect(server.markdown).toContain("// plan");
    expect(new Tab(server.src).highlighted(id!)).toBe('const due = "Q3";\nship(due);');
  });
});

});

group("edge cases", () => {
async function setup(page: string) {
  const server = new Server(page);
  const tab = new Tab(server.src);
  await tab.save(server);
  const job = (...quotes: string[]) => {
    const r = server.job(server.markdown, quotes.map((quote) => ({ quote })));
    tab.receive(server.src);
    return r;
  };
  const reload = () => new Tab(server.src);
  return { server, tab, job, reload };
}

const TABLE = `# Plan

| Team | Owner | Due |
| --- | --- | --- |
| Data | Priya | Q3 for the platform team |
| Web | Sam | Q4 for the web team |

After the table, a closing paragraph.`;

group("tables", () => {
  test("a row added above the commented one: comment stays, survives reload", async () => {
    const { server, tab, job, reload } = await setup(TABLE);
    const { placed: [id] } = job("Q3 for the platform team");
    tab.command("Priya", addRowBefore);
    expect(tab.highlighted(id!)).toBe("Q3 for the platform team");
    await tab.save(server);
    expect(server.markdown.split("\n").filter((l) => l.startsWith("|")).length).toBe(5);
    expect(reload().highlighted(id!)).toBe("Q3 for the platform team");
  });

  test("a column added before the commented one: comment stays, survives reload", async () => {
    const { server, tab, job, reload } = await setup(TABLE);
    const { placed: [id] } = job("Q3 for the platform team");
    tab.command("Q3 for the platform", addColumnBefore);
    expect(tab.highlighted(id!)).toBe("Q3 for the platform team");
    await tab.save(server);
    expect(reload().highlighted(id!)).toBe("Q3 for the platform team");
  });

  test("the commented column deleted: orphaned; another column deleted: kept", async () => {
    const { server, tab, job } = await setup(TABLE);
    const { placed: [due, sam] } = job("Q3 for the platform team", "Q4 for the web team");
    tab.command("Owner", deleteColumn);
    expect(tab.highlighted(due!)).toBe("Q3 for the platform team");
    tab.command("Q4 for the web", deleteColumn);
    await tab.save(server);
    expect(server.comment(due!).status).toBe("orphaned");
    expect(server.comment(sam!).status).toBe("orphaned");
  });

  test("the commented row deleted with the table command: orphaned; Undo brings it back", async () => {
    const { server, tab, job } = await setup(TABLE);
    const { placed: [id] } = job("Q3 for the platform team");
    tab.command("Priya", deleteRow);
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    tab.undo();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("open");
  });

  test("a whole row or column can't be commented on: such quotes are dropped", async () => {
    const { job } = await setup(TABLE);
    const r = job("Data Priya Q3 for the platform team", "| Data | Priya | Q3 |", "Owner Priya Sam");
    expect(r.dropped.map((d) => d.reason)).toEqual(["not-in-read-text", "crosses-cells", "not-in-read-text"]);
  });

  test("a header cell can be commented on", async () => {
    const page = TABLE.replace("| Team | Owner | Due |", "| Team name here | Owner | Due |");
    const { job, reload } = await setup(page);
    const { placed: [id] } = job("Team name here");
    expect(reload().highlighted(id!)).toBe("Team name here");
  });

  test("the same text in two cells: context picks the right cell", async () => {
    const page = TABLE.replace("| Web | Sam | Q4 for the web team |", "| Web | Sam | Q3 for the platform team |");
    const { server, tab } = await setup(page);
    const read = server.markdown;
    const r = server.job(read, [{ quote: "Q3 for the platform team" }]);
    expect(r.dropped[0]!.reason).toBe("ambiguous"); // a bare quote in two cells is refused
    tab.receive(server.src);
  });
});

const IMAGES = `# Pics

Intro ![a chart](chart.png "Chart") then the text about the chart follows.

![Standalone photo](photo.jpg)

A paragraph after the photo, with more words in it.`;

group("images", () => {
  test("images survive load and save, inline and on their own line", async () => {
    const { server, tab } = await setup(IMAGES);
    tab.typeAfter("more words in it.", " Edited.");
    await tab.save(server);
    expect(server.markdown).toContain('![a chart](chart.png "Chart")');
    expect(server.markdown).toContain("![Standalone photo](photo.jpg)");
  });

  test("a comment right after an inline image is placed and reloaded exactly", async () => {
    const { job, reload } = await setup(IMAGES);
    const { placed: [id] } = job("then the text about the chart");
    expect(reload().highlighted(id!)).toBe("then the text about the chart");
  });

  test("an image's alt text can't be quoted (images have no text yet)", async () => {
    const { job } = await setup(IMAGES);
    expect(job("Standalone photo and more").dropped[0]!.reason).toBe("not-in-read-text");
  });

  test("deleting an image doesn't disturb a comment next to it", async () => {
    const { server, tab, job, reload } = await setup(IMAGES);
    const { placed: [id] } = job("then the text about the chart");
    let image = -1;
    tab.doc.descendants((n, pos) => { if (n.type.name === "image" && image < 0) image = pos; });
    tab.dispatch(tab.state.tr.delete(image, image + 1));
    await tab.save(server);
    expect(server.markdown).not.toContain("chart.png");
    expect(reload().highlighted(id!)).toBe("then the text about the chart");
  });
});

const PROSE = `# Notes

First paragraph has a claim that the launch slips to May, and a second point after it.

Second paragraph talks about budget approval from finance and the hiring freeze.

Third paragraph is a quiet one with no real claims in it at all.`;

group("content deletion", () => {
  test("deleting part of a highlight shrinks it; the save stores the shorter passage", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    tab.remove(" slips");
    expect(tab.highlighted(id!)).toBe("the launch to May");
    await tab.save(server);
    expect(server.comment(id!).anchor.exact).toBe("the launch to May");
  });

  test("one deletion across two comments shrinks both", async () => {
    const { tab, job } = await setup(PROSE);
    const { placed: [a, b] } = job("the launch slips to May", "a second point after it");
    tab.remove("May, and a second");
    expect(tab.highlighted(a!)).toBe("the launch slips to ");
    expect(tab.highlighted(b!)).toBe(" point after it");
  });

  test("deleting a whole paragraph with two comments orphans both", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed: [a, b] } = job("the launch slips to May", "a second point after it");
    tab.remove("First paragraph has a claim that the launch slips to May, and a second point after it.");
    await tab.save(server);
    expect([server.comment(a!).status, server.comment(b!).status]).toEqual(["orphaned", "orphaned"]);
  });

  test("select all + delete orphans everything; Undo brings it all back", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed } = job("the launch slips to May", "budget approval from finance", "a quiet one with no real claims");
    tab.selectAllDelete();
    await tab.save(server);
    expect(placed.map((id) => server.comment(id).status)).toEqual(["orphaned", "orphaned", "orphaned"]);
    tab.undo();
    await tab.save(server);
    expect(placed.map((id) => server.comment(id).status)).toEqual(["open", "open", "open"]);
  });

  test("a dismissed comment loses its highlight, and the job doesn't raise it again", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    server.dismiss(id!);
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBeNull();
    expect(job("claim that the launch slips to May").dropped[0]!.reason).toBe("already-raised");
  });

  test("an orphaned comment's exact passage, retyped, is not raised again", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed: [id] } = job("budget approval from finance");
    tab.remove("budget approval from finance and ");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    tab.typeBefore("the hiring freeze", "budget approval from finance and ");
    await tab.save(server);
    expect(job("budget approval from finance").dropped[0]!.reason).toBe("already-raised");
  });
});

group("duplicates", () => {
  test("the model proposes the same quote twice in one run: the second overlaps", async () => {
    const { job } = await setup(PROSE);
    const r = job("the launch slips to May", "the launch slips to May");
    expect(r.placed.length).toBe(1);
    expect(r.dropped[0]!.reason).toBe("overlaps");
  });

  test("a copied highlight doesn't take the comment; deleting the original orphans it", async () => {
    const { server, tab, job } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    tab.copyPaste("the launch slips to May", "no real claims in it at all.");
    tab.remove("First paragraph has a claim that the launch slips to May, and a second point after it.");
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("a cut highlight takes its comment with it", async () => {
    const { server, tab, job, reload } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    tab.cutPaste("the launch slips to May", "no real claims in it at all.");
    expect(tab.highlighted(id!)).toBe("the launch slips to May");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("open");
    expect(reload().highlighted(id!)).toBe("the launch slips to May");
  });

  test("a duplicated paragraph: the comment stays on the original, also after reload", async () => {
    const { server, tab, job, reload } = await setup(PROSE);
    const { placed: [id] } = job("budget approval from finance");
    const para = "Second paragraph talks about budget approval from finance and the hiring freeze.";
    tab.copyPaste(para, "no real claims in it at all.");
    await tab.save(server);
    const fresh = reload();
    expect(fresh.highlighted(id!)).toBe("budget approval from finance");
    expect(fresh.find("budget approval from finance", 0).from).toBe(fresh.find("Second paragraph").from + "Second paragraph talks about ".length);
  });
});

group("splitting and joining blocks", () => {
  test("Enter inside a highlight: the first part keeps it, the file and a reload agree", async () => {
    const { server, tab, job, reload } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    tab.enterBefore("to May");
    expect(tab.highlighted(id!)).toBe("the launch slips ");
    expect(tab.allMarked(id!)).toEqual(["the launch slips "]); // nothing left highlighted in the new paragraph
    await tab.save(server);
    expect(server.comment(id!).anchor.exact).toBe("the launch slips");
    expect(reload().highlighted(id!)).toBe("the launch slips");
  });

  test("Undo of that Enter restores the whole highlight", async () => {
    const { tab, job } = await setup(PROSE);
    const { placed: [id] } = job("the launch slips to May");
    tab.enterBefore("to May");
    tab.undo();
    expect(tab.highlighted(id!)).toBe("the launch slips to May");
  });

  test("joining two paragraphs (Backspace) keeps both comments", async () => {
    const { server, tab, job, reload } = await setup(PROSE);
    const { placed: [a, b] } = job("a second point after it", "budget approval from finance");
    tab.command("Second paragraph", joinBackward);
    expect(tab.markdown).toContain("after it.Second paragraph");
    await tab.save(server);
    const fresh = reload();
    expect([fresh.highlighted(a!), fresh.highlighted(b!)]).toEqual(["a second point after it", "budget approval from finance"]);
  });
});

const BLOCKS = `# A heading worth commenting on

- A bullet item with a claim in it
  - A nested bullet with another claim
- [ ] A task item that is still open

1. An ordered item with a number

> A quoted line from someone important.

Line one of a paragraph  
line two after a hard break.`;

group("every block type", () => {
  for (const [kind, quote, shown] of [
    ["heading", "A heading worth commenting", "A heading worth commenting"],
    ["bullet", "bullet item with a claim", "bullet item with a claim"],
    ["nested bullet", "nested bullet with another claim", "nested bullet with another claim"],
    ["task", "task item that is still open", "task item that is still open"],
    ["ordered item", "ordered item with a number", "ordered item with a number"],
    ["blockquote", "quoted line from someone", "quoted line from someone"],
    ["hard break", "of a paragraph line two", "of a paragraph\nline two"],
  ] as const) {
    test(`a comment in a ${kind} is placed and reloads exactly`, async () => {
      const { job, reload } = await setup(BLOCKS);
      const r = job(quote);
      expect(r.dropped).toEqual([]);
      expect(reload().highlighted(r.placed[0]!)).toBe(shown);
    });
  }

  test("ticking a task keeps its comment", async () => {
    const { server, tab, job } = await setup(BLOCKS);
    const { placed: [id] } = job("task item that is still open");
    const $pos = tab.doc.resolve(tab.find("task item").from);
    let at = -1;
    for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type.name === "taskItem") at = $pos.before(d);
    tab.dispatch(tab.state.tr.setNodeAttribute(at, "checked", true));
    await tab.save(server);
    expect(server.markdown).toContain("- [x] A task item");
    expect(tab.highlighted(id!)).toBe("task item that is still open");
  });
});

group("awkward text", () => {
  test("emoji before a comment: offsets still line up", async () => {
    const { job, reload } = await setup("# E\n\n🎉🎉 Party time: the launch slips to May 🚀 for sure.");
    const { placed: [id] } = job("the launch slips to May");
    expect(reload().highlighted(id!)).toBe("the launch slips to May");
  });

  test("markdown characters in the text, quoted with or without escapes", async () => {
    const { job } = await setup("# M\n\nThe formula 5 \\* 3 = 15 is wrong, says the reviewer.");
    expect(job("formula 5 \\* 3 = 15 is wrong").placed.length).toBe(1);
    expect(job("5 * 3 = 15 is wrong, says").dropped[0]!.reason).toBe("overlaps"); // same passage, found unescaped too
  });

  test("a comment on link text", async () => {
    const { job, reload } = await setup("# L\n\nRead [the launch checklist](https://x.y/c) before Friday, please.");
    const { placed: [id] } = job("the launch checklist before Friday");
    expect(reload().highlighted(id!)).toBe("the launch checklist before Friday");
  });

  test("a quote in the wrong case or with an ellipsis is dropped, not guessed", async () => {
    const { job } = await setup(PROSE);
    expect(job("THE LAUNCH SLIPS TO MAY", "the launch … to May").dropped.map((d) => d.reason)).toEqual(["not-in-read-text", "not-in-read-text"]);
  });

  test("an empty page: nothing to comment on", async () => {
    const { job } = await setup("");
    expect(job("anything at all here").placed).toEqual([]);
  });
});

const PICS = `# Pics

Intro ![a chart](chart.png "Chart") then the text about the chart follows.

![Standalone photo](photo.jpg)

A paragraph between the photos, with more words in it.

![Standalone photo](photo.jpg)

- A list item with ![an icon](icon.svg) inside it

| Screen | Shot |
| --- | --- |
| Home | ![home screen](home.png) |

The end of the page.`;

group("comments on images", () => {
  test("the model quotes an image on its own line: the image itself is highlighted, and reloads", async () => {
    const { server, job, reload } = await setup(PICS);
    const r = job("![Standalone photo](photo.jpg) A paragraph"); // two blocks: not allowed
    expect(r.placed).toEqual([]);
    const { placed: [id] } = job("Intro ![a chart](chart.png)");
    expect(reload().allMarked(id!)).toEqual(["Intro ", "[img:chart.png]"]);
    expect(server.comment(id!).anchor.images).toEqual(["chart.png"]);
  });

  test("an image alone, in a list item and in a table cell", async () => {
    const { job, reload } = await setup(PICS);
    const { placed: [icon, home] } = job("![an icon](icon.svg)", "![home screen](home.png)");
    const fresh = reload();
    expect(fresh.allMarked(icon!)).toEqual(["[img:icon.svg]"]);
    expect(fresh.allMarked(home!)).toEqual(["[img:home.png]"]);
  });

  test("the comment mark on an image writes nothing to the markdown", async () => {
    const { server, tab, job } = await setup(PICS);
    const before = server.markdown;
    job("![an icon](icon.svg)");
    tab.typeAfter("The end of the page.", "");
    await tab.save(server);
    expect(server.markdown).toBe(before);
  });

  test("the same image twice: a bare quote is refused, one with neighbouring text lands on the right copy", async () => {
    const { job, reload } = await setup(PICS);
    expect(job("![Standalone photo](photo.jpg)").dropped[0]!.reason).toBe("ambiguous");
    // The second photo sits on its own line too; only the surroundings differ. The model can't quote across blocks,
    // so an image alone on a line that appears twice can't be told apart by the model yet.
    const page = PICS.replace("A paragraph between the photos, with more words in it.\n\n![Standalone photo](photo.jpg)", "A paragraph between the photos ![Standalone photo](photo.jpg) with words.");
    const second = await setup(page);
    const { placed: [id] } = second.job("between the photos ![Standalone photo](photo.jpg)");
    const fresh = second.reload();
    expect(fresh.allMarked(id!)).toEqual(["between the photos ", "[img:photo.jpg]"]);
    expect(fresh.highlighted(id!)).toBe("between the photos [img:photo.jpg]");
  });

  test("two images with the same surroundings but different files are told apart by src", async () => {
    const page = "# P\n\nSee ![x](a.png) here.\n\nSee ![x](b.png) here.";
    const { job, reload } = await setup(page);
    const { placed: [id] } = job("![x](b.png)");
    const fresh = reload();
    expect(fresh.allMarked(id!)).toEqual(["[img:b.png]"]);
    expect(fresh.doc.nodeAt(fresh.imagePos("b.png"))!.marks.length).toBe(1);
    expect(fresh.doc.nodeAt(fresh.imagePos("a.png"))!.marks.length).toBe(0);
  });

  test("text and lines added before a commented image: the comment stays", async () => {
    const { server, tab, job, reload } = await setup(PICS);
    const { placed: [id] } = job("![an icon](icon.svg)");
    tab.paragraphBefore("Intro", "A brand new opening paragraph.");
    tab.typeBefore("A list item", "Edited: ");
    await tab.save(server);
    expect(reload().allMarked(id!)).toEqual(["[img:icon.svg]"]);
  });

  test("deleting a commented image orphans the comment; Undo brings it back", async () => {
    const { server, tab, job } = await setup(PICS);
    const { placed: [id] } = job("![home screen](home.png)");
    tab.removeImage("home.png");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    tab.undo();
    expect(tab.allMarked(id!)).toEqual(["[img:home.png]"]);
    await tab.save(server);
    expect(server.comment(id!).status).toBe("open");
  });

  test("an image swapped for another file (hand edit): the comment is orphaned, not moved to the new image", async () => {
    const { server, tab, job } = await setup(PICS);
    const { placed: [id] } = job("![home screen](home.png)");
    server.handEdit((md) => md.replace("home.png", "home-v2.png"));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.allMarked(id!)).toEqual([]);
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("an image swapped before the tab ever saw the comment: not found, orphaned", async () => {
    const { server, tab } = await setup(PICS);
    const read = server.markdown;
    tab.removeImage("icon.svg");
    tab.insertImage("A list item with ", "icon-new.svg");
    await tab.save(server);
    const r = server.job(read, [{ quote: "![an icon](icon.svg)" }]);
    expect(r.dropped[0]!.reason).toBe("gone");
  });

  test("a cut image takes its comment; a copied one doesn't", async () => {
    const { server, tab, job, reload } = await setup(PICS);
    const { placed: [chart, icon] } = job("![a chart](chart.png)", "![an icon](icon.svg)");
    tab.pasteImage("icon.svg", "The end of the page.", false); // copy
    expect(tab.allMarked(icon!)).toEqual(["[img:icon.svg]"]);
    tab.pasteImage("chart.png", "The end of the page.", true); // cut
    await tab.save(server);
    const fresh = reload();
    expect(fresh.allMarked(chart!)).toEqual(["[img:chart.png]"]);
    expect(fresh.imagePos("chart.png")).toBeGreaterThan(fresh.find("The end of the page").from);
    expect(fresh.allMarked(icon!)).toEqual(["[img:icon.svg]"]);
    expect(fresh.imagePos("icon.svg", 0)).toBeLessThan(fresh.find("The end of the page").from); // still the original
  });

  test("an image copied into its own paragraph: only the original keeps the comment", async () => {
    const { tab, job } = await setup(PICS);
    const { placed: [icon] } = job("![an icon](icon.svg)");
    tab.pasteImage("icon.svg", "A list item with ", false); // the copy lands just before the original
    const [copy, original] = [tab.imagePos("icon.svg", 0), tab.imagePos("icon.svg", 1)];
    expect(tab.doc.nodeAt(copy)!.marks.length).toBe(0);
    expect(tab.doc.nodeAt(original)!.marks.length).toBe(1);
  });

  test("Enter inside a highlight covering text and an image: the first block keeps it", async () => {
    const { server, tab, job, reload } = await setup(PICS);
    const { placed: [id] } = job("Intro ![a chart](chart.png) then the text");
    tab.enterBefore("then the text");
    expect(tab.allMarked(id!)).toEqual(["Intro ", "[img:chart.png]", " "]); // the space before the split stays too
    await tab.save(server);
    expect(reload().allMarked(id!)).toEqual(["Intro ", "[img:chart.png]"]);
  });

  test("a dismissed image comment isn't raised again", async () => {
    const { server, tab, job } = await setup(PICS);
    const { placed: [id] } = job("![home screen](home.png)");
    server.dismiss(id!);
    tab.receive(server.src);
    expect(tab.allMarked(id!)).toEqual([]);
    expect(job("![home screen](home.png)").dropped[0]!.reason).toBe("already-raised");
  });
});

});

group("corners", () => {
const PAGE = `# Plan

The deadline is end of Q3 for all teams.

Budget approval comes from finance, and headcount comes from finance too.

The last paragraph is here, and it says nothing much.`;

async function setup() {
  const server = new Server(PAGE);
  const tab = new Tab(server.src);
  await tab.save(server);
  const job = (...quotes: string[]) => server.job(server.markdown, quotes.map((quote) => ({ quote })));
  return { server, tab, job };
}

/** Rewrites the comments block by hand, as a person editing the file would (a new rev, body untouched). */
function editBlock(server: Server, edit: (b: ReturnType<typeof parseFile>["block"]) => ReturnType<typeof parseFile>["block"]) {
  const { markdown, block } = parseFile(server.src);
  const next = edit(block);
  server.src = serializeFile(markdown, { ...next, meta: { ...next.meta, rev: next.meta.rev + 1 } });
}

group("statuses the tab doesn't own", () => {
  test("a dismissed comment stays dismissed through the tab's next save", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    server.dismiss(id!);
    tab.receive(server.src);
    tab.typeAfter("nothing much.", " More.");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("dismissed");
  });

  test("a PUT naming an unknown comment id is ignored; one that omits a comment leaves it byte-identical", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    const before = JSON.stringify(server.comment(id!));
    const req = tab.makePut();
    req.comments["ghost"] = { status: "orphaned" };
    expect(server.put(req).ok).toBe(true);
    expect(server.block.comments["ghost"]).toBeUndefined();
    expect(JSON.stringify(server.comment(id!))).toBe(before);
  });
});

group("comments that vanish from the file", () => {
  test("a comment deleted from the block by hand loses its highlight and is not resurrected by a save", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    expect(tab.highlighted(id!)).not.toBeNull();
    editBlock(server, (b) => deleteComment(b, id!));
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBeNull();
    tab.typeAfter("nothing much.", " More.");
    await tab.save(server);
    expect(server.block.comments[id!]).toBeUndefined();
  });

  test("a comment's hand-edited anchor is trusted by the server, and the tab re-finds it by its own marks", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.typeAfter("nothing much.", " More.");
    await tab.save(server);
    expect(server.comment(id!).anchor.exact).toBe("end of Q3 for all teams");
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });
});

group("orphans and the disk", () => {
  test("an orphaned comment stays orphaned when a hand edit brings its passage back (kept for History)", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.remove("end of Q3 for all teams");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    server.handEdit((md) => md.replace("The deadline is ", "The deadline is end of Q3 for all teams"));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("a hand edit with no change to the text a comment sits on keeps it", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    server.handEdit((md) => `${md}\n\nAppended in vim.`);
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
  });
});

group("deferred placement", () => {
  test("a comment waiting for the pause is orphaned if the writer deletes its block first", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("for all teams.", "!"); // caret in that block
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    expect(tab.deferred).toContain(id!);
    tab.remove("The deadline is end of Q3 for all teams.");
    tab.pause();
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("a comment waiting for the pause is not in the save sent before it is placed", async () => {
    const { server, tab, job } = await setup();
    tab.typeAfter("for all teams.", "!");
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    const req = tab.makePut();
    expect(req.comments[id!]).toBeUndefined();
  });
});

group("conflicts, retries and races", () => {
  test("a job writes during a conflict: the tab still shows the comment, and Keep mine keeps it", async () => {
    const { server, tab: a, job } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("nothing much.", " From A.");
    await a.save(server);
    b.typeAfter("here, and", " (B)");
    expect((await b.save(server)).ok).toBe(false);
    const { placed: [id] } = job("end of Q3 for all teams");
    b.receive(server.src);
    expect(b.conflict).toBe(true);
    expect(b.highlighted(id!)).toBe("end of Q3 for all teams");
    await b.keepMine(server);
    expect(server.comment(id!).status).toBe("open");
    expect(server.markdown).toContain("(B)");
    expect(server.markdown).not.toContain("From A.");
  });

  test("Reload after a conflict discards the tab's edits and lets it save again", async () => {
    const { server, tab: a } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("nothing much.", " From A.");
    await a.save(server);
    b.typeAfter("here, and", " (B)");
    expect((await b.save(server)).ok).toBe(false);
    b.load(server.src);
    expect(b.markdown).toContain("From A.");
    expect(b.markdown).not.toContain("(B)");
    b.typeAfter("From A.", " More.");
    expect((await b.save(server)).ok).toBe(true);
  });

  test("the same save sent twice (the response was lost) is accepted both times and changes nothing", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Retry me.");
    const req = tab.makePut();
    const first = server.put(req);
    const second = server.put(req);
    expect(first.ok && second.ok).toBe(true);
    expect(server.markdown).toBe(tab.markdown);
  });

  test("a save with an old base_rev from the tab that wrote the body is accepted (the job wrote in between)", async () => {
    const { server, tab, job } = await setup();
    const stale = tab.lastRev;
    job("end of Q3 for all teams");
    tab.typeAfter("nothing much.", " More.");
    const req = tab.makePut();
    req.base_rev = stale;
    expect(server.put(req).ok).toBe(true);
  });

  test("a file older than the one already applied is ignored, even right after a reload", async () => {
    const { server, tab } = await setup();
    const old = server.src;
    tab.typeAfter("nothing much.", " One.");
    await tab.save(server);
    tab.load(server.src);
    expect(tab.receive(old)).toBe("stale");
    expect(tab.markdown).toContain("One.");
  });

  test("a clean tab sees another tab's deletion of a commented passage: body reloads, the note is gone", async () => {
    const { server, tab: a, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    const b = new Tab(server.src);
    a.receive(server.src);
    a.remove("end of Q3 for all teams");
    await a.save(server);
    expect(b.receive(server.src)).toBe("reloaded");
    expect(b.highlighted(id!)).toBeNull();
    expect(server.comment(id!).status).toBe("orphaned");
  });
});

group("whole-page extremes", () => {
  test("an emptied page saves as an empty body with every comment orphaned, and loads again", async () => {
    const { server, tab, job } = await setup();
    const { placed } = job("end of Q3 for all teams", "Budget approval comes from finance");
    tab.receive(server.src);
    tab.selectAllDelete();
    await tab.save(server);
    expect(server.markdown).toBe("");
    for (const id of placed) expect(server.comment(id).status).toBe("orphaned");
    const fresh = new Tab(server.src);
    expect(fresh.highlights).toEqual({});
    expect((await fresh.save(server)).ok).toBe(true);
  });

  test("a brand-new empty file gets a first save and a first comment", async () => {
    const server = new Server("");
    const tab = new Tab(server.src);
    expect((await tab.save(server)).ok).toBe(true);
    tab.dispatch(tab.state.tr.insertText("Hello there, this is a page."));
    await tab.save(server);
    const r = server.job(server.markdown, [{ quote: "this is a page" }]);
    expect(r.placed).toHaveLength(1);
    expect(server.markdown).toBe("Hello there, this is a page.");
    expect(parseFile(serializeFile("x", emptyBlock())).block.meta.rev).toBe(0);
  });
});

group("a person edits the .md file by hand", () => {
  const entry = (exact: string, start: number) => ({
    id: "hand01", status: "open" as const, thinker: "me", title: "By hand", body: "typed in vim", anchor: { exact, prefix: "", suffix: "", start },
    created: "2026-10-21T00:00:00.000Z", created_rev: 1,
  });

  /** Splices a comment into the file's block text, the way someone editing the JSON would. */
  const addByHand = (src: string) => {
    const block = parseFile(src).block;
    const edited = { ...block, comments: { ...block.comments, hand01: entry("end of Q3 for all teams", 17) } };
    return serializeFile(parseFile(src).markdown, edited);
  };

  test("a comment added to the block: the page keeps all its text and shows the new highlight", async () => {
    const { server, tab } = await setup();
    const before = tab.markdown;
    server.src = addByHand(server.src); // no rev bump: a raw edit
    server.handEdit((md) => md); // the watcher's bookkeeping for an unknown hash
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.markdown).toBe(before);
    expect(tab.highlighted("hand01")).toBe("end of Q3 for all teams");
  });

  test("the same edit while the tab has unsaved typing: merged, nothing wiped, and the next save keeps both", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("Plan", " (draft)");
    server.src = addByHand(server.src);
    server.handEdit((md) => md);
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toContain("(draft)");
    expect(tab.markdown).toContain("The deadline");
    expect(tab.highlighted("hand01")).toBe("end of Q3 for all teams");
    expect(tab.dirty).toBe(true);
    expect((await tab.save(server)).ok).toBe(true);
    expect(server.markdown).toContain("(draft)");
  });

  test("a hand edit that empties the body wipes the page only when the file really is empty", async () => {
    const { server, tab } = await setup();
    server.handEdit(() => "");
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.markdown).toBe("");
  });
});

});

group("what only the browser code can get wrong", () => {
  const PAGE = "# Plan\n\nThe deadline is end of Q3 for all teams.\n\nThe last paragraph is here.";
  const withBlock = (md: string, rev: number, body_rev: number, body_by: string | null, comments: object = {}) =>
    `${md}\n\n<!-- solip-comments\n${JSON.stringify({ meta: { rev, body_rev, body_by }, comments }, null, 2)}\n-->\n`;
  const note = (id: string) => ({
    [id]: { id, status: "open", thinker: "me", title: "By hand", anchor: { exact: "end of Q3", prefix: "The deadline is ", suffix: " for all teams.", start: 20 }, created: "x", created_rev: 2 },
  });

  const BODY = "# Release plan\n\nThe deadline is end of Q3 for all teams.\n\nBudget approval comes from finance, and headcount comes from finance too.\n\nThe last paragraph is here, and it says nothing much.";
  async function setup() {
    const server = new Server(BODY);
    const tab = new Tab(server.src);
    await tab.save(server);
    const job = (...quotes: string[]) => server.job(server.markdown, quotes.map((quote) => ({ quote })));
    return { server, tab, job };
  }

  test("a hand edit that adds a comment reloads the body without wiping it", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.receive(withBlock(PAGE, 2, 2, "disk", note("hand01")));
    expect(tab.markdown).toBe(PAGE);
    expect(tab.highlighted("hand01")).toBe("end of Q3");
    expect(tab.session.getSnapshot().comments).toHaveLength(1);
  });

  test("a hand edit that changes the body shows the new text", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    expect(tab.receive(withBlock(`${PAGE}\n\nAdded in vim.`, 2, 2, "disk"))).toBe("reloaded");
    expect(tab.markdown).toContain("Added in vim.");
    expect(tab.markdown).toContain("The deadline");
  });

  test("a hand edit next to the writer's unsaved typing is merged: both kept, and the page is saved again", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.typeAfter("is here.", " Typing.");
    expect(tab.session.getSnapshot().save).toBe("dirty");
    expect(tab.receive(withBlock(`${PAGE}\n\nAdded in vim.`, 2, 2, "disk"))).toBe("merged");
    expect(tab.session.getSnapshot().conflict).toBe(false);
    expect(tab.session.getSnapshot().save).toBe("dirty");
    expect(tab.markdown).toContain("Typing.");
    expect(tab.markdown).toContain("Added in vim.");
  });

  test("a hand edit to the very sentence the writer is typing in raises the conflict banner and keeps the typing", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.typeAfter("is here.", " Typing.");
    expect(tab.receive(withBlock(PAGE.replace("is here.", "is here. Theirs."), 2, 2, "disk"))).toBe("conflict");
    expect(tab.session.getSnapshot().conflict).toBe(true);
    expect(tab.markdown).toContain("Typing.");
    expect(tab.markdown).not.toContain("Theirs.");
  });

  test("a later hand edit that undoes the clash ends the conflict, and the page saves again", async () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.typeAfter("is here.", " Typing.");
    expect(tab.receive(withBlock(PAGE.replace("is here.", "is here. Theirs."), 2, 2, "disk"))).toBe("conflict");
    expect(tab.receive(withBlock(`${PAGE}\n\nAdded in vim.`, 3, 3, "disk"))).toBe("merged");
    expect(tab.session.getSnapshot()).toMatchObject({ conflict: false, save: "dirty" });
    expect(tab.markdown).toBe(`${PAGE.replace("is here.", "is here. Typing.")}\n\nAdded in vim.`);
  });

  test("a comment landing from the job highlights its passage and does not mark the page as edited", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.receive(withBlock(PAGE, 2, 1, "t_a", note("j1")));
    expect(tab.highlighted("j1")).toBe("end of Q3");
    expect(tab.session.getSnapshot().save).toBe("saved");
  });

  test("the snapshot the page renders from lists a comment only once its highlight exists", () => {
    const tab = new Tab(withBlock(PAGE, 1, 1, "t_a"));
    tab.receive(withBlock(PAGE, 2, 1, "t_a", note("j1")));
    expect(tab.session.getSnapshot().comments.map((c) => c.id)).toEqual(["j1"]);
    expect(tab.editor.view.dom.querySelector('[data-comment="j1"]')?.textContent).toBe("end of Q3");
  });

  test("placeholder text is never part of the page or the file", async () => {
    const server = new Server("");
    const tab = new Tab(server.src);
    expect(tab.editor.view.dom.innerHTML).toContain("data-placeholder");
    await tab.save(server);
    expect(server.src).not.toContain("Write normally");
    expect(server.src).not.toContain("Untitled");
    expect(tab.editor.getText()).toBe("");
  });

  test("typing in one paragraph while a line is appended to the file: merged, then saved with both", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("Budget approval comes from finance", " (typed)");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.session.getSnapshot().conflict).toBe(false);
    expect(tab.markdown).toContain("(typed)");
    expect(tab.markdown).toContain("Last touched by the loop.");
    expect((await tab.save(server)).ok).toBe(true);
    expect(server.markdown).toContain("(typed)");
    expect(server.markdown).toContain("Last touched by the loop.");
  });

  test("typing at the very end of the page while a line is appended after it", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Typed at the end.");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toContain("Typed at the end.");
    expect(tab.markdown).toContain("Last touched by the loop.");
  });

  test("both changed the same line: a conflict, with the writer's typing intact", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Mine.");
    server.handEdit((md) => md.replace("nothing much.", "nothing much. Theirs."));
    expect(tab.receive(server.src)).toBe("conflict");
    expect(tab.markdown).toContain("Mine.");
    expect(tab.markdown).not.toContain("Theirs.");
  });

  test("a merge leaves highlights outside the changed span, and the caret, where they were", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.typeAfter("nothing much.", " Typing.");
    const caret = tab.state.selection.head;
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
    expect(tab.state.selection.head).toBe(caret);
  });

  test("a hand edit that rewrites a commented sentence re-finds or orphans its comment, never keeps a stale highlight", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("end of Q3 for all teams");
    tab.receive(server.src);
    tab.typeAfter("nothing much.", " Typing.");
    server.handEdit((md) => md.replace("end of Q3 for all teams", "the start of Q4"));
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("a trailing space the writer typed survives a hand edit elsewhere (merge)", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("headcount comes from finance too.", " ");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.doc.textContent).toContain("finance too. ");
    expect(tab.markdown).toContain("Last touched by the loop.");
  });

  test("a trailing space survives a hand edit when the tab has saved in between and is clean", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("headcount comes from finance too.", " ");
    await tab.save(server);
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    expect(tab.doc.textContent).toContain("finance too. ");
  });

  test("Shift+Enter (a line break) at the end of a paragraph survives a hand edit elsewhere", async () => {
    const { server, tab } = await setup();
    tab.shiftEnterAfter("headcount comes from finance too.");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    let breaks = 0;
    tab.doc.descendants((n) => { if (n.type.name === "hardBreak") breaks++; });
    expect(breaks).toBe(1);
  });

  test("a line break in the middle of a paragraph survives a hand edit elsewhere", async () => {
    const { server, tab } = await setup();
    tab.shiftEnterAfter("The deadline is end of Q3");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    let breaks = 0;
    tab.doc.descendants((n) => { if (n.type.name === "hardBreak") breaks++; });
    expect(breaks).toBe(1);
  });

  test("trailing spaces in a heading and a list item, and several at once, survive a hand edit elsewhere", async () => {
    const server = new Server("# Title\n\n- first item\n- second item\n\nA paragraph.");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("Title", "   ");
    tab.typeAfter("first item", " ");
    tab.typeAfter("A paragraph.", "   ");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    expect(tab.doc.textContent).toContain("Title   ");
    expect(tab.doc.textContent).toContain("first item ");
    expect(tab.doc.textContent).toContain("A paragraph.   ");
  });

  test("fade-in: a line appended on the server is flagged fresh, and only that line", async () => {
    const { server, tab } = await setup();
    expect(freshTexts(tab.state)).toEqual([]); // nothing on first load
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    expect(freshTexts(tab.state)).toEqual(["Last touched by the loop."]);
  });

  test("fade-in: words inserted into a paragraph are flagged, not the whole paragraph", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("says nothing much.", "says nothing much at all."));
    tab.receive(server.src);
    const fresh = freshTexts(tab.state).join("|");
    expect(fresh).toContain("at all");
    expect(fresh).not.toContain("The last paragraph");
    expect(fresh.length).toBeLessThan(12);
  });

  test("fade-in: the writer's own typing, and the echo of their own save, are never flagged", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Typed by me.");
    await tab.save(server);
    expect(freshTexts(tab.state)).toEqual([]);
  });

  test("fade-in: a merge flags the other writer's change, not the writer's own typing; clearing ends it", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("nothing much.", " Typed by me.");
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    expect(freshTexts(tab.state)).toEqual(["Last touched by the loop."]);
    tab.session.clearFresh();
    expect(freshTexts(tab.state)).toEqual([]);
  });

  test("fade-in: a flagged range follows the text when the writer keeps typing above it", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => `${md}\n\nLast touched by the loop.`);
    tab.receive(server.src);
    tab.typeBefore("The deadline", "Intro. ");
    expect(freshTexts(tab.state)).toEqual(["Last touched by the loop."]);
  });

  // ---- the caret stays put while the server side churns ----
  /** A small deterministic random number generator, so a failing run can be replayed from its seed. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`the caret and the typed text stay put through random server edits (seed ${seed})`, async () => {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
      const { server, tab } = await setup();
      const TYPING = "Budget approval comes from finance, and headcount comes from finance too.";
      const at = TYPING.indexOf("headcount");
      // The writer puts the caret in the middle of a paragraph and keeps typing there.
      tab.typeBefore("headcount", "");
      tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find("headcount").from)));
      let typed = "";

      const notes = () => server.markdown.split("\n\n").map((p, i) => [p, i] as const).filter(([p]) => p.startsWith("Random note:"));
      const serverEdit = () => server.handEdit((md) => {
        const paras = md.split("\n\n");
        const mine = notes();
        const op = pick(["add-above", "add-below", "add-end", "extend", "tweak", "remove", "heading"]);
        const note = `Random note: ${pick(["Finance", "The launch", "Hiring"])} ${pick(["slipped to", "depends on"])} ${pick(["next quarter", "the audit"])}.`;
        const typingAt = paras.findIndex((p) => p.startsWith("Budget approval"));
        if (op === "add-above") paras.splice(Math.floor(rand() * (typingAt + 1)), 0, note);
        else if (op === "add-below") paras.splice(typingAt + 1 + Math.floor(rand() * (paras.length - typingAt)), 0, note);
        else if (op === "add-end") paras.push(note);
        else if (op === "extend" && mine.length) { const i = pick(mine)[1]; paras[i] = paras[i]!.replace(/\.$/, ", as discussed."); }
        else if (op === "tweak" && mine.length) { const i = pick(mine)[1]; paras[i] = paras[i]!.replace(/Finance|The launch|Hiring/, pick(["Support", "The audit"])); }
        else if (op === "remove" && mine.length > 1) paras.splice(pick(mine)[1], 1);
        else if (op === "heading") paras.splice(1 + Math.floor(rand() * 2), 0, `## Section ${Math.floor(rand() * 99)}`);
        return paras.join("\n\n");
      });

      for (let step = 0; step < 120; step++) {
        const r = rand();
        if (r < 0.45) {
          const ch = pick(["a", "b", "c", " ", "d"]);
          tab.typeAtCaret(ch);
          typed += ch;
        } else if (r < 0.55) {
          await tab.save(server);
        } else {
          serverEdit();
          const outcome = tab.receive(server.src);
          expect(["merged", "reloaded", "applied"]).toContain(outcome);
        }
        const { $head } = tab.state.selection;
        expect(tab.session.getSnapshot().conflict).toBe(false);
        expect(tab.state.selection.empty).toBe(true);
        // Still in the same paragraph, at the same place in it, with every typed character in order.
        expect($head.parent.textContent).toBe(TYPING.slice(0, at) + typed + TYPING.slice(at));
        expect($head.parentOffset).toBe(at + typed.length);
      }
      // Whatever the server did, saving now keeps both: the typing, and the server's notes.
      await tab.save(server);
      expect(server.markdown).toContain(TYPING.slice(0, at) + typed + TYPING.slice(at));
      expect(tab.markdown).toBe(server.markdown);
    });
  }

  // ---- the cleanup stage: orphaned comments are removed from the file ----
  group("removing orphaned comments", () => {
    const later = (ms: number) => new Date(Date.now() + ms);

    test("an orphan is kept while Undo can still bring it back, then removed from the file", async () => {
      const { server, tab, job } = await setup();
      const { placed: [id] } = job("end of Q3 for all teams");
      tab.receive(server.src);
      tab.remove("end of Q3 for all teams");
      await tab.save(server);
      expect(server.comment(id!).status).toBe("orphaned");
      expect(server.prune(later(5_000))).toEqual([]); // too soon
      expect(server.comment(id!)).toBeDefined();
      expect(server.prune(later(60_000))).toEqual([id!]);
      expect(server.block.comments[id!]).toBeUndefined();
      expect(server.markdown).toBe(tab.markdown); // the body is untouched
    });

    test("Undo inside the grace period reopens the comment, and it is no longer an orphan to remove", async () => {
      const { server, tab, job } = await setup();
      const { placed: [id] } = job("end of Q3 for all teams");
      tab.receive(server.src);
      tab.remove("end of Q3 for all teams");
      await tab.save(server);
      tab.undo();
      await tab.save(server);
      expect(server.comment(id!).status).toBe("open");
      expect(server.prune(later(120_000))).toEqual([]);
      expect(tab.highlighted(id!)).toBe("end of Q3 for all teams");
    });

    test("the open tab drops a removed comment: no highlight, and its next save does not bring it back", async () => {
      const { server, tab, job } = await setup();
      const { placed: [id] } = job("end of Q3 for all teams");
      tab.receive(server.src);
      tab.remove("end of Q3 for all teams");
      await tab.save(server);
      server.prune(later(60_000));
      tab.receive(server.src);
      expect(tab.session.getSnapshot().comments.map((c) => c.id)).not.toContain(id!);
      tab.typeAfter("nothing much.", " More.");
      await tab.save(server);
      expect(server.block.comments[id!]).toBeUndefined();
    });

    test("a page opened with comments whose passages are gone reports them at once, and they are then cleaned out", async () => {
      const { server, tab, job } = await setup();
      const { placed } = job("end of Q3 for all teams", "Budget approval comes from finance");
      tab.receive(server.src);
      await tab.save(server);
      server.handEdit((md) => md.replace("The deadline is end of Q3 for all teams.", "The deadline moved.").replace("Budget approval comes from finance, and ", ""));
      // A fresh page load: the file calls both comments open, but neither passage is there any more.
      const fresh = new Tab(server.src);
      expect(placed.every((id) => fresh.highlighted(id) === null)).toBe(true);
      expect(fresh.dirty).toBe(true); // it has something to report, though the writer typed nothing
      await fresh.save(server);
      expect(placed.every((id) => server.comment(id).status === "orphaned")).toBe(true);
      expect(server.prune(later(60_000)).sort()).toEqual([...placed].sort());
      expect(server.block.comments).toEqual({});
    });

    test("a page whose comments are all placed has nothing to report on load", async () => {
      const { server, tab, job } = await setup();
      job("end of Q3 for all teams");
      tab.receive(server.src);
      await tab.save(server);
      expect(new Tab(server.src).dirty).toBe(false);
    });

    test("open and dismissed comments are never removed, whatever their text does", async () => {
      const { server, tab, job } = await setup();
      const { placed: [open, dismissed] } = job("end of Q3 for all teams", "Budget approval comes from finance");
      tab.receive(server.src);
      server.dismiss(dismissed!);
      expect(server.prune(later(600_000))).toEqual([]);
      expect(server.comment(open!).status).toBe("open");
      expect(server.comment(dismissed!).status).toBe("dismissed");
    });

    test("a save removes the orphans that are already old, and keeps the one it has just created", async () => {
      const { server, tab, job } = await setup();
      const { placed: [a, b] } = job("end of Q3 for all teams", "Budget approval comes from finance");
      tab.receive(server.src);
      tab.remove("end of Q3 for all teams");
      await tab.save(server); // a is orphaned now
      // Time passes; the writer deletes the second passage and saves again.
      const req = (tab.remove("Budget approval comes from finance"), tab.makePut());
      const r = applyPut(server.src, req, later(60_000));
      expect(r.ok).toBe(true);
      const block = parseFile(r.file).block;
      expect(block.comments[a!]).toBeUndefined(); // old orphan: removed in the same write
      expect(block.comments[b!]!.status).toBe("orphaned"); // just orphaned: kept for Undo
    });

    test("many orphans at once: all old ones go, the file stays valid and the body identical", async () => {
      const { server, tab, job } = await setup();
      const quotes = ["end of Q3 for all teams", "Budget approval comes from finance", "headcount comes from finance too"];
      const { placed } = job(...quotes);
      tab.receive(server.src);
      tab.selectAllDelete();
      await tab.save(server);
      expect(placed.every((id) => server.comment(id).status === "orphaned")).toBe(true);
      const body = server.markdown;
      expect(server.prune(later(60_000)).sort()).toEqual([...placed].sort());
      expect(server.markdown).toBe(body);
      expect(parseFile(server.src).block.comments).toEqual({});
    });
  });

  // ---- constant typing while the server changes other blocks, with the session's own timers ----
  // ---- the generate marker ----
  group("the Complete marker", () => {
    const spinners = (tab: Tab) => [...tab.editor.view.dom.querySelectorAll<HTMLElement>(".task-point")];
    /** Puts the caret at the end of the paragraph that holds `text`. */
    const caretAfter = (tab: Tab, text: string) => tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find(text).to)));

    // The marker goes in the same way inside every kind of block, lists above all.
    const places: Record<string, { md: string; at: string }> = {
      "a bullet": { md: "- first item\n- second item", at: "first item" },
      "a numbered item": { md: "1. one\n2. two", at: "two" },
      "a nested numbered item": { md: "1. Invoke\n   1. How\n      1. via Tagging\n2. Another", at: "via Tagging" },
      "a task item": { md: "- [ ] todo", at: "todo" },
      "a quote": { md: "> quoted", at: "quoted" },
      "a table cell": { md: "| a | b |\n| - | - |\n| one | two |", at: "one" },
      "a heading": { md: "# Heading", at: "Heading" },
    };
    for (const [name, { md, at }] of Object.entries(places)) {
      test(`a Complete marker can be put in ${name}`, () => {
        const tab = new Tab(new Server(md).src);
        caretAfter(tab, at);
        const block = tab.state.selection.$head.parent.textContent;
        insertPoint(tab.editor, "gen");
        expect(tab.state.selection.$head.parent.textContent).toBe(block); // in the same block
        expect(tab.markdown).toMatch(/<!-- gen:[a-z0-9]{3,6} -->/);
        expect(spinners(tab)).toHaveLength(1);
      });
    }

    test("the marker in a list is saved, and the list still loads with its spinner", async () => {
      const server = new Server("1. one\n2. two");
      const tab = new Tab(server.src);
      caretAfter(tab, "two");
      tab.typeAtCaret(" ");
      insertPoint(tab.editor, "gen");
      await tab.save(server);
      expect(server.markdown).toMatch(/2\. two <!-- gen:[a-z0-9]{3,6} -->/);
      expect(spinners(new Tab(server.src))).toHaveLength(1);
    });

    test("every marker shows a loader (an SVG), on first load and after the page is loaded again", async () => {
      const server = new Server("First <!-- gen:aaa --> paragraph.\n\n<!-- gen:bbb -->\n\nLast.");
      const tab = new Tab(server.src);
      expect(spinners(tab).map((el) => el.dataset.id)).toEqual(["aaa", "bbb"]);
      for (const el of spinners(tab)) expect(el.querySelector('.task-loader[data-state="pending"] svg.gen-dot animate')).not.toBeNull(); // waiting: a slow blink
      await tab.save(server);
      expect(server.markdown).toContain("<!-- gen:aaa -->");
      expect(spinners(new Tab(server.src)).map((el) => el.dataset.id)).toEqual(["aaa", "bbb"]);
    });

    test("a marker that arrives from outside (a hand edit) gets its spinner, and one that is removed loses it", async () => {
      const { server, tab } = await setup();
      expect(spinners(tab)).toHaveLength(0);
      server.handEdit((md) => md.replace("The deadline", "The <!-- gen:zzz --> deadline"));
      tab.receive(server.src);
      expect(spinners(tab).map((el) => el.dataset.id)).toEqual(["zzz"]);
      server.handEdit((md) => md.replace(" <!-- gen:zzz -->", ""));
      tab.receive(server.src);
      expect(spinners(tab)).toHaveLength(0);
    });

    test("a marker survives the writer typing around it and an outside edit elsewhere", async () => {
      const { server, tab } = await setup();
      caretAfter(tab, "nothing much.");
      tab.typeAtCaret(" ");
      insertPoint(tab.editor, "gen");
      const [id] = genIds(tab.editor);
      tab.typeAfter("The deadline", " moved");
      server.handEdit((md) => `${md}\n\nAppended.`);
      tab.receive(server.src);
      expect(genIds(tab.editor)).toEqual([id!]);
      expect(spinners(tab)).toHaveLength(1);
      await tab.save(server);
      expect(server.markdown).toContain(`<!-- gen:${id} -->`);
    });

    test("two Complete commands in a row get different ids", async () => {
      const { tab } = await setup();
      for (let i = 0; i < 20; i++) insertPoint(tab.editor, "gen");
      const ids = genIds(tab.editor);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    });

    test("a comment on text next to a marker is found again after a reload", async () => {
      const { server, tab, job } = await setup();
      caretAfter(tab, "The deadline is ");
      insertPoint(tab.editor, "gen");
      await tab.save(server);
      const { placed: [id] } = job("end of Q3 for all teams");
      const again = new Tab(server.src);
      expect(again.highlighted(id!)).toBe("end of Q3 for all teams");
      expect(spinners(again)).toHaveLength(1);
    });
  });

  // ---- Cmd+. : a `sel` range on the selection, a `gen` marker at a bare caret ----
  group("Cmd+. on a selection or a caret", () => {
    const cmdDot = (tab: Tab) => pressCmdDot(tab);
    const select = (tab: Tab, text: string, endText = text) =>
      tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find(text).from, tab.find(endText).to)));
    const caretAt = (tab: Tab, text: string) => tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find(text).to)));
    const doIds = (tab: Tab) => [...new Set([...tab.editor.view.dom.querySelectorAll<HTMLElement>(".task-range")].map((el) => el.dataset.id!))];
    const doText = (tab: Tab, id: string) => [...tab.editor.view.dom.querySelectorAll<HTMLElement>(`.task-range[data-id="${id}"]`)].map((el) => el.textContent).join("");
    const spinnerIds = (tab: Tab) => [...tab.editor.view.dom.querySelectorAll<HTMLElement>(".task-range-loader")].map((el) => el.dataset.id!);
    const genSpinners = (tab: Tab) => tab.editor.view.dom.querySelectorAll(".task-point .task-loader svg").length;

    test("with text selected it becomes a sel range: a highlight, a spinner after it, and the pair of comments in the markdown", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3 for all teams");
      expect(cmdDot(tab)).toBe(true);
      const [id] = doIds(tab);
      expect(id).toMatch(/^[a-z0-9]{3,6}$/);
      expect(doText(tab, id!)).toBe("end of Q3 for all teams");
      expect(spinnerIds(tab)).toEqual([id!]);
      expect(tab.markdown).toContain(`The deadline is <!-- sel:${id} -->end of Q3 for all teams<!-- /sel:${id} -->.`);
      expect(tab.state.selection.empty).toBe(true); // the caret is left after the range
      expect(tab.doc.textContent).not.toContain("sel:"); // the page text is unchanged
    });

    test("with only a caret it puts a gen marker there, with its spinner", async () => {
      const { tab } = await setup();
      caretAt(tab, "end of Q3 for all teams");
      expect(cmdDot(tab)).toBe(true);
      expect(tab.markdown).toMatch(/end of Q3 for all teams<!-- gen:[a-z0-9]{3,6} -->\./);
      expect(genSpinners(tab)).toBe(1);
      expect(doIds(tab)).toEqual([]);
    });

    test("a selection across paragraphs marks the text in each, with one id and one spinner at the end", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3 for all teams", "headcount comes from finance too");
      cmdDot(tab);
      const [id] = doIds(tab);
      expect(doIds(tab)).toHaveLength(1);
      expect(doText(tab, id!)).toContain("end of Q3 for all teams");
      expect(doText(tab, id!)).toContain("Budget approval comes from finance");
      expect(tab.markdown.match(new RegExp(`<!-- sel:${id} -->`, "g"))).toHaveLength(2);
      expect(spinnerIds(tab)).toEqual([id!]);
    });

    test("it works in a list item, a table cell, a heading and a quote", async () => {
      for (const [md, text] of [["- first item\n- second item", "second item"], ["| a | b |\n| - | - |\n| one | two |", "two"], ["# A heading", "heading"], ["> quoted words", "quoted"]] as const) {
        const tab = new Tab(new Server(md).src);
        select(tab, text);
        cmdDot(tab);
        expect(doText(tab, doIds(tab)[0]!)).toBe(text);
        expect(tab.markdown).toMatch(new RegExp(`<!-- sel:[a-z0-9]{3,6} -->${text}<!-- /sel:[a-z0-9]{3,6} -->`));
      }
    });

    test("pressing it again on the same text, or on text that touches a range, changes nothing", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3");
      cmdDot(tab);
      const before = tab.markdown;
      select(tab, "end of Q3");
      expect(cmdDot(tab)).toBe(true);
      select(tab, "deadline is end of Q3 for"); // overlaps the range
      expect(cmdDot(tab)).toBe(true);
      expect(tab.markdown).toBe(before);
      expect(doIds(tab)).toHaveLength(1);
    });

    test("text in a code block can't take a range: nothing happens, and nothing breaks", async () => {
      const tab = new Tab(new Server("Intro.\n\n```\nconst a = 1;\n```").src);
      const before = tab.markdown;
      select(tab, "const a");
      expect(cmdDot(tab)).toBe(true);
      expect(tab.markdown).toBe(before);
      expect(doIds(tab)).toEqual([]);
    });

    test("every placeholder gets its own id, across gen markers and sel ranges together", async () => {
      const { tab } = await setup();
      const words = ["The deadline", "Budget approval", "headcount comes", "The last paragraph", "nothing much"];
      for (const [i, w] of words.entries()) {
        if (i % 2) { caretAt(tab, w); cmdDot(tab); } else { select(tab, w); cmdDot(tab); }
      }
      const ids = [...tab.markdown.matchAll(/<!-- (?:gen|sel):([a-z0-9]{3,6}) -->/g)].map((m) => m[1]!);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    });

    test("it is saved, and a page loaded from the file shows the range and its spinner again", async () => {
      const { server, tab } = await setup();
      select(tab, "end of Q3 for all teams");
      cmdDot(tab);
      const [id] = doIds(tab);
      await tab.save(server);
      expect(server.markdown).toContain(`<!-- sel:${id} -->end of Q3 for all teams<!-- /sel:${id} -->`);
      const fresh = new Tab(server.src);
      expect(doIds(fresh)).toEqual([id!]);
      expect(doText(fresh, id!)).toBe("end of Q3 for all teams");
      expect(spinnerIds(fresh)).toEqual([id!]);
    });

    test("typing right after the range, or in the middle of it, behaves: the edge doesn't grow, the middle stays marked", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3 for all teams");
      cmdDot(tab);
      const [id] = doIds(tab);
      tab.typeAfter("end of Q3 for all teams", " (soon)");
      expect(doText(tab, id!)).toBe("end of Q3 for all teams");
      tab.typeAfter("end of Q3", " really");
      expect(doText(tab, id!)).toBe("end of Q3 really for all teams");
      expect(tab.markdown).toContain(`<!-- sel:${id} -->end of Q3 really for all teams<!-- /sel:${id} --> (soon).`);
    });

    test("deleting the selected text removes the range and its spinner; Undo brings both back", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3 for all teams");
      cmdDot(tab);
      const [id] = doIds(tab);
      tab.remove("end of Q3 for all teams");
      expect(doIds(tab)).toEqual([]);
      expect(spinnerIds(tab)).toEqual([]);
      expect(tab.markdown).not.toContain("sel:");
      tab.undo();
      expect(doIds(tab)).toEqual([id!]);
      expect(spinnerIds(tab)).toEqual([id!]);
    });

    test("copying marked text does not copy the range (no duplicate id); cutting moves it", async () => {
      const { tab } = await setup();
      select(tab, "end of Q3");
      cmdDot(tab);
      const [id] = doIds(tab);
      tab.copyPaste("end of Q3", "nothing much.");
      expect(tab.markdown.match(new RegExp(`<!-- sel:${id} -->`, "g"))).toHaveLength(1); // one range: the copy has none
      expect(spinnerIds(tab)).toEqual([id!]);
      tab.cutPaste("end of Q3", "headcount comes from finance too.");
      expect(doIds(tab)).toEqual([id!]);
    });

    test("a sel range and a comment on the same words live together, and the comment is found again after a reload", async () => {
      const { server, tab, job } = await setup();
      const { placed: [cid] } = job("end of Q3 for all teams");
      tab.receive(server.src);
      select(tab, "end of Q3 for all teams");
      cmdDot(tab);
      expect(tab.highlighted(cid!)).toBe("end of Q3 for all teams");
      await tab.save(server);
      const fresh = new Tab(server.src);
      expect(fresh.highlighted(cid!)).toBe("end of Q3 for all teams");
      expect(doIds(fresh)).toHaveLength(1);
    });

    test("a range added from outside (a hand edit) gets its spinner, a removed one loses it, and typing elsewhere is kept", async () => {
      const { server, tab } = await setup();
      tab.typeAfter("nothing much.", " Typing.");
      server.handEdit((md) => md.replace("end of Q3", "<!-- sel:zzz -->end of Q3<!-- /sel:zzz -->"));
      tab.receive(server.src);
      expect(doIds(tab)).toEqual(["zzz"]);
      expect(spinnerIds(tab)).toEqual(["zzz"]);
      expect(tab.markdown).toContain("Typing.");
      server.handEdit((md) => md.replace("<!-- sel:zzz -->end of Q3<!-- /sel:zzz -->", "end of Q3"));
      tab.receive(server.src);
      expect(doIds(tab)).toEqual([]);
      expect(spinnerIds(tab)).toEqual([]);
    });

  });

  // ---- spinners must not be rebuilt while the writer types (that restarts their animation: a flicker) ----
  group("spinners stay put while typing", () => {
    const cmdDot = (tab: Tab) => pressCmdDot(tab);
    const select = (tab: Tab, text: string) => tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find(text).from, tab.find(text).to)));
    const doSpinner = (tab: Tab) => tab.editor.view.dom.querySelector<HTMLElement>(".task-range-loader");
    const genMarker = (tab: Tab) => tab.editor.view.dom.querySelector<HTMLElement>(".task-point");
    const animation = (el: HTMLElement | null) => el?.querySelector("animateTransform") ?? null;

    /** A page with a sel range in one paragraph and a gen marker in another. */
    async function withBoth() {
      const server = new Server("First paragraph here.\n\nSecond paragraph has the range inside.\n\nThird has a marker <!-- gen:mrk --> in it.\n\nFourth is plain.");
      const tab = new Tab(server.src);
      select(tab, "the range inside");
      cmdDot(tab);
      return { server, tab };
    }

    const edits: Record<string, (tab: Tab) => void> = {
      "typing in an earlier paragraph": (t) => t.typeAfter("First paragraph", " more"),
      "typing before the range in its own paragraph": (t) => t.typeBefore("paragraph has the range", "x"),
      "typing inside the range": (t) => t.typeAfter("the range", "y"),
      "typing right after the range": (t) => t.typeAfter("the range inside", "!"),
      "typing in a later paragraph": (t) => t.typeAfter("Fourth is plain", "z"),
      "typing before the marker in its paragraph": (t) => t.typeBefore("has a marker", "w"),
      "typing after the marker in its paragraph": (t) => t.typeAfter("in it", "v"),
      "a new paragraph above everything": (t) => t.paragraphBefore("First paragraph", "A new top paragraph."),
      "deleting text above": (t) => t.remove(t.doc.firstChild!.textContent.slice(0, 1)),
    };
    for (const [name, edit] of Object.entries(edits)) {
      test(`${name}: both spinners are the same elements, still animating`, async () => {
        const { tab } = await withBoth();
        const [d0, g0] = [doSpinner(tab), genMarker(tab)];
        const [da0, ga0] = [animation(d0), animation(g0)];
        expect(d0).not.toBeNull();
        expect(g0).not.toBeNull();
        for (let i = 0; i < 5; i++) edit(tab);
        expect(doSpinner(tab)).toBe(d0);
        expect(genMarker(tab)).toBe(g0);
        expect(animation(doSpinner(tab))).toBe(da0);
        expect(animation(genMarker(tab))).toBe(ga0);
      });
    }

    test("a comment landing, a save, an outside edit elsewhere and a merge don't rebuild them either", async () => {
      const { server, tab } = await withBoth();
      const [d0, g0] = [doSpinner(tab), genMarker(tab)];
      const { placed: [id] } = server.job(server.markdown, [{ quote: "Fourth is plain" }]);
      tab.receive(server.src);
      expect(tab.highlighted(id!)).toBe("Fourth is plain");
      tab.typeAfter("First paragraph", " typed");
      await tab.save(server);
      server.handEdit((md) => `${md}\n\nAppended.`);
      tab.receive(server.src);
      tab.typeAfter("Fourth is plain", "!");
      expect(doSpinner(tab)).toBe(d0);
      expect(genMarker(tab)).toBe(g0);
    });

    test("with a spinner in every paragraph, typing in one rebuilds none of the others", async () => {
      const server = new Server(Array.from({ length: 6 }, (_, i) => `Paragraph ${i} with <!-- gen:g0${i} --> a marker.`).join("\n\n"));
      const tab = new Tab(server.src);
      const before = [...tab.editor.view.dom.querySelectorAll(".task-point")];
      expect(before).toHaveLength(6);
      for (let i = 0; i < 20; i++) tab.typeAfter("Paragraph 3 with", "k");
      const after = [...tab.editor.view.dom.querySelectorAll(".task-point")];
      expect(after.every((el, i) => el === before[i])).toBe(true);
    });

    test("each sel range has exactly one spinner, however much is typed", async () => {
      const { tab } = await withBoth();
      for (let i = 0; i < 30; i++) tab.typeAfter("the range", "q");
      expect(tab.editor.view.dom.querySelectorAll(".task-range-loader")).toHaveLength(1);
    });
  });
});

group("a change merged in next to the caret", () => {
  test("typing in a list item stays put when items are added to the same list", async () => {
    const server = new Server("# Plan\n\n- one\n- two\n- three\n\nEnd.");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("two", " typed");
    const caret = tab.state.selection.head;
    server.handEdit((md) => md.replace("- three", "- three\n- added by agent"));
    tab.receive(server.src);
    const { $head } = tab.state.selection;
    expect($head.parent.textContent).toBe("two typed");
    expect($head.pos).toBe(caret);
    expect(tab.markdown).toContain("- added by agent");
  });
});

group("new blocks carry a green line until the writer types in them", () => {
  const setup = async () => {
    const server = new Server("# Plan\n\nFirst.\n\nSecond.");
    const tab = new Tab(server.src);
    await tab.save(server);
    return { server, tab };
  };
  test("a block that arrives is flagged, and stays flagged", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "Agent added.\n\nSecond."));
    tab.receive(server.src);
    expect(newBlockTexts(tab.state)).toEqual(["Agent added."]);
    tab.session.clearFresh();
    expect(newBlockTexts(tab.state)).toEqual(["Agent added."]);
  });
  test("typing elsewhere keeps it; typing in it clears it", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "Agent added.\n\nSecond."));
    tab.receive(server.src);
    tab.typeAfter("First.", " more");
    expect(newBlockTexts(tab.state)).toEqual(["Agent added."]);
    tab.typeAfter("Agent added.", " mine");
    expect(newBlockTexts(tab.state)).toEqual([]);
  });
  // The line is the block's ::after, in the margin right of the block: the fake DOM has no layout, so each test gives
  // the block a box and points at the margin.
  const lineOf = (tab: Tab, text: string) => {
    const el = [...tab.editor.view.dom.querySelectorAll<HTMLElement>(".new-block")].find((e) => e.textContent === text)!;
    el.getBoundingClientRect = () => ({ left: 0, right: 600, top: 100, bottom: 160, width: 600, height: 60, x: 0, y: 100, toJSON() {} });
    return el;
  };
  const pointer = (el: HTMLElement, type: string, x: number, y: number) => el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }));

  test("hovering the line shows its cross; the cross deletes the block, as the writer's own edit", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "Agent added.\n\nSecond."));
    tab.receive(server.src);
    pointer(lineOf(tab, "Agent added."), "mousemove", 300, 120); // over the text: no cross
    expect(tab.editor.view.dom.querySelector(".new-block-hover")).toBeNull();
    pointer(lineOf(tab, "Agent added."), "mousemove", 680, 140); // over the line
    expect(tab.editor.view.dom.querySelector(".new-block-hover")?.textContent).toBe("Agent added.");
    pointer(lineOf(tab, "Agent added."), "mousedown", 680, 140); // below the cross: nothing
    pointer(lineOf(tab, "Agent added."), "mousedown", 672, 108); // the top of the line, left of the cross: nothing
    expect(tab.markdown).toContain("Agent added.");
    pointer(lineOf(tab, "Agent added."), "mousedown", 680, 108); // the cross
    expect(tab.markdown).toBe("# Plan\n\nFirst.\n\nSecond.");
    expect(newBlockTexts(tab.state)).toEqual([]);
    expect(tab.dirty).toBe(true);
    await tab.save(server);
    expect(server.markdown).toBe("# Plan\n\nFirst.\n\nSecond.");
    tab.undo();
    expect(tab.markdown).toBe("# Plan\n\nFirst.\n\nAgent added.\n\nSecond.");
  });

  test("the cross deletes a whole list or table that arrived, not just a line of it", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "- one\n- two\n\nSecond."));
    tab.receive(server.src);
    pointer(lineOf(tab, "onetwo"), "mousemove", 680, 120);
    pointer(lineOf(tab, "onetwo"), "mousedown", 680, 108);
    expect(tab.markdown).toBe("# Plan\n\nFirst.\n\nSecond.");
  });

  test("dismissing one line keeps the lines of the blocks around it, as they move up", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "Added one.\n\nAdded two.\n\nAdded three.\n\nSecond."));
    tab.receive(server.src);
    expect(newBlockTexts(tab.state)).toEqual(["Added one.", "Added two.", "Added three."]);
    pointer(lineOf(tab, "Added two."), "mousemove", 680, 120);
    pointer(lineOf(tab, "Added two."), "mousedown", 680, 108);
    expect(newBlockTexts(tab.state)).toEqual(["Added one.", "Added three."]);
    expect(tab.editor.view.dom.querySelectorAll(".new-block").length).toBe(2);
    // A block pasted between two new ones leaves them flagged too.
    tab.dispatch(tab.state.tr.insert(tab.find("Added three.").from - 1, tab.editor.schema.nodes.paragraph!.create(null, tab.editor.schema.text("Pasted."))));
    expect(newBlockTexts(tab.state)).toEqual(["Added one.", "Added three."]);
    // So does deleting a whole new block by hand; deleting a character in one is editing it.
    tab.removeNodeAround("Added one.", "paragraph");
    expect(newBlockTexts(tab.state)).toEqual(["Added three."]);
    tab.remove("three");
    expect(newBlockTexts(tab.state)).toEqual([]);
  });

  test("leaving the line hides the cross; a block that isn't new has no line to hover", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("Second.", "Agent added.\n\nSecond."));
    tab.receive(server.src);
    pointer(lineOf(tab, "Agent added."), "mousemove", 680, 120);
    tab.editor.view.dom.dispatchEvent(new MouseEvent("mouseleave"));
    expect(tab.editor.view.dom.querySelector(".new-block-hover")).toBeNull();
    const first = [...tab.editor.view.dom.querySelectorAll("p")].find((p) => p.textContent === "First.")!;
    first.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom: 30, width: 600, height: 30, x: 0, y: 0, toJSON() {} });
    pointer(first as HTMLElement, "mousedown", 680, 5);
    expect(tab.markdown).toContain("First.");
  });

  test("a change inside a block flags that block; the blocks around it are left alone", async () => {
    const { server, tab } = await setup();
    server.handEdit((md) => md.replace("First.", "First, edited."));
    tab.receive(server.src);
    expect(newBlockTexts(tab.state)).toEqual(["First, edited."]);
  });
});
