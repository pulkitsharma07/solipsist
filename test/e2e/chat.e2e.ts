// How the chat's log scrolls, in a real browser (it needs layout and a wheel): `test/chat-harness/server.ts` serves the
// modal with a fake agent. What each kind of reply shows is tested in `test/e2e-dom/chat-stream.dom.tsx`, on the same
// agent. Not part of `bun test`: `bun run test:ui`.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchBrowser, trackServer, untrackServer, type E2EBrowser, testPort } from "./leftovers";

const port = testPort(4900);
const base = `http://localhost:${port}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
setDefaultTimeout(30_000);

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;
/** Its Chrome, which goes when this run does, however the run ends (`browser.ts`). */
let chrome: E2EBrowser;
const errors: string[] = [];

beforeAll(async () => {
  server = trackServer(Bun.spawn(["bun", "test/chat-harness/server.ts"], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, PORT: String(port), SPEED: "0.3" }, stdout: "pipe", stderr: "pipe" }));
  for (const t = Date.now(); ; await wait(50)) {
    try { if ((await fetch(base)).ok) break; } catch {}
    if (Date.now() - t > 20_000) throw new Error("the harness didn't start");
  }
  chrome = await launchBrowser(`chat-${port}`);
  browser = chrome.browser;
}, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  untrackServer(server);
  await chrome?.close();
});

const opened: Page[] = [];
afterEach(async () => { for (const p of opened.splice(0)) await p.close().catch(() => {}); });

/** The harness on conversation `task`, ready for the writer to type. */
async function open(task = "empty", viewport = { width: 1200, height: 800 }) {
  const page = await browser.newPage({ viewport });
  opened.push(page);
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?ph=${task}`);
  await page.waitForFunction(() => !(document.querySelector(".chat-compose textarea") as HTMLTextAreaElement | null)?.disabled, null, { timeout: 8000 });
  return page;
}
/** Says `text`, and waits for it to show in the log (so the reply has started). */
async function say(page: Page, text: string) {
  const sent = await page.locator(".chat-msg.user").count();
  const box = page.locator(".chat-compose textarea");
  await box.fill(text);
  await box.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".chat-msg.user").length > n, sent, { timeout: 5000 });
}
/** Opens every finished turn's work fold (they close when a turn ends), as the writer would. */
const unfold = (page: Page) => page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>(".chat-work:not([open])").forEach((d) => { d.open = true; }));
/** The agent is done: not busy, and its reply is the last message, finished. */
const ready = (page: Page) => page.waitForFunction(() => {
  const last = [...document.querySelectorAll(".chat-msg")].at(-1);
  return document.querySelector(".chat-status")?.textContent === "Ready" && !!last?.matches(".assistant:not(.streaming)");
}, null, { timeout: 15_000 });
const busy = (page: Page) => page.waitForFunction(() => document.querySelector(".chat-status")?.textContent !== "Ready", null, { timeout: 5000 });
/** How far the log is from its bottom, in pixels. */
const gap = (page: Page) => page.evaluate(() => { const el = document.querySelector(".chat-log")!; return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight); });
const scrollable = (page: Page) => page.evaluate(() => { const el = document.querySelector(".chat-log")!; return el.scrollHeight > el.clientHeight; });

test("the log follows the reply, holds when the writer scrolls up (even a little), and follows again at the bottom", async () => {
  const page = await open("long");
  expect(await scrollable(page)).toBe(true);
  expect(await gap(page)).toBeLessThan(2);
  await page.mouse.move(600, 400);

  // Many messages in, it still follows.
  for (const text of ["tool", "long", "tools", "think"]) {
    await say(page, text);
    await ready(page);
    expect(await gap(page)).toBeLessThan(2);
  }

  // A trackpad's few pixels up, while a reply streams: the log stays where the writer put it.
  await say(page, "slow");
  await busy(page);
  await wait(300);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -8); await wait(16); }
  await wait(300);
  const held = await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop);
  await wait(600);
  expect(await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop)).toBe(held);
  expect(await gap(page)).toBeGreaterThan(40);

  // A big scroll up holds too; back at the bottom, it follows again.
  await page.mouse.wheel(0, -600);
  await wait(300);
  expect(await gap(page)).toBeGreaterThan(500);
  await page.mouse.wheel(0, 100_000);
  await wait(500);
  expect(await gap(page)).toBeLessThan(2);
  await page.getByRole("button", { name: "Stop" }).click();
  await ready(page);
  expect(await gap(page)).toBeLessThan(2);

  // Scrolled up when the writer sends: their message and the reply come into view.
  await page.mouse.wheel(0, -800);
  await wait(300);
  await say(page, "tools");
  await ready(page);
  expect(await gap(page)).toBeLessThan(2);
}, 60_000);

test("a long conversation: the newest message is reachable, and the writer can read back while a reply streams", async () => {
  const page = await open("long");
  for (const text of ["tools", "reply", "long"]) { await say(page, text); await ready(page); }
  // The end of the log is the end of the conversation: the last message is inside it, not under the box.
  const endGap = () => page.evaluate(() => {
    const log = document.querySelector(".chat-log")!;
    log.scrollTop = log.scrollHeight;
    return Math.round(log.getBoundingClientRect().bottom - log.lastElementChild!.getBoundingClientRect().bottom);
  });
  expect(await endGap()).toBeGreaterThanOrEqual(0);
  expect(await endGap()).toBeLessThan(60);
  // Reading back while a reply streams: the log stays where the writer put it, however many times it renders.
  await page.mouse.move(600, 400);
  await say(page, "slow");
  await busy(page);
  await wait(300);
  await page.mouse.wheel(0, -2000);
  await wait(100);
  const held = await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop);
  expect(held).toBeGreaterThan(0);
  for (let i = 0; i < 3; i++) {
    await wait(500);
    expect(await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop)).toBe(held);
  }
  await page.getByRole("button", { name: "Stop" }).click();
  await ready(page);
}, 60_000);

test("reading back and returning to the end, again and again, while a reply streams: it follows every time", async () => {
  // The log writes its own scroll position several times a second while a reply streams. Reading one of those writes
  // as the writer scrolling up left it stuck above the newest messages, and nothing short of another scroll of their
  // own brought it back; here the round trip is made three times over, with the reply still coming.
  const page = await open("long");
  await page.mouse.move(600, 400);
  await say(page, "slow");
  await busy(page);
  for (let i = 0; i < 3; i++) {
    await wait(250);
    await page.mouse.wheel(0, -900);
    await wait(250);
    expect(await gap(page)).toBeGreaterThan(300);
    await page.mouse.wheel(0, 100_000);
    await wait(400);
    expect(await gap(page)).toBeLessThan(2);
    // And it goes on following as the reply comes in.
    await wait(400);
    expect(await gap(page)).toBeLessThan(2);
  }
  await page.getByRole("button", { name: "Stop" }).click();
  await ready(page);
  expect(await gap(page)).toBeLessThan(2);
}, 60_000);

test("the echo of the log's own scroll, arriving after the writer's wheel up, doesn't take the log back down", async () => {
  // The order a busy frame can deliver: the log writes its scroll position, the writer wheels up, and only then does
  // the browser report the log's own write (still at the end) before the smooth scroll moves. That late report used to
  // turn following back on, and the next word streamed in snapped the log back to the bottom.
  const page = await open("long");
  await page.mouse.move(600, 400);
  await say(page, "slow");
  await busy(page);
  await wait(250);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".chat-log")!;
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -900 }));
    el.dispatchEvent(new Event("scroll"));
    el.scrollTop = Math.max(0, el.scrollTop - 900);
  });
  await wait(400);
  expect(await gap(page)).toBeGreaterThan(300);
  await page.getByRole("button", { name: "Stop" }).click();
  await ready(page);
});

test("scrolling the log never scrolls the page behind it", async () => {
  const page = await open("long");
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, 100_000);
  await wait(300);
  await page.mouse.wheel(0, -100_000);
  await wait(300);
  await page.mouse.wheel(0, -2000);
  await wait(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop)).toBe(0);
});

test("opening a thinking or tool block doesn't throw the log to the bottom", async () => {
  const page = await open("long");
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, -1500);
  await wait(300);
  await unfold(page);
  const tool = page.locator(".chat-tool").nth(3);
  await tool.locator("summary").scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop);
  await tool.locator("summary").click();
  await wait(200);
  expect(await tool.locator(".chat-tool-result").isVisible()).toBe(true);
  expect(await page.evaluate(() => document.querySelector(".chat-log")!.scrollTop)).toBe(before);
});

test("narrow screens: the modal fills it, the log scrolls, the input stays in view", async () => {
  const page = await open("long", { width: 390, height: 700 });
  const box = await page.locator(".chat-modal").boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const input = (await page.locator(".chat-compose textarea").boundingBox())!;
  expect(input.y + input.height).toBeLessThanOrEqual(700);
  await say(page, "long");
  await ready(page);
  expect(await gap(page)).toBeLessThan(2);
});

test("no page errors", () => expect(errors).toEqual([]));
