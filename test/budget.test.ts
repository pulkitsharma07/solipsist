import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { counters, noteUnmeteredRun, overBudget, overRuns, spend, spentFromLog, unmeteredFromLog, unmeteredRuns } from "../src/server/agent/budget";
import { resetRuntime, runtime } from "../src/server/runtime";

const ENV = ["AGENT_COST_LIMIT_USD", "AGENT_COST_LIMIT_DAY_USD", "AGENT_COST_LIMIT_MONTH_USD", "AGENT_MAX_UNMETERED_RUNS_DAY", "SOLIPSIST_LOG"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "budget-"));
  resetRuntime();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(dir, { recursive: true, force: true });
  resetRuntime();
});

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);
const line = (when: Date, action: string, costUsd: unknown) => JSON.stringify({ t: when.toISOString(), action, costUsd });
const NOW = at(2026, 11, 6);

describe("rebuilding from the log", () => {
  test("today and this month count; yesterday only the month; last month neither", () => {
    const file = join(dir, "server.log");
    writeFileSync(file, [
      line(at(2026, 11, 6, 9), "run.end", 1),
      line(at(2026, 11, 6, 10), "chat.reply", 0.5),
      line(at(2026, 11, 6, 11), "pichat.reply", 0.25),
      line(at(2026, 11, 5, 23), "run.end", 2),
      line(at(2026, 10, 31, 12), "run.end", 100),
      line(at(2025, 11, 6, 12), "run.end", 100),
    ].join("\n") + "\n");
    expect(spentFromLog(file, NOW)).toEqual({ day: 1.75, month: 3.75 });
  });

  test("bad lines, other actions and nonsense costs are skipped; a last line without a newline counts", () => {
    const file = join(dir, "server.log");
    writeFileSync(file, [
      "not json at all costUsd",
      '{"t":"2026-11-06T10:00:00.000Z","action":"run.end","costUsd":',
      line(NOW, "run.start", 9),
      line(NOW, "run.end", "3"),
      line(NOW, "run.end", -1),
      line(NOW, "run.end", null),
      JSON.stringify({ t: "garbage", action: "run.end", costUsd: 7 }),
      JSON.stringify({ action: "run.end", costUsd: 7 }),
      "",
      line(NOW, "run.end", 0.5),
      line(NOW, "run.end", 0.5),
    ].join("\n"));
    expect(spentFromLog(file, NOW)).toEqual({ day: 1, month: 1 });
  });

  test("the rotated log counts too; a missing log is nothing", () => {
    const file = join(dir, "server.log");
    writeFileSync(`${file}.1`, line(NOW, "run.end", 2) + "\n");
    writeFileSync(file, line(NOW, "run.end", 1) + "\n");
    expect(spentFromLog(file, NOW)).toEqual({ day: 3, month: 3 });
    expect(spentFromLog(join(dir, "nope.log"), NOW)).toEqual({ day: 0, month: 0 });
  });

  test("a large log is read whole, across chunk boundaries", () => {
    const file = join(dir, "server.log");
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) lines.push(line(i % 2 ? NOW : at(2026, 11, 1), "run.end", 0.01));
    writeFileSync(file, lines.join("\n") + "\n");
    const r = spentFromLog(file, NOW);
    expect(r.day).toBeCloseTo(25, 6);
    expect(r.month).toBeCloseTo(50, 6);
  });

  test("the counters rebuild from the configured log on first use, once", () => {
    const file = join(dir, "server.log");
    writeFileSync(file, line(NOW, "run.end", 4.5) + "\n");
    process.env.SOLIPSIST_LOG = file;
    expect(overBudget(NOW)).toBe(false); // 4.5 of 5
    spend(0.6, NOW); // the new cost is not counted twice
    expect(runtime().budget.day?.spent).toBeCloseTo(5.1, 6);
    expect(overBudget(NOW)).toBe(true);
  });
});

// An engine that never says what a run cost passes every dollar limit untouched, so its runs are bounded by count
// instead (`agent.max_unmetered_runs_day`). Counting follows what a run reported, so the live count and the log agree.
describe("runs nobody knows the cost of", () => {
  const metered = { reportsCost: true };
  const unmetered = { reportsCost: false };

  test("only an engine that reports no cost is bounded by count", () => {
    process.env.AGENT_MAX_UNMETERED_RUNS_DAY = "2";
    expect(overRuns(unmetered, NOW)).toBe(false);
    noteUnmeteredRun(NOW);
    expect(overRuns(unmetered, NOW)).toBe(false);
    noteUnmeteredRun(NOW);
    expect(overRuns(unmetered, NOW)).toBe(true);
    // One that does report is bounded by the dollars, which is the better bound.
    expect(overRuns(metered, NOW)).toBe(false);
    // Nor does it bound a run whose engine is gone (no engine runs that model any more).
    expect(overRuns(undefined, NOW)).toBe(false);
  });

  test("0 is no limit, and the count rolls over to the next day", () => {
    process.env.AGENT_MAX_UNMETERED_RUNS_DAY = "0";
    for (let i = 0; i < 50; i++) noteUnmeteredRun(NOW);
    expect(overRuns(unmetered, NOW)).toBe(false);
    process.env.AGENT_MAX_UNMETERED_RUNS_DAY = "2";
    expect(overRuns(unmetered, NOW)).toBe(true);
    expect(overRuns(unmetered, at(2026, 11, 7, 0))).toBe(false);
    expect(unmeteredRuns(at(2026, 11, 7, 0))).toBe(0);
  });

  test("the dollar limits never see these runs", () => {
    noteUnmeteredRun(NOW);
    noteUnmeteredRun(NOW);
    expect(counters(NOW).day.spent).toBe(0);
    expect(overBudget(NOW)).toBe(false);
  });

  test("the log says how many there were today: only `run.end` lines with `costUnknown`", () => {
    const file = join(dir, "server.log");
    const un = (when: Date, action = "run.end", extra: object = {}) => JSON.stringify({ t: when.toISOString(), action, costUnknown: true, ...extra });
    writeFileSync(file, [
      un(at(2026, 11, 6, 9)),
      un(at(2026, 11, 6, 10)),
      un(at(2026, 11, 5, 23)),          // yesterday
      un(NOW, "chat.reply"),            // a reply, not a run
      JSON.stringify({ t: NOW.toISOString(), action: "run.end", costUnknown: "yes" }),
      line(NOW, "run.end", 2),          // a run that did say what it cost
      "not json at all costUnknown",
      un(NOW),                          // a last line with no newline
    ].join("\n"));
    expect(unmeteredFromLog(file, NOW)).toBe(3);
    expect(unmeteredFromLog(join(dir, "nope.log"), NOW)).toBe(0);
  });

  test("a restart picks the count up from the log, and the next run is not counted twice", () => {
    const file = join(dir, "server.log");
    const un = (when: Date) => JSON.stringify({ t: when.toISOString(), action: "run.end", costUnknown: true });
    writeFileSync(file, [un(NOW), un(NOW)].join("\n") + "\n");
    process.env.SOLIPSIST_LOG = file;
    process.env.AGENT_MAX_UNMETERED_RUNS_DAY = "3";
    expect(overRuns({ reportsCost: false }, NOW)).toBe(false); // 2 of 3
    noteUnmeteredRun(NOW);
    expect(unmeteredRuns(NOW)).toBe(3);
    expect(overRuns({ reportsCost: false }, NOW)).toBe(true);
  });
});

describe("the limits", () => {
  test("defaults: $5 a day, $50 a month", () => {
    spend(4.99, NOW);
    expect(overBudget(NOW)).toBe(false);
    spend(0.02, NOW);
    expect(overBudget(NOW)).toBe(true);
  });

  test("the day limit alone, then it rolls over to the next day", () => {
    process.env.AGENT_COST_LIMIT_DAY_USD = "1";
    process.env.AGENT_COST_LIMIT_MONTH_USD = "0";
    spend(1, NOW);
    expect(overBudget(NOW)).toBe(true);
    expect(overBudget(at(2026, 11, 7, 0))).toBe(false);
    expect(counters(at(2026, 11, 7, 0)).month.spent).toBe(1);
  });

  test("the month limit alone, then it rolls over to the next month", () => {
    process.env.AGENT_COST_LIMIT_DAY_USD = "0";
    process.env.AGENT_COST_LIMIT_MONTH_USD = "3";
    spend(2, at(2026, 11, 5));
    spend(1, at(2026, 11, 20));
    expect(overBudget(at(2026, 11, 21))).toBe(true);
    expect(overBudget(at(2026, 12, 1, 0))).toBe(false);
  });

  test("the since-start limit still works, with the others off", () => {
    process.env.AGENT_COST_LIMIT_DAY_USD = "0";
    process.env.AGENT_COST_LIMIT_MONTH_USD = "0";
    process.env.AGENT_COST_LIMIT_USD = "0.01";
    spend(0.02, NOW);
    expect(overBudget(NOW)).toBe(true);
    expect(overBudget(at(2026, 12, 1))).toBe(true);
  });

  test("0 for both means no limit", () => {
    process.env.AGENT_COST_LIMIT_DAY_USD = "0";
    process.env.AGENT_COST_LIMIT_MONTH_USD = "0";
    spend(1000, NOW);
    expect(overBudget(NOW)).toBe(false);
  });

  test("nonsense costs add nothing", () => {
    spend(NaN, NOW); spend(-3, NOW); spend("2", NOW); spend(undefined, NOW);
    expect(runtime().budget.spent).toBe(0);
  });
});
