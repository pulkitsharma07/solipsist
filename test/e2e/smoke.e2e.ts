// What only a real browser can show: the dev server on a scratch project, the installed Chrome driven by Playwright, and
// a fake agent (AGENT_CMD). Real typing, layout, the pointer, scrolling, the clipboard. The app's behaviour is tested in
// `test/e2e-dom/`, without a browser. Not part of `bun test`: `bun run test:ui`.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchBrowser, trackServer, untrackServer, type E2EBrowser, testPort } from "./leftovers";

/** The repo: the tests run in a scratch project, so the server is started by its full path. */
const repoRoot = join(import.meta.dir, "..", "..");

const root = mkdtempSync(join(tmpdir(), "solip-e2e-"));
const docs = join(root, ".solipsist", "pages");
const pids = join(root, "agent-pids");
const port = testPort(4100);
const base = `http://localhost:${port}`;
const file = (id: string) => join(docs, `${id}.md`);
const body = (id: string) => readFileSync(file(id), "utf8").split("<!-- solip-comments")[0]!.trim();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000) {
  for (const t = Date.now(); !(await ok()); await wait(50)) if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
}
const spawned = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);

/** A line the fake agent prints: a `result` whose text is `text` (printf: macOS's sh echo would expand the `\n`s). */
const said = (text: string) => `printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result: text }).replaceAll("'", `'\\''`)}'`;
// The fake agent, by the task its prompt names: `sel:big` gets a long list after it, an `img` task a new picture, and
// anything else a short completion.
const AGENT = `echo $$ >> ${pids}; while read l; do case "$l" in
  *"task big,"*) ${said(`<suggestion mode="after" place="blocks">\n${Array.from({ length: 60 }, (_, i) => `- Risk number ${i + 1}, said at some length`).join("\n")}\n</suggestion>`)};;
  *"the img task"*) ${said('<suggestion mode="replace" place="blocks">![Signups by week, bars on their side](images/picture/chart-wide.svg)</suggestion>\n<note>Same numbers, bars on their side.</note>')};;
  *) ${said('Done.\n<suggestion mode="at" place="inline">\nfilled by the agent\n</suggestion>\n<note>Filled it.</note>')};;
esac; done`;

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;
/** Its Chrome, which goes when this run does, however the run ends (`browser.ts`). */
let chrome: E2EBrowser;
/** Errors the pages logged. Expected: the 409 refusing a second tab of a page. */
const errors: string[] = [];

beforeAll(async () => {
  Bun.spawnSync(["mkdir", "-p", docs]);
  writeFileSync(file("plain"), "# Smoke\n\nFirst paragraph.\n\nSecond paragraph.\n");
  const para = (n: number) => `Paragraph ${n} has some words in it.`;
  writeFileSync(file("caret"), `# Caret\n\n${Array.from({ length: 25 }, (_, i) => para(i)).join("\n\n")}\n\nThe plan is <!-- gen:abc --> done.\n\n${Array.from({ length: 25 }, (_, i) => para(i + 30)).join("\n\n")}\n`);
  writeFileSync(file("big"), "# Big\n\n<!-- sel:big -->List sixty risks<!-- /sel:big -->\n\nAfter.\n");
  // A page with an image of its own: assets are served from the project, beside the file that links them.
  Bun.spawnSync(["mkdir", "-p", join(root, "images", "picture")]);
  const chart = (title: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" width="320" height="120"><rect width="320" height="120" rx="12" fill="#ffffff" stroke="#e5e7eb"/><text x="20" y="30" font-size="14" fill="#111827">${title}</text><rect x="20" y="50" width="60" height="50" rx="4" fill="#6366f1"/></svg>`;
  writeFileSync(join(root, "images", "picture", "chart.svg"), chart("Signups by week"));
  writeFileSync(join(root, "images", "picture", "chart-wide.svg"), chart("Signups by week, wide"));
  writeFileSync(file("picture"), "# Picture\n\nSignups have risen every week.\n\n![Signups by week](images/picture/chart.svg)\n\nAfter.\n");
  server = trackServer(Bun.spawn(["bun", join(repoRoot, "src/index.ts")], {
    // No OpenRouter key: Pi can't run, so nothing reaches a real model (Bun would load the key from `.env`).
    env: { ...process.env, SOLIPSIST_PROJECT_ROOT: root, PORT: String(port), AGENT_CMD: JSON.stringify(["sh", "-c", AGENT]), AGENT_GAP_MS: "100", AGENT_SETTLE_MS: "150", MOCK_COMMENTS: "0", SOLIPSIST_OPENROUTER_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  }));
  try {
    await until("the server", async () => { try { return (await fetch(`${base}/api/pages`)).ok; } catch { return false; } }, 20_000);
  } catch (e: any) {
    const err = await new Response(server.stderr as any).text();
    const out = await new Response(server.stdout as any).text();
    throw new Error(`${e.message}\nexit=${server.exitCode}\nSTDERR:\n${err.slice(0, 1200)}\nSTDOUT:\n${out.slice(0, 800)}`);
  }
  chrome = await launchBrowser(root);
  browser = chrome.browser;
}, 30_000);

/** Pages a test opened: closed after it, pass or fail, so one failure doesn't take the next test down with it. */
const opened: Page[] = [];
afterEach(async () => { for (const p of opened.splice(0)) await p.close().catch(() => {}); });
// The fake agent (behind AGENT_CMD) is the first engine, so it is the page's default.
const newPage = async () => {
  const p = await browser.newPage();
  opened.push(p);
  return p;
};
/** Waits for text on the page, for less than the test's own timeout, so a failure says what was missing. */
const see = (page: Page, text: string) => page.getByText(text).waitFor({ timeout: 8000 });

afterAll(async () => {
  // The server goes first: with it still holding the pages' event streams open, closing the browser could hang (seen
  // once the suite had seven tests).
  server?.kill();
  await server?.exited;
  untrackServer(server);
  await chrome?.close();
  for (const p of spawned()) try { process.kill(p, "SIGKILL"); } catch {}
  rmSync(root, { recursive: true, force: true });
}, 20_000);

async function open(id: string): Promise<Page> {
  const page = await newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(`${id}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${id}: ${e.message}`));
  await page.goto(`${base}/d/${id}`);
  await page.locator(".sheet .ProseMirror").waitFor({ timeout: 8000 });
  return page;
}
const editorText = (page: Page) => page.locator(".sheet .ProseMirror").innerText();
const saveLabel = (page: Page) => page.locator(".topbar .save").first().innerText();

/**
 * Puts the caret right after `text`, through the DOM selection, as a click there would. ProseMirror picks the DOM
 * selection up on selectionchange, but not always the first one after focus (1 run in 30 or so, and the typing then
 * landed at the start of the page): set it until the editor's own selection (Tiptap hangs the editor on its element)
 * agrees.
 */
async function caretAfter(page: Page, text: string) {
  const placed = () => page.evaluate((t) => {
    const ed = document.querySelector<HTMLElement & { editor?: any }>(".sheet .ProseMirror")!;
    const { state } = ed.editor;
    const head = state.selection.head;
    if (ed === document.activeElement && state.doc.textBetween(Math.max(0, head - t.length), head) === t) return true;
    const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    for (let n: Node | null; (n = walk.nextNode()); ) {
      const i = (n as Text).data.indexOf(t);
      if (i < 0) continue;
      ed.focus();
      const r = document.createRange();
      r.setStart(n, i + t.length);
      r.collapse(true);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      return false;
    }
    throw new Error(`not in the page: ${t}`);
  }, text);
  await until(`the caret after ${JSON.stringify(text)}`, placed, 2000);
}

test("the page list opens a page", async () => {
  const page = await newPage();
  await page.goto(base);
  // A page is one of the project's files, so the list names it by its path.
  await page.getByRole("link", { name: "plain.md" }).click();
  await page.waitForURL(`${base}/d/plain`);
  await page.locator(".sheet .ProseMirror").waitFor();
  expect(await editorText(page)).toContain("Second paragraph.");
  await page.close();
}, 20_000);

test("typing saves to the file; a hand edit on disk shows up and the typing is kept; a second tab is refused", async () => {
  const page = await open("plain");
  await caretAfter(page, "Second paragraph.");
  await page.keyboard.type(" Typed.");
  await until("the save", async () => (await saveLabel(page)) === "Saved" && body("plain").includes("Second paragraph. Typed."));

  writeFileSync(file("plain"), readFileSync(file("plain"), "utf8").replace("First paragraph.", "First paragraph, edited on disk.")); await fetch(`${base}/api/dev/changed/plain`, { method: "POST" });
  await until("the hand edit in the page", async () => (await editorText(page)).includes("edited on disk"));
  await page.keyboard.type(" More.");
  await until("both in the file", async () => body("plain") === "# Smoke\n\nFirst paragraph, edited on disk.\n\nSecond paragraph. Typed. More.");

  const second = await newPage();
  await second.goto(`${base}/d/plain`);
  await see(second, "This page is open in another tab.");
  await second.close();
  await page.close();
}, 30_000);

/** The status in the first task record of the page's block (each of these pages has one). */
const status = (id: string) => readFileSync(file(id), "utf8").match(/"status": "([^"]*)"/)?.[1];

/** Where the editor's caret is, as a share of the page (0 at the top, 1 at the end), whether it has focus, and how far the window scrolled. */
const caretNow = (page: Page) => page.evaluate(() => {
  const ed = document.querySelector<HTMLElement & { editor?: any }>(".sheet .ProseMirror")!;
  const { state } = ed.editor;
  return { at: state.selection.head / state.doc.content.size, focused: ed === document.activeElement, scrollY: window.scrollY };
});

for (const decision of ["accepted", "rejected"] as const) {
  test(`${decision} with the hover card, the writer reading far from the caret: the page doesn't jump back to the top`, async () => {
    const id = `caret-${decision}`;
    writeFileSync(file(id), readFileSync(file("caret"), "utf8"));
    const page = await open(id);
    const preview = page.locator('.sheet .sug-preview[data-sug="abc"]');
    await preview.waitFor({ timeout: 8000 });
    // The caret is where the page opened (the start); the writer has scrolled down to the suggestion and hovers it.
    await preview.scrollIntoViewIfNeeded();
    const before = await caretNow(page);
    expect(before.scrollY).toBeGreaterThan(400);
    await preview.hover();
    await page.locator(`.sug-side [data-decision="${decision}"]`).click();
    await until("the decision saved", async () => (await saveLabel(page)) === "Saved" && status(id) === decision);
    await page.waitForTimeout(500);
    const after = await caretNow(page);
    expect(after.scrollY).toBeGreaterThan(before.scrollY - 400);
    expect(after.at).toBeGreaterThan(0.4); // the caret is by the suggestion, not at the top
    await page.close();
  }, 30_000);
}

test("hovering a large suggestion shows its card in the margin, in view however far the diff is scrolled; Accept there works", async () => {
  const page = await open("big");
  await page.setViewportSize({ width: 1400, height: 700 });
  const preview = page.locator('.sheet .sug-preview[data-sug="big"]');
  await preview.waitFor({ timeout: 8000 });
  const side = page.locator(".sug-side");
  const inView = async () => {
    const b = (await side.boundingBox())!;
    const sheet = (await page.locator(".sheet").boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(700);
    expect(b.x).toBeGreaterThanOrEqual(sheet.x + sheet.width); // in the margin, beside the page
    return b.y;
  };
  // Not shown until the pointer is on the diff.
  expect(await side.count()).toBe(0);
  const box = (await preview.boundingBox())!;
  expect(box.height).toBeGreaterThan(1200); // larger than the window
  await page.mouse.move(box.x + 40, box.y + 20);
  await side.waitFor();
  const first = await inView();
  // Scrolled well into the diff, the pointer still on it: the card stays in view.
  for (const by of [500, 500, 500]) {
    await page.mouse.wheel(0, by);
    await page.waitForTimeout(250);
    await page.mouse.move(box.x + 40, 350);
    expect(await side.count()).toBe(1);
    expect(await inView()).toBeLessThan(first);
  }
  // Off the diff (into the page's left margin): it goes; back on it, then on the card: Accept.
  await page.mouse.move(5, 350);
  await side.waitFor({ state: "detached" });
  await page.mouse.move(box.x + 40, 350);
  await side.waitFor();
  await page.locator('.sug-side [data-decision="accepted"]').click();
  await until("the list in the file", async () => body("big").includes("- Risk number 60, said at some length") && (await saveLabel(page)) === "Saved");
  expect(await side.count()).toBe(0);
}, 30_000);

test("vim visual mode on an image: the hint over it, ⌘. asks what to change, and the new image replaces it", async () => {
  const page = await open("picture");
  // The caret on the line above the image, then vim keys on (the vim cursor splits the text node `caretAfter` looks for).
  await caretAfter(page, "Signups have risen every week.");
  await page.locator(".statusbar .sb-mode").click();
  await see(page, "NORMAL");
  await page.keyboard.press("j"); // down to the image's line
  await page.keyboard.press("V"); // and select it
  await see(page, "V-LINE");
  const hint = page.locator(".sheet .img-hint");
  await hint.waitFor({ timeout: 4000 });
  expect(await hint.innerText()).toContain("Change this image");
  expect(await page.locator(".sheet img.img-target").count()).toBe(1);

  const ask = page.locator(".task-ask textarea");
  await page.keyboard.press("ControlOrMeta+.");
  await ask.waitFor({ timeout: 2000 });
  expect(await ask.getAttribute("placeholder")).toBe("Change this image…");
  await page.keyboard.type("make the bars horizontal");
  await page.keyboard.press("Enter");
  await ask.waitFor({ state: "detached", timeout: 2000 });
  await until("the request around the image in the file", () => /<!-- img:[a-z0-9]{3,6}(:ack)? "make the bars horizontal" -->!\[Signups by week\]\(images\/picture\/chart\.svg\)<!-- \/img:[a-z0-9]{3,6}(:ack)? -->/.test(body("picture")));

  const preview = page.locator(".sheet .sug-preview img");
  await preview.waitFor({ timeout: 10000 });
  expect(await preview.getAttribute("src")).toBe("/api/assets/images/picture/chart-wide.svg");
  expect(await page.locator(".sheet img.sug-old").count()).toBe(1); // the old one, dimmed where it is
  await preview.click();
  await page.locator('.sug-card [data-decision="accepted"]').click();
  await until("the new image in the file", async () => body("picture") === "# Picture\n\nSignups have risen every week.\n\n![Signups by week, bars on their side](images/picture/chart-wide.svg)\n\nAfter." && (await saveLabel(page)) === "Saved");
}, 40_000);

test("vim Ctrl-d / Ctrl-u scroll half a screen and move the caret with the page, in normal and visual mode", async () => {
  writeFileSync(file("halfpage"), "# Half\n\n" + Array.from({ length: 120 }, (_, i) => `Line number ${i}.`).join("\n\n") + "\n");
  const page = await open("halfpage");
  await caretAfter(page, "Line number 0.");
  await page.locator(".statusbar .sb-mode").click();
  await see(page, "NORMAL");
  const state = () => page.evaluate(() => {
    const ed = document.querySelector<HTMLElement & { editor?: any }>(".sheet .ProseMirror")!;
    const sel = ed.editor.state.selection;
    const top = ed.editor.view.coordsAtPos(sel.head).top;
    const sc = [...document.querySelectorAll<HTMLElement>("*")].find((e) => e.scrollTop > 0 && e.scrollHeight > e.clientHeight);
    return { head: sel.head, anchor: sel.anchor, top, scroll: Math.max(window.scrollY, sc?.scrollTop ?? 0), h: window.innerHeight };
  });
  const a = await state();
  await page.keyboard.press("Control+d");
  const b = await state();
  expect(b.head).toBeGreaterThan(a.head);
  expect(Math.abs(b.scroll - a.h / 2)).toBeLessThan(a.h / 8);
  expect(Math.abs(b.top - a.top)).toBeLessThan(a.h / 8); // the caret kept its place on screen
  await page.keyboard.press("Control+u");
  const c = await state();
  expect(c.head).toBeLessThan(b.head);
  expect(c.scroll).toBeLessThan(b.scroll);
  expect(await editorText(page)).toContain("Line number 119."); // Ctrl-d did not delete anything
  await page.keyboard.press("v");
  await page.keyboard.press("Control+d");
  const d = await state();
  expect(d.anchor).toBe(c.head);
  expect(d.head).toBeGreaterThan(c.head);
}, 40_000);

test("a block that arrives gets a green line; hovering it shows a cross that deletes the block", async () => {
  writeFileSync(file("lines"), "# Lines\n\nFirst paragraph.\n");
  const page = await open("lines");
  // Edit by hand once the page has settled (its first save made the file canonical), as a writer in another editor would.
  await until("the page settled", async () => (await saveLabel(page)) === "Saved" && readFileSync(file("lines"), "utf8").includes("solip-comments"));
  writeFileSync(file("lines"), readFileSync(file("lines"), "utf8").replace("First paragraph.", "First paragraph.\n\nAdded from outside.")); await fetch(`${base}/api/dev/changed/lines`, { method: "POST" });
  const block = page.locator(".sheet .ProseMirror .new-block", { hasText: "Added from outside." });
  await block.waitFor({ timeout: 8000 }).catch(async (e) => { throw new Error(`${e.message}\npage: ${JSON.stringify(await editorText(page))}\nfile: ${JSON.stringify(body("lines"))}`); });
  // The line grows in (0.4 s): until then it is shorter than the block, as a writer would never notice.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const box = (await block.boundingBox())!;
  const sheet = (await page.locator(".sheet").boundingBox())!;
  // The line sits in the page's right margin, level with the block; the cross shows at its top on hover.
  const lineX = sheet.x + sheet.width - 4; // the line ends 1px inside the page's padding, 3px wide, then the 1px border
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  expect(await page.locator(".new-block-hover").count()).toBe(0);
  await page.mouse.move(lineX, box.y + box.height - 2);
  await page.locator(".new-block-hover").waitFor({ timeout: 2000 });
  if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "line-hover.png") });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".new-block-hover")!, "::before").backgroundColor)).toMatch(/^rgb\(/);
  await page.mouse.move(lineX, box.y + 6); // the top of the line is not the cross
  await page.mouse.down(); await page.mouse.up();
  expect(body("lines")).toContain("Added from outside");
  await page.mouse.click(sheet.x + sheet.width + 7, box.y + 8); // the cross, just right of the page's edge
  await until("the block gone from the page and the file", async () => !(await editorText(page)).includes("Added from outside") && !body("lines").includes("Added from outside"));
  expect(body("lines")).toBe("# Lines\n\nFirst paragraph.");
}, 30_000);

test("dismissing one new block keeps the green lines of the others, as they move up", async () => {
  writeFileSync(file("three"), "# Three\n\nFirst paragraph.\n");
  const page = await open("three");
  await until("the page settled", async () => (await saveLabel(page)) === "Saved" && readFileSync(file("three"), "utf8").includes("solip-comments"));
  writeFileSync(file("three"), readFileSync(file("three"), "utf8").replace("First paragraph.", "First paragraph.\n\nAdded one.\n\nAdded two.\n\nAdded three.")); await fetch(`${base}/api/dev/changed/three`, { method: "POST" });
  const lines = page.locator(".sheet .ProseMirror .new-block");
  await until("three green lines", async () => (await lines.count()) === 3);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const two = (await lines.filter({ hasText: "Added two." }).boundingBox())!;
  const sheet = (await page.locator(".sheet").boundingBox())!;
  await page.mouse.move(sheet.x + sheet.width - 4, two.y + two.height / 2);
  await page.locator(".new-block-hover", { hasText: "Added two." }).waitFor({ timeout: 2000 });
  await page.mouse.click(sheet.x + sheet.width + 7, two.y + 8);
  await until("the block gone from the file", async () => body("three") === "# Three\n\nFirst paragraph.\n\nAdded one.\n\nAdded three.");
  expect(await lines.allInnerTexts()).toEqual(["Added one.", "Added three."]);
  // "Added three." moved up into the gap: its line is still level with it.
  const three = (await lines.filter({ hasText: "Added three." }).boundingBox())!;
  expect(three.y).toBeLessThan(two.y + two.height);
}, 30_000);

test("Copy page puts the page's own text on the clipboard: markdown without markers or comments, and HTML with the SVG embedded as PNG", async () => {
  writeFileSync(file("copy"), [
    "# Copy",
    "",
    "Before <!-- gen:cpy --> after.",
    "",
    'Some <!-- sel:cps "make it shorter" -->chosen text<!-- /sel:cps --> here. A note <!-- to myself --> inline.',
    "",
    "<!-- a block note -->",
    "",
    "| Team | Date |",
    "| --- | --- |",
    "| Web | 3 Sep |",
    "",
    "![Signups by week](images/picture/chart.svg)",
    "",
  ].join("\n"));
  const page = await open("copy");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  // Unsaved typing is copied too: the copy is of the editor, not of the file.
  await caretAfter(page, "Web");
  await page.keyboard.type(" team");
  const button = page.getByRole("button", { name: "Copy page as markdown" });
  await button.click();
  await until("the button to say Copied", async () => (await button.getAttribute("class"))!.includes("copied"));
  expect(await button.getAttribute("title")).toBe("Copied");
  const clip = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { types: [...item!.types], plain: await (await item!.getType("text/plain")).text(), html: await (await item!.getType("text/html")).text() };
  });
  expect(clip.types.sort()).toEqual(["text/html", "text/plain"]);
  expect(clip.plain).toBe("# Copy\n\nBefore after.\n\nSome chosen text here. A note inline.\n\n| Team | Date |\n| --- | --- |\n| Web team | 3 Sep |\n\n![Signups by week](images/picture/chart.svg)");
  expect(clip.html).toContain("<table");
  expect(clip.html).toContain("Web team");
  expect(clip.html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]{100,}"/);
  expect(clip.html).not.toContain("<!--");
  expect(clip.html).not.toContain("make it shorter");
}, 30_000);

test("no page logged an error", () => {
  expect(errors).toEqual([]);
});
