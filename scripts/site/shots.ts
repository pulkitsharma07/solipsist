// Draws the documentation's pictures, light and dark, into site/src/assets/shots/<name>-<theme>.png: parts of the
// app from FEATURES.html (its components rendered with sample data, styled by the app's CSS) and the landing page's
// diagram from site/src/landing.html. Run `bun run features` and `bun run site` first if either is stale, then
// `bun run site:shots`, and commit the pictures. Real Chrome via Playwright, as `bun run test:ui` uses
// (`E2E_CHANNEL` picks another).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";

const root = join(import.meta.dir, "../..");
const out = join(root, "site/src/assets/shots");
const FEATURES = pathToFileURL(join(root, "FEATURES.html")).href;
const LANDING = pathToFileURL(join(root, "site/src/landing.html")).href;

/** A picture: a part of FEATURES.html (its entry's id and which of its specimens, from 0), or a landing selector. */
/**
 * `whole`: the part is wider than its stage in FEATURES.html (the status bar), so the stage is widened to fit it first.
 * `parts`: a selector; where each match sits in the picture (CSS pixels) is written to <name>-parts.json beside it, for
 * a diagram that numbers them (the status bar's, `site/src/components/StatusBarMap.astro`).
 */
type Shot = { name: string; whole?: boolean; parts?: string } & ({ entry: string; spec: number } | { landing: string });

const SHOTS: Shot[] = [
  { name: "how-it-works", landing: ".l-flow" },
  { name: "setup-dialog", entry: "setup-dialog", spec: 0 },
  { name: "connect-model", entry: "connect-model", spec: 0 },
  { name: "topbar-saved", entry: "topbar", spec: 0 },
  { name: "sync-changed", entry: "sync-dialog", spec: 0 },
  { name: "point-waiting", entry: "placeholder-point", spec: 0 },
  { name: "range-working", entry: "placeholder-range", spec: 1 },
  { name: "instruction", entry: "instruction-input", spec: 1 },
  { name: "image-selected", entry: "placeholder-image", spec: 0 },
  { name: "image-suggested", entry: "placeholder-image", spec: 3 },
  { name: "chip-declined", entry: "suggestion-chips", spec: 0 },
  { name: "chip-answered", entry: "suggestion-chips", spec: 1 },
  { name: "pill-waiting", entry: "agent-note", spec: 0 },
  { name: "pill-working", entry: "agent-note", spec: 1 },
  { name: "pill-done", entry: "agent-note", spec: 3 },
  { name: "pill-snoozed", entry: "agent-note", spec: 5 },
  { name: "pill-chat", entry: "agent-note", spec: 6 },
  { name: "pill-accepted", entry: "agent-note", spec: 8 },
  { name: "preview-replace", entry: "suggestion-preview", spec: 2 },
  { name: "preview-blocks", entry: "suggestion-preview", spec: 1 },
  { name: "card", entry: "suggestion-card", spec: 0 },
  { name: "card-edits", entry: "suggestion-card", spec: 1 },
  { name: "suggestion-count", entry: "suggestion-count", spec: 0 },
  { name: "button-fits", entry: "accept-as-button", spec: 0 },
  { name: "button-popup", entry: "accept-as-button", spec: 3 },
  { name: "button-scheduled", entry: "task-button", spec: 1 },
  { name: "button-schedule-menu", entry: "task-button", spec: 2 },
  { name: "review-open", entry: "page-review", spec: 0 },
  { name: "review-margin", entry: "page-review", spec: 1 },
  { name: "chat-window", entry: "chat-window", spec: 0 },
  { name: "chat-page", entry: "chat-window", spec: 1 },
  { name: "chat-tools", entry: "chat-window", spec: 2 },
  { name: "debug-panel", entry: "debug-panel", spec: 0 },
  { name: "debug-off", entry: "debug-panel", spec: 1 },
  { name: "status-bar", entry: "status-bar", spec: 0, whole: true, parts: ".sb-item" },
  { name: "status-bar-vim", entry: "status-bar", spec: 1, whole: true },
  { name: "vim-normal", entry: "vim", spec: 0 },
  { name: "settings-prompts", entry: "settings-prompts", spec: 0 },
  { name: "settings-loaded", entry: "settings-loaded", spec: 0 },
  { name: "html-comment", entry: "html-comment", spec: 0 },
];

async function shoot(page: Page, shot: Shot, theme: "light" | "dark") {
  const el = "entry" in shot
    ? page.locator(`#${shot.entry} .f-spec`).nth(shot.spec).locator(".f-stage")
    : page.locator(shot.landing).first();
  if ((await el.count()) === 0) throw new Error(`shots: ${shot.name} found nothing to draw`);
  if (shot.whole) await el.evaluate((n) => { (n as HTMLElement).style.width = "max-content"; });
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: join(out, `${shot.name}-${theme}.png`), animations: "disabled" });
  if (shot.parts && theme === "light") {
    const map = await el.evaluate((n, sel) => {
      const r = n.getBoundingClientRect();
      const parts = [...n.querySelectorAll(sel)].map((e) => {
        const b = e.getBoundingClientRect();
        return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height, text: e.textContent?.trim() ?? "" };
      });
      return { width: r.width, height: r.height, parts };
    }, shot.parts);
    writeFileSync(join(out, `${shot.name}-parts.json`), JSON.stringify(map, null, 2) + "\n");
  }
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
try {
  for (const theme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    // FEATURES.html in a wide window, so a widened stage (`whole`) still fits on screen; its column is no wider for it.
    for (const [url, width, mine] of [[FEATURES, 1920, (s: Shot) => "entry" in s], [LANDING, 1280, (s: Shot) => "landing" in s]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      for (const shot of SHOTS.filter(mine)) await shoot(page, shot, theme);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`site/src/assets/shots: ${SHOTS.length * 2} pictures`);
