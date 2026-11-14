// The ask for support: counted per day of saving, shown after support.after_days, put off by Later, stopped by paid.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AGAIN_DAYS, answer, countDay, noteSave, shouldAsk, supportView } from "../src/server/support";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const BUY = "https://example.com/buy";
let dir = "";
const before = { dir: process.env.SOLIPSIST_SUPPORT_DIR, after: process.env.SOLIPSIST_SUPPORT_AFTER_DAYS };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "solip-support-"));
  process.env.SOLIPSIST_SUPPORT_DIR = dir;
  process.env.SOLIPSIST_SUPPORT_AFTER_DAYS = "3";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.SOLIPSIST_SUPPORT_DIR = before.dir;
  if (before.after === undefined) delete process.env.SOLIPSIST_SUPPORT_AFTER_DAYS;
  else process.env.SOLIPSIST_SUPPORT_AFTER_DAYS = before.after;
});

const day = (n: number) => new Date(2026, 10, n, 12);

test("a day counts once, however many saves", () => {
  const s = countDay(countDay({ days: 0 }, "2026-11-01"), "2026-11-01");
  expect(s).toEqual({ days: 1, last: "2026-11-01" });
  expect(countDay(s, "2026-11-02").days).toBe(2);
});

test("asks only after the days, with somewhere to buy, and not once paid or turned off", () => {
  expect(shouldAsk({ days: 2 }, 3, BUY)).toBe(false);
  expect(shouldAsk({ days: 3 }, 3, BUY)).toBe(true);
  expect(shouldAsk({ days: 3 }, 3, "")).toBe(false);
  expect(shouldAsk({ days: 3 }, 0, BUY)).toBe(false);
  expect(shouldAsk({ days: 30, paid: true }, 3, BUY)).toBe(false);
});

test("Later puts it off for AGAIN_DAYS more days of writing", () => {
  expect(shouldAsk({ days: 5, later: 5 }, 3, BUY)).toBe(false);
  expect(shouldAsk({ days: 5 + AGAIN_DAYS - 1, later: 5 }, 3, BUY)).toBe(false);
  expect(shouldAsk({ days: 5 + AGAIN_DAYS, later: 5 }, 3, BUY)).toBe(true);
});

test("saves on three days show it; Later hides it; paid stops it", () => {
  noteSave(day(1)); noteSave(day(1)); noteSave(day(2));
  expect(supportView(BUY)).toEqual({ show: false, days: 2, url: BUY });
  noteSave(day(3));
  expect(supportView(BUY).show).toBe(true);
  expect(supportView("").show).toBe(false);
  answer("later");
  expect(supportView(BUY).show).toBe(false);
  for (let d = 4; d < 4 + AGAIN_DAYS; d++) noteSave(day(d));
  expect(supportView(BUY).show).toBe(true);
  answer("paid");
  noteSave(day(20));
  expect(supportView(BUY)).toEqual({ show: false, days: 3 + AGAIN_DAYS + 1, url: BUY });
});

test("the strip says how long, links to the shop, and offers both answers", async () => {
  const { SupportNudge } = await import("../src/app/pages/Frame");
  const html = renderToStaticMarkup(<SupportNudge days={14} url={BUY} onLater={() => {}} onPaid={() => {}} />);
  expect(html).toContain("on 14 days");
  expect(html).toContain(`href="${BUY}"`);
  expect(html).toContain("I&#x27;ve bought one");
  expect(html).toContain("Later");
});
