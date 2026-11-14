// The Pi engine, on Pi's scripted `faux` model (no network) and a scratch Pi config directory (never ~/.pi): it runs
// with Pi's own defaults and no limits added, reports its steps, keeps its conversation between runs, turns any
// permission prompt into an error, and the agent loop drives it like any engine.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { stopAllPages } from "../src/server/agent/pageAgents";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStep } from "../src/server/agent/engine";
import { parseChoice, setEngines } from "../src/server/agent/engines";
import { cmdEngine as fakeEngine } from "../src/server/agent/engines/cmd";
import { piEngine, runError } from "../src/server/agent/engines/pi";
import { describeEngine } from "./engine-contract";

const dir = mkdtempSync(join(tmpdir(), "solip-pi-test-"));
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT;
const restoreProject = () => { if (wasProject === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT; else process.env.SOLIPSIST_PROJECT_ROOT = wasProject; };
// A page's agents outlive its stream: each test's are turned off after it.
afterEach(() => { restoreProject(); return stopAllPages("test over"); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** A fresh project folder, docs folder and Pi config directory. */
function place() {
  const base = join(dir, `t${n++}`);
  const p = { root: base, docs: join(base, ".solipsist", "pages"), scratch: join(base, "scratch"), agentDir: join(base, "pi") };
  for (const d of Object.values(p)) mkdirSync(d, { recursive: true });
  return { ...p, file: join(p.docs, "pg.md") };
}

/** A Pi engine on a scripted model, with its config in `agentDir`. */
async function scripted(agentDir: string, responses: (() => any)[]) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const seen: any[] = [];
  faux.setResponses(responses.map((f) => (ctx: any) => { seen.push(ctx); return f(); }));
  return { engine: piEngine({ agentDir: () => agentDir, runtime: async () => runtime, model: () => faux.getModel() }), seen };
}
const tool = (name: string, args: Record<string, any>) => () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const say = (s: string) => () => fauxAssistantMessage(fauxText(s));

// The engine API's own rules (`engine-contract.ts`), on Pi's scripted model.
describeEngine("Pi", async () => {
  const p = place();
  writeFileSync(p.file, "The plan is <!-- gen:abc --> done.\n");
  const { engine } = await scripted(p.agentDir, [say("Done."), say("Done again."), say("And again.")]);
  return {
    engine,
    says: "Done.",
    start: () => engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: () => {} }),
  };
});

test("a run with Pi's default tools, writes only in its image folder, its steps and result are reported, the next run remembers the first", async () => {
  const p = place();
  writeFileSync(p.file, "The plan is <!-- gen:abc --> done.\n");
  writeFileSync(join(p.agentDir, "APPEND_SYSTEM.md"), "THE WRITER'S OWN APPEND");
  const other = join(p.root, "other.txt");
  const img = join(p.docs, "images", "pg", "a.txt");
  mkdirSync(join(p.docs, "images", "pg"), { recursive: true });
  const { engine, seen } = await scripted(p.agentDir, [
    tool("read", { path: p.file }),
    tool("write", { path: other, content: "written" }),
    tool("write", { path: img, content: "pic" }),
    tool("edit", { path: p.file, edits: [{ oldText: "<!-- gen:abc -->", newText: "filled" }] }),
    say("Filled the plan."),
    say("Again."),
  ]);
  const steps: AgentStep[] = [];
  const agent = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: (s) => steps.push(s) });
  expect(await agent.run("Do the page.")).toMatchObject({ ok: true, result: "Filled the plan." });
  // The page and other files are refused; its own image folder is open.
  expect(readFileSync(p.file, "utf8")).toBe("The plan is <!-- gen:abc --> done.\n");
  expect(existsSync(other)).toBe(false);
  expect(readFileSync(img, "utf8")).toBe("pic");
  expect(steps.map((s) => s.kind)).toEqual(["init", "tool", "tool_result", "tool", "tool_result", "tool", "tool_result", "tool", "tool_result", "text"]);
  expect(steps[1]).toMatchObject({ name: "read", brief: p.file });
  expect(steps.some((s) => s.kind === "error")).toBe(false);
  await agent.run("And again.");
  expect(JSON.stringify(seen.at(-1).messages)).toContain("Do the page."); // one conversation
  // The protocol goes in the system prompt, after the writer's own APPEND_SYSTEM.md, not instead of it.
  const system = JSON.stringify(seen[0].messages.filter((m: any) => m.role === "system"));
  expect(system).toContain("THE WRITER'S OWN APPEND");
  expect(system).toContain("SOLIP-PROTOCOL");
  await agent.close();
  await agent.close(); // twice is fine
});

// Pinned so a change to Pi's limits is deliberate: today its working directory is
// the project folder, whose AGENTS.md it loads, and it has Pi's default tools.
test("Pi works where Solipsist runs, with its context files, and has only the allowed tools", async () => {
  const p = place();
  writeFileSync(join(p.root, "AGENTS.md"), "ROOT CONTEXT MARK");
  const steps: AgentStep[] = [];
  const { engine, seen } = await scripted(p.agentDir, [say("Hi."), say("Hi.")]);
  const agent = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: (s) => steps.push(s) });
  await agent.run("Hello.");
  const system = seen[0].messages.find((m: any) => m.role === "system");
  expect(JSON.stringify(system)).toContain("ROOT CONTEXT MARK");
  expect(system.sections.cwd).toContain(p.root);
  expect(steps.filter((s) => s.kind === "error")).toEqual([]);
  expect(system.toolsAdded.map((t: any) => t.name)).toEqual(["read", "grep", "find", "ls", "bash", "write", "edit"]);
  await agent.close();

  // SOLIPSIST_PI_TOOLS replaces the list; the reply tools come on top when the agent gets them.
  process.env.SOLIPSIST_PI_TOOLS = "read";
  try {
    const b = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "S", replyTools: true, onStep: () => {} });
    await b.run("Hello.");
    const listed = seen[1].messages.find((m: any) => m.role === "system").toolsAdded.map((t: any) => t.name);
    expect(listed.sort()).toEqual(["answer", "decline", "read", "suggest"]);
    await b.close();
  } finally { delete process.env.SOLIPSIST_PI_TOOLS; }
});

test("an extension's permission prompt can't be answered here: it is reported as an error, and refused", async () => {
  const p = place();
  writeFileSync(p.file, "x\n");
  // A global extension (Pi's config directory) that asks before every tool call, like Pi's permission-gate example.
  mkdirSync(join(p.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(p.agentDir, "extensions", "gate.ts"), `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!(await ctx.ui.confirm("Allow tool call?", event.toolName))) return { block: true, reason: "not approved" };
  });
}
`);
  const { engine } = await scripted(p.agentDir, [tool("read", { path: p.file }), say("Could not read it.")]);
  const steps: AgentStep[] = [];
  const agent = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: (s) => steps.push(s) });
  await agent.run("Do the page.");
  const err = steps.find((s) => s.kind === "error");
  expect(err?.text).toContain("Pi asked for permission");
  expect(err?.text).toContain("Allow tool call?");
  expect(steps.find((s) => s.kind === "tool_result")?.text).toContain("not approved");
  await agent.close();
});

test("a project with its own .pi resources and no trust decision: Pi would ask; that is an error, and they are left out", async () => {
  const p = place();
  writeFileSync(p.file, "x\n");
  mkdirSync(join(p.root, ".pi", "extensions"), { recursive: true });
  // A project extension that would announce itself: it must not load while the folder is untrusted.
  writeFileSync(join(p.root, ".pi", "extensions", "hello.ts"), `export default function (pi) { pi.on("session_start", async (_e, ctx) => ctx.ui.notify("project extension loaded", "error")); }\n`);
  const steps: AgentStep[] = [];
  const first = await scripted(p.agentDir, []);
  const a = await first.engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: (s) => steps.push(s) });
  const errors = steps.filter((s) => s.kind === "error").map((s) => s.text);
  expect(errors.some((t) => t.includes("trust the project folder"))).toBe(true);
  expect(errors.some((t) => t.includes("project extension loaded"))).toBe(false);
  await a.close();

  // Trusted (as `/trust` would save it): no question, and the project's extension loads.
  new ProjectTrustStore(p.agentDir).set(p.root, true);
  steps.length = 0;
  const second = await scripted(p.agentDir, []);
  const b = await second.engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "SOLIP-PROTOCOL", onStep: (s) => steps.push(s) });
  const after = steps.filter((s) => s.kind === "error").map((s) => s.text);
  expect(after.some((t) => t.includes("trust the project folder"))).toBe(false);
  expect(after.some((t) => t.includes("project extension loaded"))).toBe(true);
  await b.close();
});

test("the agent loop runs Pi like any engine: its reply becomes the placeholder's suggestion, a permission prompt reaches the stream as an error, and it stops when turned off", async () => {
  const p = place();
  process.env.SOLIPSIST_PROJECT_ROOT = p.root;
  process.env.AGENT_GAP_MS = "50";
  process.env.AGENT_SETTLE_MS = "50";
  const target = join(p.docs, "loop.md");
  writeFileSync(target, "Plan: <!-- gen:abc --> end.\n");
  mkdirSync(join(p.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(p.agentDir, "extensions", "ask.ts"), `export default function (pi) { pi.on("tool_call", async (e, ctx) => { if (e.toolName === "bash") await ctx.ui.confirm("Run it?", "bash"); }); }\n`);
  const { engine } = await scripted(p.agentDir, [
    tool("bash", { command: "true" }),
    say('Done.\n\n<suggestion mode="at" place="inline">\ndone by pi\n</suggestion>'),
  ]);
  const old = setEngines([fakeEngine, engine]);
  try {
    // A page's saved model is taken on trust (Pi's catalog may not be read yet), but one the writer picks is checked
    // against what the engines offer: a model Pi doesn't have is refused where it is chosen, not six minutes into a run.
    expect(parseChoice("pi:acme/acme-small-5.5")?.engine.name).toBe("pi");
    expect(parseChoice("small")).toBeNull(); // a choice names its engine
    const { agentStream, openAgents, setAgentModel } = await import("../src/server/agent");
    const choose = (model: string) =>
      setAgentModel(Object.assign(new Request("http://x", { method: "POST", body: JSON.stringify({ model }) }), { params: { id: "loop" } }) as any);
    expect((await choose("pi:nope")).status).toBe(400);
    const ac = new AbortController();
    const req = Object.assign(new Request("http://x/?model=pi:acme/acme-small-5.5", { signal: ac.signal }), { params: { id: "loop" } });
    const r = agentStream(req, { timeout() {} }).body!.getReader();
    let text = "";
    while (!text.includes("event: end")) text += new TextDecoder().decode((await r.read()).value);
    expect(text).toContain('"model":"pi:acme/acme-small-5.5"');
    expect(text).toMatch(/event: step\ndata: .*"kind":"error".*Run it\?/);
    expect(text).toContain('"ok":true');
    expect(readFileSync(target, "utf8")).toContain("Plan: <!-- gen:abc:sug --> end.");
    expect(readFileSync(target, "utf8")).toContain('"suggestion": "done by pi"');
    ac.abort();
    await new Promise((res) => setTimeout(res, 100));
    expect(openAgents()).toContain("loop"); // the tab went, the agent waits on
    const { stopAgents } = await import("../src/server/agent");
    await stopAgents(Object.assign(new Request("http://x/", { method: "POST" }), { params: { id: "loop" } }));
    expect(openAgents()).not.toContain("loop");
  } finally {
    setEngines(old);
  }
});

test("the loop gives Pi the reply tools: a call that can't be used gets its error in the same run, the fixed one is the suggestion and ends the run", async () => {
  const p = place();
  process.env.SOLIPSIST_PROJECT_ROOT = p.root;
  process.env.AGENT_GAP_MS = "50";
  process.env.AGENT_SETTLE_MS = "50";
  const target = join(p.docs, "tools.md");
  writeFileSync(target, "Plan: <!-- gen:abc --> end.\n");
  const { engine, seen } = await scripted(p.agentDir, [
    tool("suggest", { mode: "after", place: "inline", markdown: "wrong mode" }),
    tool("suggest", { mode: "at", place: "inline", markdown: "done by *tool*", note: "Via the tool." }),
    say("never asked: the call ended the run"),
  ]);
  const old = setEngines([engine]);
  try {
    const { agentStream } = await import("../src/server/agent");
    const ac = new AbortController();
    const req = Object.assign(new Request("http://x/?model=pi:acme/acme-small-5.5", { signal: ac.signal }), { params: { id: "tools" } });
    const r = agentStream(req, { timeout() {} }).body!.getReader();
    let text = "";
    while (!text.includes("event: end")) text += new TextDecoder().decode((await r.read()).value);
    ac.abort();
    expect(text).toContain('"ok":true');
    expect(seen).toHaveLength(2);
    expect(seen[0].messages.find((m: any) => m.role === "system").sections.tools).toContain("- suggest:");
    const toolResult = seen[1].messages.findLast((m: any) => m.role === "toolResult");
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult.content)).toContain('not mode=\\"after\\"');
    const file = readFileSync(target, "utf8");
    expect(file).toContain("Plan: <!-- gen:abc:sug --> end.");
    expect(file).toContain('"suggestion": "done by *tool*"');
    expect(file).toContain('"note": "Via the tool."');
  } finally {
    setEngines(old);
  }
});

test("closing a Pi agent mid-run stops the command it is running", async () => {
  const p = place();
  writeFileSync(p.file, "x\n");
  const pid = join(p.scratch, "pid");
  const { engine } = await scripted(p.agentDir, [tool("bash", { command: `echo $$ > ${pid}; exec sleep 30` }), say("Done.")]);
  const agent = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "", onStep: () => {} });
  const run = agent.run("Run it.");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const t = Date.now(); !existsSync(pid) || !readFileSync(pid, "utf8").trim(); await wait(20)) if (Date.now() - t > 5000) throw new Error("the command never started");
  const shell = Number(readFileSync(pid, "utf8").trim());
  const alive = () => { try { process.kill(shell, 0); return true; } catch { return false; } };
  expect(alive()).toBe(true);
  await agent.close();
  for (const t = Date.now(); alive(); await wait(20)) if (Date.now() - t > 3000) throw new Error("the command outlived its agent");
  await run; // and the run ends
});

describe("the engines", () => {
  test("Pi is the one engine, so its first model is the default; AGENT_CMD puts the test stand-in first", async () => {
    const { engines, defaultChoice, parseChoice } = await import("../src/server/agent/engines");
    const saved = process.env.AGENT_CMD;
    try {
      delete process.env.AGENT_CMD;
      expect(engines().map((e) => e.name)).toEqual(["pi"]);
      expect(defaultChoice()).toStartWith("pi:");
      expect(parseChoice("small")).toBeNull(); // a choice names its engine
      // A choice of an engine there is none of (one saved by an older build) is no choice: the page gets the default.
      expect(parseChoice("gone:model")).toBeNull();
      process.env.AGENT_CMD = JSON.stringify(["true"]);
      expect(engines().map((e) => e.name)).toEqual(["fake", "pi"]);
      expect(parseChoice("fake:small")).toMatchObject({ choice: "fake:small" });
    } finally {
      if (saved === undefined) delete process.env.AGENT_CMD; else process.env.AGENT_CMD = saved;
    }
  });
});

describe("writeGuard", () => {
  test("write and edit are allowed only in the agent's image folder", async () => {
    const { writeGuard } = await import("../src/server/agent/engines/pi");
    let handler: any;
    writeGuard("/docs/images/abc", "/proj")({ on: (_: string, f: any) => { handler = f; } } as any);
    const call = (toolName: string, path: string) => handler({ toolName, input: { path } });
    expect(call("write", "/docs/images/abc/a.png")).toBeUndefined();
    expect(call("edit", "/docs/images/abc/sub/b.svg")).toBeUndefined();
    expect(call("write", "/docs/abc.md")?.block).toBe(true);
    expect(call("edit", "docs/abc.md")?.block).toBe(true);
    expect(call("write", "/docs/images/abc/../abc.md")?.block).toBe(true);
    expect(call("write", "/docs/images/abcd/x")?.block).toBe(true);
    expect(call("read", "/docs/abc.md")).toBeUndefined();
  });
});

test("OpenRouter refusing the key says which key, since ours is used instead of Pi's own login", () => {
  const saved = process.env.SOLIPSIST_OPENROUTER_KEY;
  try {
    const refused = '401: {"message":"Missing Authentication header","code":401}';
    process.env.SOLIPSIST_OPENROUTER_KEY = "sk-or-bad";
    expect(runError(refused)).toStartWith("OpenRouter refused the key in SOLIPSIST_OPENROUTER_KEY (pi.openrouter_key): fix it, or remove it to use Pi's own login.");
    delete process.env.SOLIPSIST_OPENROUTER_KEY;
    expect(runError(refused)).toStartWith("OpenRouter refused Pi's key");
    expect(runError("timeout")).toBe("timeout");
  } finally {
    if (saved === undefined) delete process.env.SOLIPSIST_OPENROUTER_KEY; else process.env.SOLIPSIST_OPENROUTER_KEY = saved;
  }
});

for (const when of ["while it is calling a tool", "while it is writing its last answer"] as const) {
  test(`a message steered in ${when} reaches the model before the run ends, and the run's result answers it`, async () => {
    const p = place();
    writeFileSync(p.file, "Text.\n");
    let let1: () => void = () => {};
    const held = new Promise<void>((r) => { let1 = r; });
    const first = when === "while it is calling a tool" ? tool("ls", { path: p.root }) : say("First answer.");
    const { engine, seen } = await scripted(p.agentDir, [async () => { await held; return first(); }, say("Answered the new message too."), say("unused")]);
    const agent = await engine.start({ id: "pg", file: p.file, images: join(p.docs, "images", "pg"), root: p.root, scratch: p.scratch, model: "m", system: "S", onStep: () => {} });
    try {
      expect(await agent.steer!("<chat>\nnot yet\n</chat>")).toBe(false); // no run in flight
      const run = agent.run("Start.");
      for (let i = 0; i < 200 && seen.length < 1; i++) await Bun.sleep(5);
      expect(await agent.steer!("<chat>\nALSO THIS\n</chat>")).toBe(true);
      let1();
      const res = await run;
      expect(res).toMatchObject({ ok: true, result: "Answered the new message too." });
      expect(seen).toHaveLength(2);
      expect(JSON.stringify(seen[1].messages)).toContain("ALSO THIS");
      expect(JSON.stringify(seen[0].messages)).not.toContain("ALSO THIS");
      expect(agent.history!().filter((m) => m.role === "user").map((m) => (m.blocks[0] as { text: string }).text)).toContain("ALSO THIS");
    } finally {
      await agent.close();
    }
  });
}
