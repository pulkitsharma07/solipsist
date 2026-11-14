// The settings dialog, end to end in a fake DOM: the gear on a page, editing a prompt (kept as a file in the prompts
// folder), resetting it, the unsaved-changes warning, and the loaded settings.
import "./platform"; // first: see platform.ts
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App, type PageView } from "./app";

setDefaultTimeout(20_000);
const prompts = mkdtempSync(join(tmpdir(), "solip-dom-prompts-"));
let app: App;
beforeAll(async () => {
  app = await startApp({ SOLIPSIST_PROMPTS_DIR: prompts, AGENT_CONCURRENCY: "2" });
  app.write("plain", '# Plain\n\nFirst paragraph.\n\n<!-- solip-comments\n"meta": { "rev": 1, "body_rev": 1, "body_by": null }\n"agent": { "on": false }\n"comments": {}\n-->\n');
});
afterAll(async () => { await app.close(); rmSync(prompts, { recursive: true, force: true }); });
let open: PageView | null = null;
afterEach(async () => { await open?.close(); open = null; });

const dialog = () => document.querySelector('[role="dialog"][aria-label="Settings"]') as HTMLElement | null;
async function openDialog(): Promise<PageView> {
  const p = open = await app.open("plain");
  p.click(p.button("Settings")!);
  await p.until("the dialog", () => !!dialog());
  return p;
}
/** A prompt in the list, by its exact title. */
const item = (title: string) => ([...document.querySelectorAll(".prompt-item")] as HTMLElement[]).find((i) => [...i.querySelectorAll("span")].some((s) => s.textContent === title));
const box = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement;
const choose = async (p: PageView, title: string) => {
  await p.until(`the prompt ${title}`, () => !!item(title));
  p.click(item(title)!);
  await p.until(`its editor`, () => !!box(`${title} text`));
};

test("the gear opens the prompts; an edit is saved as a file in the prompts folder, and reset deletes it", async () => {
  const p = await openDialog();
  await p.until("the list", () => !!item("Protocol"));
  await choose(p, "Task type: gen");
  await p.until("its text", () => box("Task type: gen text").value.length > 50);
  const original = box("Task type: gen text").value;
  expect(p.button("Save")!.disabled).toBe(true);

  p.fill(box("Task type: gen text"), "Write one short sentence.");
  await p.until("marked unsaved", () => item("Task type: gen")!.textContent!.includes("unsaved"));
  p.click(p.button("Save")!);
  await p.until("marked edited", () => [...item("Task type: gen")!.querySelectorAll("i")].some((i) => i.textContent === "edited"));
  expect(readFileSync(join(prompts, "type.gen.md"), "utf8")).toBe("Write one short sentence.\n");

  // The server uses it from the next run: the API says so too.
  const list = await (await fetch(`${app.base}/api/prompts`)).json() as { prompts: { id: string }[] };
  expect(list.prompts.find((x) => x.id === "type.gen")).toMatchObject({ custom: true, text: "Write one short sentence." });

  p.click(p.button("Reset to default")!);
  await p.until("the file to be gone", () => !existsSync(join(prompts, "type.gen.md")));
  await p.until("the editor to show the default", () => box("Task type: gen text").value === original);
});

test("a prompt that leaves out a required slot is refused with the reason, and nothing is saved", async () => {
  const p = await openDialog();
  await choose(p, "Run prompt");
  p.fill(box("Run prompt text"), "Just do it.");
  await p.until("the warning", () => !!document.querySelector(".prompt-editor .warn"));
  p.click(p.button("Save")!);
  await p.until("the refusal", () => !!document.querySelector(".prompt-editor .error"));
  expect(document.querySelector(".prompt-editor .error")!.textContent).toContain("{target}");
  expect(existsSync(join(prompts, "run.md"))).toBe(false);
});

test("closing with unsaved changes asks once; the second try closes", async () => {
  const p = await openDialog();
  await choose(p, "Protocol");
  await p.until("its text", () => box("Protocol text").value.length > 0);
  p.fill(box("Protocol text"), `${box("Protocol text").value}\nExtra.`);
  // Escape at once, with nothing waited for in between: the dialog used to answer it with what it knew before the
  // edit and close on it, discarding the change without a word.
  p.press("Escape", box("Protocol text"));
  await p.until("the warning", () => /unsaved changes/.test(document.querySelector('[role="alert"]')?.textContent ?? ""));
  expect(dialog()).not.toBeNull();
  expect(item("Protocol")!.textContent).toContain("unsaved");
  p.press("Escape", box("Protocol text"));
  await p.until("the dialog gone", () => !dialog());
  expect(existsSync(join(prompts, "protocol.md"))).toBe(false);
});

test("the Loaded settings tab shows the values in effect and where each came from; the debug panel has no such tab", async () => {
  const p = await openDialog();
  p.click(p.button("Loaded settings")!);
  const row = () => ([...document.querySelectorAll(".setting")] as HTMLElement[]).find((s) => s.textContent!.includes("agent.concurrency"));
  await p.until("the row", () => !!row());
  expect(row()!.textContent).toContain("2");
  expect(row()!.textContent).toContain("AGENT_CONCURRENCY");
  p.fill(box("Filter settings") as unknown as HTMLInputElement, "max_runs");
  await p.until("only the match", () => document.querySelectorAll(".setting").length === 1);
  p.click(p.button("Close")!);
  await p.until("the dialog gone", () => !dialog());
  p.click(".statusbar .debug-toggle");
  await p.until("the panel", () => !!p.$(".debug"));
  expect(p.$$(".debug .view-tab")).toHaveLength(0);
});

test("no page logged an error", () => expect(app.errors).toEqual([]));
