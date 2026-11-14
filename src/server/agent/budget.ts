import { closeSync, openSync, readSync } from "node:fs";
import type { AgentEngine } from "./engine";
import { config } from "../config";
import { log, logFile } from "../log";
import { runtime } from "../runtime";

/**
 * What the agents have cost, against three limits (each optional): `agent.cost_limit_usd` since the server started,
 * `agent.cost_limit_day_usd` today and `agent.cost_limit_month_usd` this month (local time; 0 is no limit). Every run
 * and every chat reply adds what it cost. Once a limit is reached no new run starts, on any page (a run in flight
 * finishes, and the chat still answers); the debug panel and the terminal view say why.
 *
 * The day and month survive a restart by being rebuilt from the log: the first time they are needed the server sums
 * the `costUsd` of its logged runs and replies for the current day and month (`spentFromLog`), then counts in memory,
 * rolling over when the date changes. With no log (off, missing, unreadable) they count from zero.
 *
 * None of that can bound an engine that never says what a run cost (`AgentEngine.reportsCost`): its runs would pass
 * every dollar limit untouched. Those are counted instead, against `agent.max_unmetered_runs_day`
 * (`noteUnmeteredRun`, `overRuns`). Counting follows what a run reported (no figure: counted), so the live counter
 * and the log agree across a restart; whether the bound applies follows what the engine declares.
 */

/** The since-start limit in dollars, or null for none. */
export function costLimit(): number | null {
  return config().agent.cost_limit_usd ?? null;
}

/** The limits as set: 0 or unset is null. */
const lim = (n: number | undefined) => (n && n > 0 ? n : null);
export const dayLimit = () => lim(config().agent.cost_limit_day_usd);
export const monthLimit = () => lim(config().agent.cost_limit_month_usd);
/** How many runs that cost nobody can see may happen in one day (`agent.max_unmetered_runs_day`); null for none. */
export const unmeteredRunLimit = () => lim(config().agent.max_unmetered_runs_day);

const pad = (n: number) => String(n).padStart(2, "0");
export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const dayKey = (d: Date) => `${monthKey(d)}-${pad(d.getDate())}`;

const COST_ACTIONS = new Set(["run.end", "chat.reply", "pichat.reply"]);

/** Calls `each` with every line of a file, reading it in chunks (a log can be big). A missing file has no lines. */
function eachLine(file: string, each: (line: string) => void) {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let rest = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      let data = Buffer.concat([rest, buf.subarray(0, n)]);
      let at: number;
      while ((at = data.indexOf(10)) >= 0) { each(data.toString("utf8", 0, at)); data = data.subarray(at + 1); }
      rest = Buffer.from(data);
    }
    if (rest.length) each(rest.toString("utf8"));
  } catch { /* a read error ends the file */ } finally { try { closeSync(fd); } catch {} }
}

/**
 * What the log at `file` (and `file.1`, the rotated one) says was spent in the day and month of `now`: the sum of
 * `costUsd` over its `run.end`, `chat.reply` and `pichat.reply` lines. Lines that aren't JSON, have no usable time
 * or cost, or belong to another action are skipped.
 */
export function spentFromLog(file: string, now = new Date()): { day: number; month: number } {
  const out = { day: 0, month: 0 };
  const mk = monthKey(now), dk = dayKey(now);
  for (const f of [`${file}.1`, file]) {
    eachLine(f, (line) => {
      if (!line.includes('"costUsd"')) return; // most lines: no JSON parse
      let o: any;
      try { o = JSON.parse(line); } catch { return; }
      if (!o || !COST_ACTIONS.has(o.action) || typeof o.costUsd !== "number" || !Number.isFinite(o.costUsd) || o.costUsd <= 0) return;
      const t = new Date(o.t);
      if (typeof o.t !== "string" || Number.isNaN(t.getTime()) || monthKey(t) !== mk) return;
      out.month += o.costUsd;
      if (dayKey(t) === dk) out.day += o.costUsd;
    });
  }
  return out;
}

/** The day and month counters, rebuilt from the log the first time and reset when the date has moved on. */
export function counters(now = new Date()) {
  const b = runtime().budget;
  const mk = monthKey(now), dk = dayKey(now);
  if (!b.day || !b.month) {
    const file = logFile();
    const past = file ? spentFromLog(file, now) : { day: 0, month: 0 };
    b.day = { key: dk, spent: past.day };
    b.month = { key: mk, spent: past.month };
  } else {
    if (b.month.key !== mk) b.month = { key: mk, spent: 0 };
    if (b.day.key !== dk) b.day = { key: dk, spent: 0 };
  }
  return { day: b.day, month: b.month };
}

/** Adds what a run or a reply cost (nothing for an unknown or nonsense cost). */
export function spend(usd: unknown, now = new Date()) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return;
  const c = counters(now); // first: a first call rebuilds from the log, which doesn't hold this cost yet
  const b = runtime().budget;
  b.spent += usd;
  c.day.spent += usd;
  c.month.spent += usd;
  const hit = reached(now);
  if (hit && !b.reported) {
    b.reported = true;
    log("budget.reached", { limit: hit.name, spentUsd: hit.spent, limitUsd: hit.limit, sinceStartUsd: b.spent, todayUsd: c.day.spent, monthUsd: c.month.spent });
  } else if (!hit) b.reported = false; // a new day or a raised limit: the next time is news again
}

/** The first limit that is reached, with what has been spent against it. */
function reached(now = new Date()): { name: "since_start" | "day" | "month"; spent: number; limit: number } | null {
  const b = runtime().budget, c = counters(now);
  const start = costLimit(), d = dayLimit(), m = monthLimit();
  if (start !== null && b.spent >= start) return { name: "since_start", spent: b.spent, limit: start };
  if (d !== null && c.day.spent >= d) return { name: "day", spent: c.day.spent, limit: d };
  if (m !== null && c.month.spent >= m) return { name: "month", spent: c.month.spent, limit: m };
  return null;
}

export const spentUsd = () => runtime().budget.spent;
/** Whether no new run may start, for want of money. */
export const overBudget = (now = new Date()) => reached(now) !== null;

/**
 * How many runs the log at `file` (and `file.1`, the rotated one) records for the day of `now` that reported no cost:
 * its `run.end` lines carrying `costUnknown`. Lines that aren't JSON, have no usable time, or belong to another
 * action are skipped.
 */
export function unmeteredFromLog(file: string, now = new Date()): number {
  let n = 0;
  const dk = dayKey(now);
  for (const f of [`${file}.1`, file]) {
    eachLine(f, (line) => {
      if (!line.includes('"costUnknown"')) return; // most lines: no JSON parse
      let o: any;
      try { o = JSON.parse(line); } catch { return; }
      if (!o || o.action !== "run.end" || o.costUnknown !== true) return;
      const t = new Date(o.t);
      if (typeof o.t !== "string" || Number.isNaN(t.getTime()) || dayKey(t) !== dk) return;
      n++;
    });
  }
  return n;
}

/** Today's count of runs that reported no cost, rebuilt from the log the first time and reset when the day moves on. */
export function runCounter(now = new Date()) {
  const b = runtime().budget;
  const dk = dayKey(now);
  if (!b.runs) {
    const file = logFile();
    b.runs = { key: dk, n: file ? unmeteredFromLog(file, now) : 0 };
  } else if (b.runs.key !== dk) b.runs = { key: dk, n: 0 };
  return b.runs;
}

/**
 * Counts a run that reported no cost. Called for exactly the runs `spend` can do nothing with, so the two together
 * cover every run. Said once, when the limit is first reached, as `spend` says it.
 */
export function noteUnmeteredRun(now = new Date()) {
  const c = runCounter(now); // first: a first call rebuilds from the log, which doesn't hold this run yet
  c.n++;
  const limit = unmeteredRunLimit();
  if (limit !== null && c.n === limit) log("budget.reached", { limit: "unmetered_runs_day", runs: c.n, limitRuns: limit });
}

/** Runs today that reported no cost. */
export const unmeteredRuns = (now = new Date()) => runCounter(now).n;

/**
 * Whether no new run may start on `engine` because too many runs today went uncosted. Only an engine that reports no
 * cost is bounded this way: one that does is bounded by the dollar limits (`overBudget`), which are the better bound.
 */
export function overRuns(engine: Pick<AgentEngine, "reportsCost"> | undefined, now = new Date()): boolean {
  if (!engine || engine.reportsCost) return false;
  const limit = unmeteredRunLimit();
  return limit !== null && runCounter(now).n >= limit;
}
