// The server's terminal view (`renderDashboard`, pure) and its log of core actions (`log.ts`).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, logFile, onLog } from "../src/server/log";
import { duration, renderDashboard, type DashboardState } from "../src/server/tui";

const now = new Date(2026, 10, 1, 15, 0, 0).getTime();
const base: DashboardState = { url: "http://localhost:3000/", docs: "docs", log: "docs/.solipsist/server.log", startedAt: now - 125_000, runs: 1, maxRuns: 6, spentUsd: 0.0123, limitUsd: null, unmeteredRuns: 0, unmeteredLimit: 40, pages: [], recent: [] };
const plain = (s: Partial<DashboardState>, width = 120, height = 40) => renderDashboard({ ...base, ...s }, width, height, now, false);

test("the header: where it runs, for how long, runs against the limit, and the cost", () => {
  const lines = plain({});
  expect(lines[0]).toBe("Solipsist · http://localhost:3000/ · docs docs · up 2m 05s");
  expect(plain({ version: "0.1.0-dev+a1b2c3d" })[0]).toBe("Solipsist 0.1.0-dev+a1b2c3d · http://localhost:3000/ · docs docs · up 2m 05s");
  expect(lines[1]).toBe("Runs 1/6 · cost $0.0123 · log docs/.solipsist/server.log");
  expect(lines.join("\n")).toContain("No agents running.");
  expect(plain({ limitUsd: 0.01 })[1]).toContain("cost $0.0123 of $0.0100: no new runs");
});

test("each page's agents: running with the last step, waiting with when it finished and snoozes, in the chat, and why a page is idle", () => {
  const lines = plain({
    pages: [
      { id: "plan", model: "pi:m", tabs: 0, runs: [{ task: "abc", taskType: "gen", run: 3, model: "pi:m", startedAt: now - 62_000, step: "bash ls -la" }], kept: [{ task: "def", until: now + 240_000, finishedAt: now - 60_000 }], chatting: ["xyz"] },
      { id: "notes", model: "pi:m", tabs: 2, idle: "cost", runs: [], kept: [], chatting: [] },
    ],
  }).join("\n");
  expect(lines).toContain("● plan  pi:m  no tab");
  expect(lines).toMatch(/running\s+gen:abc {2}run 3 {2}1m 02s {2}bash ls -la/);
  expect(lines).toMatch(/waiting\s+def {2}finished .* · snoozes /);
  expect(lines).toMatch(/in chat\s+xyz/);
  expect(lines).toContain("○ notes  pi:m  2 tabs  stopped: cost limit reached");
});

test("the latest log lines fill what is left, newest last, each cut to the width", () => {
  const recent = Array.from({ length: 50 }, (_, i) => ({ t: new Date(now - (50 - i) * 1000).toISOString(), action: "run.end", page: "plan", task: `p${i}`, outcome: "suggested", durationMs: 12_300, costUsd: 0.002 }));
  const lines = plain({ recent }, 60, 20);
  expect(lines).toHaveLength(20);
  expect(lines.at(-1)).toContain("p49");
  expect(lines.every((l) => l.length <= 60)).toBe(true);
  expect(plain({ recent }, 200, 20).at(-1)).toContain("suggested · 12s · $0.0020");
});

test("colour codes don't count towards the width", () => {
  const lines = renderDashboard({ ...base, pages: [{ id: "a".repeat(200), model: "m", tabs: 1, runs: [], kept: [], chatting: [] }] }, 50, 40, now, true);
  for (const l of lines) expect(l.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(50);
});

test("paths: inside the working directory relative, outside it whole, home as ~", async () => {
  const { shownPath } = await import("../src/server/tui");
  expect(shownPath("/w/docs", "/w", "/Users/me")).toBe("docs");
  expect(shownPath("/w", "/w", "/Users/me")).toBe(".");
  expect(shownPath("/tmp/x/docs", "/w", "/Users/me")).toBe("/tmp/x/docs");
  expect(shownPath("/Users/me/notes", "/w", "/Users/me")).toBe("~/notes");
});

test("durations", () => {
  expect([duration(0), duration(59_000), duration(61_000), duration(3_700_000)]).toEqual(["0s", "59s", "1m 01s", "1h 01m"]);
});

const old = process.env.SOLIPSIST_LOG;
afterEach(() => { if (old === undefined) delete process.env.SOLIPSIST_LOG; else process.env.SOLIPSIST_LOG = old; });

test("the log: one JSON line per action, to SOLIPSIST_LOG; off under the tests unless set, and with SOLIPSIST_LOG=off", () => {
  delete process.env.SOLIPSIST_LOG;
  expect(logFile()).toBeNull(); // bun test sets NODE_ENV=test
  const dir = mkdtempSync(join(tmpdir(), "solip-log-"));
  try {
    const file = join(dir, "sub", "server.log");
    process.env.SOLIPSIST_LOG = file;
    const heard: string[] = [];
    const off = onLog((l) => heard.push(l.action));
    log("run.end", { page: "plan", ok: true });
    log("page.save", { page: "plan", rev: 4 });
    off();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(["run.end", "page.save"]);
    expect(lines[0]).toMatchObject({ page: "plan", ok: true, t: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(heard).toEqual(["run.end", "page.save"]);
    process.env.SOLIPSIST_LOG = "off";
    log("page.save", { page: "plan" });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    // A log that can't be written fails nothing.
    process.env.SOLIPSIST_LOG = "/dev/null/not/a/dir/server.log";
    expect(() => log("page.save", {})).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  expect(existsSync(dir)).toBe(false);
});
