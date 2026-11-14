// The page, end to end in a fake DOM: the writer's typing reaching the file, and the file changing under them (an
// editor of their own, a sync tool, git): merged when it can be, held for review when it can't, never lost.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { pageChanged } from "../../src/server/runtime";
import { join } from "node:path";
import { startApp, type App, type PageView } from "./app";

setDefaultTimeout(20_000);
let app: App;
// The agents are off for these pages: this is about the file.
beforeAll(async () => { app = await startApp(); });
afterAll(() => app.close());
let open: PageView[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

let n = 0;
async function page(markdown: string, agentOff = true) {
  const id = `q${++n}`;
  app.write(id, agentOff ? `${markdown}\n<!-- solip-comments\n"meta": { "rev": 1, "body_rev": 1, "body_by": null }\n"agent": { "on": false }\n"comments": {}\n-->\n` : markdown);
  const p = await app.open(id);
  open.push(p);
  return p;
}
const body = (p: PageView) => app.body(p.id).trimEnd();
/** Changes the file on disk from outside, keeping its comments block. */
function outside(p: PageView, edit: (body: string) => string) {
  const src = app.file(p.id);
  const at = src.indexOf("<!-- solip-comments");
  const b = at < 0 ? src : src.slice(0, at);
  writeFileSync(join(app.docs, `${p.id}.md`), edit(b) + (at < 0 ? "" : src.slice(at)));
  pageChanged(p.id);
}

test("a burst of typing in several places, saved as it goes: the file ends as the editor is", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.\n\nThree.");
  const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
  for (let i = 0; i < words.length; i++) {
    p.caret(["One.", "Two.", "Three."][i % 3]!);
    p.type(` ${words[i]}`);
    await Bun.sleep([0, 5, 40, 120][i % 4]!);
  }
  await p.saved();
  expect(body(p)).toBe(p.markdown.trimEnd());
  for (const w of words) expect(body(p)).toContain(w);
});

test("an edit from outside while the writer is idle shows in the page, with no banner", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.");
  outside(p, (b) => b.replace("Two.", "Two, from outside."));
  await p.until("the outside edit", () => p.text.includes("Two, from outside."));
  expect(p.banners).toEqual([]);
  expect(body(p)).toBe("# A\n\nOne.\n\nTwo, from outside.");
});

test("an edit from outside to another paragraph while the writer types: both are kept, in the page and the file", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.");
  p.caret("One.");
  p.type(" Mine.");
  outside(p, (b) => b.replace("Two.", "Two, theirs."));
  p.type(" More.");
  await p.until("both in the page", () => p.text.includes("One. Mine. More.") && p.text.includes("Two, theirs."));
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne. Mine. More.\n\nTwo, theirs.");
});

test("an edit from outside to the paragraph the writer is changing: neither is lost; the writer can keep theirs", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.");
  p.caret("One.");
  p.type(" Mine.");
  outside(p, (b) => b.replace("One.", "One, theirs."));
  await p.until("a banner", () => p.banners.length > 0, 8000);
  const banner = p.banners.join(" ");
  expect(banner).toMatch(/changed elsewhere|outside the editor/);
  expect(p.text).toContain("One. Mine.");
  if (/changed elsewhere/.test(banner)) {
    p.click(p.button("Keep mine")!);
    await p.until("theirs replaced by mine", () => body(p).includes("One. Mine."));
  }
  expect(app.file(p.id)).not.toContain("<<<<<<<");
});

test("a hand edit that clashes with unsaved typing raises the banner; Keep mine saves the writer's version", async () => {
  const p = await page("# Clash\n\nOne line here.");
  // The writer's saves held back, so the hand edit arrives while the typing is unsaved.
  app.blockSaves(p.id);
  p.typeAfter("One line here.", " Mine.");
  await p.until("the failed save", () => p.saveLabel.startsWith("Can't save"));
  outside(p, (b) => b.replace("One line here.", "One line here. Theirs."));
  await p.until("the banner", () => p.banners.some((b) => /This page was changed elsewhere\./.test(b)), 8000);
  expect(p.text).toContain("Mine.");
  app.blockSaves(p.id, false);
  p.click(p.button("Keep mine")!);
  await p.until("the writer's version saved", () => body(p) === "# Clash\n\nOne line here. Mine." && p.saveLabel === "Saved");
  expect(p.banners.filter((b) => /changed elsewhere/.test(b))).toEqual([]);
});

test("a second tab on the same page is refused and says so; the first goes on saving", async () => {
  const p = await page("# A\n\nOne.");
  const second = await app.open(p.id);
  open.push(second);
  await second.until("the refusal", () => second.banners.some((b) => /open in another tab/.test(b)));
  p.typeAfter("One.", " Still mine.");
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne. Still mine.");
});

test("leaving the page right after typing (All pages, inside the app): the last words are saved, not lost", async () => {
  const p = await page("# A\n\nOne.");
  p.typeAfter("One.", " Last words.");
  await p.close(); // the page unmounts at once, before its save would have gone
  await app.until("the last words on disk", () => body(p) === "# A\n\nOne. Last words.");
});

test("leaving while a save is on its way, with words typed since: those go too, once it is back", async () => {
  const p = await page("# A\n\nOne.");
  const gate = app.holdSaves(p.id);
  p.typeAfter("One.", " First.");
  await p.until("the save sent", () => p.saveLabel === "Saving…");
  p.typeAfter("First.", " Second.");
  await p.close();
  gate.release();
  await app.until("both on disk", () => body(p) === "# A\n\nOne. First. Second.", 4000, () => body(p));
});

test("leaving right after typing while the file was changed from outside: the last save is merged, not refused and lost", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.");
  p.typeAfter("One.", " Mine.");
  outside(p, (b) => b.replace("Two.", "Two, theirs."));
  await Bun.sleep(150); // the server has their edit; the page hasn't merged it yet
  await p.close();
  await app.until("both on disk", () => body(p) === "# A\n\nOne. Mine.\n\nTwo, theirs.", 4000, () => body(p));
});

test("leaving right after typing while the file changes twice from outside (an ack, then a suggestion): merged until it lands", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.\n\nThree.");
  const first = app.holdSaves(p.id);
  p.typeAfter("One.", " Mine.");
  await p.close(); // the last save goes, and waits
  outside(p, (b) => b.replace("Two.", "Two, theirs."));
  const second = app.holdSaves(p.id);
  const asked = () => app.requests.filter((r) => r === `/api/pages/${p.id}`).length;
  const before = asked();
  first.release(); // refused: merged and sent again, and that waits
  await app.until("the merged save sent", () => asked() > before);
  outside(p, (b) => b.replace("Three.", "Three, theirs."));
  second.release(); // refused again: merged once more
  await app.until("all three on disk", () => body(p) === "# A\n\nOne. Mine.\n\nTwo, theirs.\n\nThree, theirs.", 4000, () => body(p));
});

test("closed and opened again, the page is as the writer left it, nothing doubled", async () => {
  const p = await page("# A\n\nOne.");
  p.typeAfter("One.", " Before closing.");
  await p.saved();
  await p.close();
  const again = await app.open(p.id);
  open.push(again);
  expect(again.markdown.trimEnd()).toBe("# A\n\nOne. Before closing.");
  again.typeAfter("closing.", " After.");
  await again.saved();
  expect(body(again)).toBe("# A\n\nOne. Before closing. After.");
});

test("the writer's edits keep flowing while the file is replaced from outside again and again", async () => {
  const p = await page("# A\n\nMine:\n\nTheirs: 0");
  p.caret("Mine:");
  for (let i = 1; i <= 6; i++) {
    p.type(` m${i}`);
    outside(p, (b) => b.replace(/Theirs: \d+/, `Theirs: ${i}`));
    await Bun.sleep(80);
  }
  await p.until("the last outside edit", () => p.text.includes("Theirs: 6"), 8000);
  await p.saved();
  expect(body(p)).toBe("# A\n\nMine: m1 m2 m3 m4 m5 m6\n\nTheirs: 6");
  expect(p.banners).toEqual([]);
});

test("a placeholder written by hand in another editor is picked up by the agent and answered in the open page", async () => {
  const p = await page("# A\n\nOne.", false);
  app.model.script = () => ({ kind: "suggestion", mode: "at", place: "inline", suggestion: " From a hand-written ask." });
  outside(p, (b) => b.replace("One.", "One.<!-- gen:hw1 -->"));
  await p.until("its suggestion", () => p.$(".sug-preview")?.textContent === " From a hand-written ask.", 8000);
  expect(app.records(p.id).hw1?.created_by).toBe("writer");
});

test("undo after an outside edit undoes the writer's own typing, not theirs", async () => {
  const p = await page("# A\n\nOne.\n\nTwo.");
  p.caret("One.");
  p.type(" Mine.");
  await p.saved();
  outside(p, (b) => b.replace("Two.", "Two, theirs."));
  await p.until("theirs", () => p.text.includes("Two, theirs."));
  p.editor.commands.undo();
  await p.saved();
  expect(body(p)).toBe("# A\n\nOne.\n\nTwo, theirs.");
});

test("the file deleted from outside while open: the page keeps the writer's text and says it can't save", async () => {
  const p = await page("# A\n\nOne.");
  const { rmSync } = await import("node:fs");
  rmSync(join(app.docs, `${p.id}.md`));
  await Bun.sleep(200);
  p.typeAfter("One.", " Still here.");
  await p.until("the save to fail visibly", () => p.saveLabel === "Can't save, retrying…");
  expect(p.text).toContain("One. Still here.");
  expect(p.$(".ProseMirror")).not.toBeNull();
});
