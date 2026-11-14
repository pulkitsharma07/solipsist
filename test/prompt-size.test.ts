/**
 * What a run is sent, in characters, must stay under a budget: a prompt that grows costs
 * every run. The budgets were set by measuring the built-in prompts on `test/fixtures/everything.md` and adding about
 * 10%. Raising one should be a deliberate choice, not a fix for a failing test: say in the commit what was added and why.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/plugins";
import { pendingTasks, promptFor, promptNext, systemPrompt } from "../src/server/agent/page";

// Measured: system with reply tools, system without (adds protocol.envelope), first run prompt, follow-up turn prompt.
const SYSTEM_BUDGET = 4700; // measured 4233
const SYSTEM_ENVELOPE_BUDGET = 5300; // measured 4832
const FIRST_PROMPT_BUDGET = 13300; // measured 12056
const NEXT_PROMPT_BUDGET = 8100; // measured 7325, worst case: told no kinds yet

let dir = "";
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT;
const restoreProject = () => { if (wasProject === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT; else process.env.SOLIPSIST_PROJECT_ROOT = wasProject; };
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "prompt-size-")));
  // A project of its own: the page is a working copy in its `.solipsist/pages`.
  const pages = join(dir, ".solipsist", "pages");
  mkdirSync(pages, { recursive: true });
  cpSync(join(import.meta.dir, "fixtures", "everything.md"), join(pages, "everything.md"));
  process.env.SOLIPSIST_PROJECT_ROOT = dir;
});
afterAll(() => {
  restoreProject();
  rmSync(dir, { recursive: true, force: true });
});

const target = () => {
  const t = pendingTasks("everything");
  expect(t.length).toBeGreaterThan(0);
  return t[0]!;
};

test("system prompt of an engine with reply tools", () => {
  const n = systemPrompt({ replyTools: true }).length;
  console.log("size system", n);
  expect(n).toBeLessThan(SYSTEM_BUDGET);
});
test("system prompt of an engine without reply tools", () => {
  const n = systemPrompt({ replyTools: false }).length;
  console.log("size system+envelope", n);
  expect(n).toBeLessThan(SYSTEM_ENVELOPE_BUDGET);
});
test("first run prompt on everything.md", () => {
  const n = promptFor("everything", target()).length;
  console.log("size first", n);
  expect(n).toBeLessThan(FIRST_PROMPT_BUDGET);
});
test("single-agent follow-up prompt", () => {
  const n = promptNext("everything", target(), new Set()).length;
  console.log("size next", n);
  expect(n).toBeLessThan(NEXT_PROMPT_BUDGET);
});
