/**
 * The nudge to buy a licence. Honour system: nothing is locked, nothing is sent
 * anywhere. The server counts the days on which a page was saved, in `support.json` in `support.dir`, and
 * after `support.after_days` of them the page shows a strip asking for support. "Later" asks again after AGAIN_DAYS
 * more; "I've bought one" stops it for good.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

/** Where "Buy a licence" goes. Empty: there is nothing to buy yet, so the strip is never shown. */
export const BUY_URL = "";
/** Active days between a "Later" and the next ask. */
export const AGAIN_DAYS = 7;

export interface SupportState {
  /** Distinct days with at least one save. */
  days: number;
  /** The last of them, `YYYY-MM-DD` in local time. */
  last?: string;
  /** `days` when the writer last chose Later. */
  later?: number;
  /** The writer says they bought one. */
  paid?: boolean;
}

export interface SupportView { show: boolean; days: number; url: string }

const today = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Pure: whether the strip shows. */
export function shouldAsk(s: SupportState, afterDays: number, url: string): boolean {
  if (s.paid || !url || afterDays <= 0 || s.days < afterDays) return false;
  return s.later === undefined || s.days >= s.later + AGAIN_DAYS;
}

/** Pure: the state after a save on `day`. */
export const countDay = (s: SupportState, day: string): SupportState => (s.last === day ? s : { ...s, days: s.days + 1, last: day });

const fileOf = () => join(config().support.dir, "support.json");

function read(): SupportState {
  try {
    const s = JSON.parse(readFileSync(fileOf(), "utf8"));
    return typeof s?.days === "number" ? s : { days: 0 };
  } catch {
    return { days: 0 };
  }
}

function write(s: SupportState) {
  const file = fileOf();
  mkdirSync(config().support.dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s) + "\n");
  renameSync(tmp, file);
}

/** The day last counted, so a save on a day already counted touches no file. Keyed by the file, for tests. */
let seen: { file: string; day: string } | null = null;

/** After a save: counts today if it isn't yet. Never throws (a nudge must not fail a save). */
export function noteSave(now = new Date()) {
  try {
    const file = fileOf();
    const day = today(now);
    if (seen?.file === file && seen.day === day) return;
    const s = read();
    const next = countDay(s, day);
    if (next !== s) write(next);
    seen = { file, day };
  } catch {}
}

export function supportView(url = BUY_URL): SupportView {
  const s = read();
  return { show: shouldAsk(s, config().support.after_days, url), days: s.days, url };
}

/** The writer's answer to the strip. */
export function answer(action: "later" | "paid") {
  const s = read();
  write(action === "paid" ? { ...s, paid: true } : { ...s, later: s.days });
}
