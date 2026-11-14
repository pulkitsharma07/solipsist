// The `AGENT_CMD` stand-in engine (`engines/cmd.ts`): a process speaking stream-json, which the tests
// put first. It is also the shape a configured `exec` engine would take, so the engine contract is run
// against it here (`engine-contract.ts`).
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStep } from "../src/server/agent/engine";
import { cmdEngine } from "../src/server/agent/engines/cmd";
import { describeEngine } from "./engine-contract";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "solip-cmd-test-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** One run's worth of stream-json: an init line, then a result with what the run cost. `read` keeps it alive after. */
const SCRIPT = [
  `read line`,
  `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1","model":"small"}'`,
  `printf '%s\\n' '{"type":"result","result":"done","is_error":false,"total_cost_usd":0.001}'`,
  `read line`,
].join("; ");

let saved: string | undefined;
beforeEach(() => { saved = process.env.AGENT_CMD; process.env.AGENT_CMD = JSON.stringify(["sh", "-c", SCRIPT]); });
afterEach(() => { if (saved === undefined) delete process.env.AGENT_CMD; else process.env.AGENT_CMD = saved; });

const place = () => {
  const base = tmp();
  const p = { file: join(base, "pg.md"), images: join(base, "images", "pg"), root: base, scratch: join(base, "scratch") };
  mkdirSync(p.scratch, { recursive: true });
  return p;
};

describeEngine("the AGENT_CMD stand-in", () => {
  const p = place();
  return {
    engine: cmdEngine,
    says: "done",
    start: () => cmdEngine.start({ id: "pg", ...p, model: "small", system: "SOLIP-PROTOCOL", onStep: () => {} }),
  };
});

test("what the process says becomes the steps the panel shows: its words, what it ran, and what came back", async () => {
  const p = place();
  // Fed from a file, so the shell never sees the JSON: a quote lost in the script would be the test's own bug.
  const lines = join(p.root, "stream.jsonl");
  writeFileSync(lines, [
    { type: "system", subtype: "init", session_id: "abcdef1234567890", model: "small" },
    { type: "assistant", message: { content: [{ type: "text", text: "  Reading the page.  " }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/docs/pg.md" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "# Plan" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "   " }] } }, // nothing said: not a step
    { type: "result", result: "done", is_error: false, total_cost_usd: 0.001 },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `read line; cat ${lines}; read line`]);

  const steps: AgentStep[] = [];
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "small", system: "", onStep: (s) => steps.push(s) });
  try {
    expect(await agent.run("go")).toMatchObject({ ok: true, result: "done", costUsd: 0.001 });
    // One step per thing worth showing, in the order it happened; a reply that said nothing is not one.
    expect(steps.map((s) => s.kind)).toEqual(["init", "text", "tool", "tool_result"]);
    expect(steps[0]!.text).toContain("abcdef12"); // the session, short enough to read
    expect(steps[1]!.text).toBe("Reading the page."); // trimmed
    // A tool call says which tool and what it was about, which is what the margin shows on hover.
    expect(steps[2]).toMatchObject({ kind: "tool", name: "Read", brief: "/docs/pg.md" });
    expect(steps[2]!.text).toContain("Read");
    expect(steps[3]).toMatchObject({ kind: "tool_result", text: "# Plan" });
  } finally {
    await agent.close();
  }
});

test("a tool result given in blocks rather than as text is still reported", async () => {
  const p = place();
  const lines = join(p.root, "stream.jsonl");
  writeFileSync(lines, [
    { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] }] } },
    { type: "result", result: "done", is_error: false },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `read line; cat ${lines}; read line`]);
  const steps: AgentStep[] = [];
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "small", system: "", onStep: (s) => steps.push(s) });
  try {
    await agent.run("go");
    expect(steps.map((s) => s.kind)).toEqual(["tool_result"]);
    expect(steps[0]!.text).toBe("first\nsecond");
  } finally {
    await agent.close();
  }
});

test("a run the process reports as an error fails, and says what it said", async () => {
  const p = place();
  const lines = join(p.root, "stream.jsonl");
  writeFileSync(lines, [{ type: "result", result: "it would not", is_error: true }].map((o) => JSON.stringify(o)).join("\n") + "\n");
  process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `read line; cat ${lines}; read line`]);
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "small", system: "", onStep: () => {} });
  try {
    expect(await agent.run("go")).toMatchObject({ ok: false, error: "it would not" });
  } finally {
    await agent.close();
  }
});

test("a line that isn't JSON is passed over rather than ending the run", async () => {
  const p = place();
  const lines = join(p.root, "stream.jsonl");
  writeFileSync(lines, ["not json at all", "", JSON.stringify({ type: "result", result: "done", is_error: false })].join("\n") + "\n");
  process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `read line; cat ${lines}; read line`]);
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "small", system: "", onStep: () => {} });
  try {
    expect(await agent.run("go")).toMatchObject({ ok: true, result: "done" });
  } finally {
    await agent.close();
  }
});

test("it keeps no conversation of its own, so a kept agent is never recorded for it", async () => {
  const p = place();
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "small", system: "SOLIP-PROTOCOL", onStep: () => {} });
  try {
    // No `sessionId`: the loop drops its agent after each run rather than keeping it to wait and snooze.
    expect(agent.sessionId).toBeUndefined();
    expect(agent.history).toBeUndefined();
  } finally {
    await agent.close();
  }
});

test("the model is the last argument, so one command can serve several models", async () => {
  const p = place();
  // `sh -c <script> <$0> <$1>`: the engine appends the model, so it lands in `$1` and the process echoes it back.
  process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `printf '{"type":"result","result":"%s","is_error":false}\\n' "$1"; read line`, "sh"]);
  const agent = await cmdEngine.start({ id: "pg", ...p, model: "large", system: "", onStep: () => {} });
  try {
    expect((await agent.run("go")).result).toBe("large");
  } finally {
    await agent.close();
  }
});
