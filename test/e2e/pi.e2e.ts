// Pi in a real browser: the app's server with Pi on a scripted model (`pi-server.ts`), the installed Chrome via
// Playwright. Page review is here because the margin it lands in is laid out against the sheet; everything else Pi does
// is tested in `test/e2e-dom/pi.dom.tsx`. Part of `bun run test:ui`. `E2E_VIDEO=<dir>` records a video of each page,
// slowed down to watch.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { launchBrowser, trackServer, untrackServer, type E2EBrowser, testPort } from "./leftovers";
import { parseFile } from "../../src/shared/docfile";
import { REVIEW_QUOTE } from "./review-quote";

/** The repo: the tests run in a scratch project, so the server is started by its full path. */
const repoRoot = join(import.meta.dir, "..", "..");

const root = mkdtempSync(join(tmpdir(), "solip-e2e-pi-"));
const docs = join(root, ".solipsist", "pages");
const port = testPort(4100);
const base = `http://localhost:${port}`;
const file = (id: string) => join(docs, `${id}.md`);
const body = (id: string) => parseFile(readFileSync(file(id), "utf8")).markdown;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  for (const t = Date.now(); !(await ok()); await wait(50)) if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
}

/** Where videos go, if they are wanted. */
const videos = process.env.E2E_VIDEO;
let server: ReturnType<typeof Bun.spawn>;
/** Its Chrome, which goes when this run does, however the run ends (`browser.ts`). */
let chrome: E2EBrowser;
let browser: Browser;
let log = "";
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(docs, { recursive: true });
  mkdirSync(join(root, "pi"), { recursive: true });
  writeFileSync(file("reading"), `# Reading\n\n${REVIEW_QUOTE}\n`);
  server = trackServer(Bun.spawn(["bun", join(repoRoot, "test/e2e/pi-server.ts")], {
    // No keys: only the scripted Pi can run. Kept agents wait for the whole suite.
    env: {
      ...process.env, SOLIPSIST_PROJECT_ROOT: root, PORT: String(port), E2E_ROOT: root, PI_CODING_AGENT_DIR: join(root, "pi"),
      AGENT_GAP_MS: "100", AGENT_SETTLE_MS: "150", AGENT_WAIT_MS: "120000", MOCK_COMMENTS: "0", SOLIPSIST_OPENROUTER_KEY: "", AGENT_CMD: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  }));
  void (async () => { for await (const chunk of server.stderr as ReadableStream<Uint8Array>) log += new TextDecoder().decode(chunk); })();
  await until("the server", async () => { try { return (await fetch(`${base}/api/pages`)).ok; } catch { return false; } }, 20_000).catch((e) => { throw new Error(`${e.message}\n${log}`); });
  chrome = await launchBrowser(root, videos ? { slowMo: 120 } : {});
  browser = chrome.browser;
}, 30_000);

/** Pages a test opened, each in its own context (so each gets its own video): closed after it, pass or fail. */
const opened: { page: Page; context: BrowserContext; name: string }[] = [];
afterEach(async () => {
  for (const o of opened.splice(0)) {
    if (videos && !o.page.isClosed()) await o.page.waitForTimeout(1200); // the end of the scene, in a video
    await o.context.close().catch(() => {});
    if (videos) await o.page.video()?.saveAs(join(videos, `${o.name}.webm`)).catch(() => {});
  }
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  untrackServer(server);
  await chrome?.close();
  rmSync(root, { recursive: true, force: true });
}, 20_000);

let pages = 0;
async function open(id: string): Promise<Page> {
  const context = await browser.newContext(videos ? { recordVideo: { dir: join(root, "video"), size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } } : {});
  const page = await context.newPage();
  opened.push({ page, context, name: `${String(++pages).padStart(2, "0")}-${id}` });
  await page.addInitScript(() => localStorage.setItem("solip-agent-model", "pi:~deepseek/deepseek-flash-latest"));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(`${id}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${id}: ${e.message}`));
  await page.goto(`${base}/d/${id}`);
  await page.locator(".sheet .ProseMirror").waitFor({ timeout: 8000 });
  return page;
}
/** A pause to see what just happened, in a video only. */
const beat = (page: Page, ms = 1200) => (videos ? page.waitForTimeout(ms) : Promise.resolve());

/**
 * The Reader, the whole way, in a real browser: the writer clicks Page review in the
 * status bar, the agent's question lands in the margin beside the sentence it is about, the card opens, and Dismiss
 * takes it down for good. Nothing of the writer's text changes — the agent has no tool that could change it.
 *
 * The browser is what this has to be run in: the margin is laid out against the sheet and hidden when there is no
 * room for it, so a question can be placed, saved and still never reach the writer. That is what happened, and no
 * other test could see it.
 */
test("Page review: the question arrives in the margin, opens, and Dismiss takes it down", async () => {
  const page = await open("reading");
  const quote = REVIEW_QUOTE;
  expect(await page.locator(".sheet .ProseMirror").innerText()).toContain(quote);

  const button = page.locator(".statusbar .review-page");
  expect(await button.innerText()).toContain("Page review");
  await beat(page);
  await button.click();

  // Not the passing "Reviewing…" itself — a review refused by a limit is over before it could be read, and the DOM
  // suite pins that state without a browser's timing. What matters here is the question arriving, and the button's
  // title says why if it does not.
  const card = page.locator(".margin .card").first();
  await until(
    "the question in the margin",
    async () => (await card.count()) > 0,
    25_000,
  ).catch(async (e) => { throw new Error(`${e.message}\nthe button says: ${await button.getAttribute("title")}`); });
  await beat(page);
  // The margin is laid out beside the sheet, and the card is really on screen, not merely in the DOM.
  expect(await card.isVisible()).toBe(true);
  const box = await card.boundingBox();
  expect(box!.width).toBeGreaterThan(80);
  // Closed, the card is the gloss: a reader's pencil note beside the passage.
  expect(await card.innerText()).toContain("how soon is soon?");
  // The passage it is about is highlighted, on the words the agent quoted.
  const hl = page.locator(".sheet [data-comment]").first();
  expect(await hl.innerText()).toContain("soon");

  // The writer's text is untouched: a review has no `suggest`, so there is nothing it could have written.
  expect(body("reading")).toBe(`# Reading\n\n${quote}`);

  // The first call quoted something not in the page: the in-turn check sent it back and the model fixed it, in the
  // same run, so the writer only ever saw the good question.
  await until("the model was asked twice, the second time after an error", () => {
    const rs = readFileSync(join(root, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.task === "?");
    return rs.length >= 2 && rs.some((r) => r.failed);
  }, 10_000);

  // The card is the gloss alone; the question opens in a window of its own.
  await card.click();
  const modal = page.locator(".comment-modal");
  await modal.waitFor({ timeout: 8000 });
  await beat(page);
  expect(await modal.innerText()).toContain("What does “soon” mean here, in days?");
  expect(await modal.innerText()).toContain("The date carries the plan");
  // On a laptop-sized window the margin is too narrow to hang beside the passage: it opens under it, whole on screen, joined by a line.
  {
    await page.setViewportSize({ width: 1280, height: 800 });
    await beat(page);
    const box = (await modal.boundingBox())!, hlBox = (await hl.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y).toBeGreaterThanOrEqual(hlBox.y + hlBox.height - 2);
    expect(await page.locator(".margin .comment-link path").count()).toBe(1);
    expect(await modal.getAttribute("class")).toContain("anchored");
  }
  // The passage it is about, and who asked: the reviewer and the model it ran on.
  expect(await modal.locator(".comment-passage").innerText()).toContain("soon");
  expect(await modal.locator(".comment-by").innerText()).toContain("reviewer");
  // No Accept and no Reject: nothing was put in the page, so there is nothing to accept.
  expect(await modal.locator("footer button").allInnerTexts()).toContain("Dismiss");
  expect(await modal.locator("footer button").allInnerTexts()).not.toContain("Accept");

  await modal.locator("footer button", { hasText: "Dismiss" }).click();
  await beat(page);
  await until("the card is gone from the margin", async () => (await page.locator(".margin .card").count()) === 0, 8000);
  await until("and the file says it was dismissed", () => /"status": "dismissed"/.test(readFileSync(file("reading"), "utf8")), 8000);
  // The body is still the writer's, byte for byte, after all of it.
  expect(body("reading")).toBe(`# Reading\n\n${quote}`);
}, 60_000);

test("no page logged an error", () => {
  expect(errors).toEqual([]);
});
