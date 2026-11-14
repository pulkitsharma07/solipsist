import { afterAll, afterEach, beforeEach, describe as group, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "./outside";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStream, kindPromptFile, openAgents, pendingTasks, promptFor, protocolFile, setAgentModel, stopAgents } from "../src/server/agent";
import { stopAllPages } from "../src/server/agent/pageAgents";
import { BUILTIN_PLUGINS } from "../src/plugins";
import { parseFile, serializeFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-agent-");
const dir = P.root;
const pids = join(dir, "pids");
const docs = P.docs;
// Entered in `beforeEach`, not here: every test file in the process shares one working directory, and a file
// that changed it while the files were being loaded would be overruled by the next one's.
// Short waits, so the loop's timing can be tested quickly.
process.env.AGENT_GAP_MS = "100";
process.env.AGENT_SETTLE_MS = "150";
/** A page with work for the agent: one pending task. */
const WORK = "Some text. <!-- gen:abc -->";
const page = (id: string) => join(docs, `${id}.md`);

/** A stand-in for an engine. `exec` so the pid we record is the one that gets killed. */
const fake = (script: string) => { process.env.AGENT_CMD = JSON.stringify(["sh", "-c", `echo $$ >> ${pids}; ${script}`]); };
/** A fake agent's reply line: a `result` whose text is `text`. */
// printf, not echo: macOS's sh turns the `\n` escapes inside the JSON into real line breaks.
const result = (text: string, extra: object = {}) => `printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result: text, ...extra }).replaceAll("'", `'\\''`)}'`;
/** What a run that did its work answers: its result in a <suggestion>. */
const SUGGESTS = result('Filled it in.\n\n<suggestion mode="at" place="inline">\nFilled.\n</suggestion>\n<note>A word.</note>');
const spawned = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 3000) => { for (const t = Date.now(); !ok(); await wait(20)) if (Date.now() - t > ms) throw new Error("timeout"); };

beforeEach(() => P.enter());
afterAll(() => P.done()); // put the project back: the files of a run share the environment
beforeEach(() => { rmSync(pids, { force: true }); writeFileSync(pids, ""); });
// A page's agents outlive its stream: each test's are turned off after it, so none runs into the next.
afterEach(async () => { await stopAllPages("test over"); delete process.env.AGENT_CMD; for (const p of spawned()) try { process.kill(p, "SIGKILL"); } catch {} });
/** The writer turns the page's agents off (the status bar's switch). */
const turnOff = (id: string) => stopAgents(Object.assign(new Request("http://x/", { method: "POST" }), { params: { id } }));

let n = 0;
/** Opens the agent stream of a page (a fresh one, with a pending task, unless it exists). */
function connect(id = `p${n++}`, query = "") {
  if (/^[a-z0-9-]+$/.test(id) && !existsSync(page(id))) writeFileSync(page(id), WORK);
  const ac = new AbortController();
  const req = Object.assign(new Request(`http://x/${query}`, { signal: ac.signal }), { params: { id } });
  const res = agentStream(req, { timeout() {} });
  return { id, ac, res };
}

test("closing the stream leaves the run working; turning the agents off kills it", async () => {
  fake("exec sleep 30");
  const { ac, id } = connect();
  await until(() => spawned().length === 1);
  const [pid] = spawned();
  ac.abort();
  await wait(300);
  expect(alive(pid!)).toBe(true);
  expect(openAgents()).toContain(id);
  expect((await turnOff(id)).status).toBe(204);
  await until(() => !alive(pid!));
  expect(openAgents()).not.toContain(id);
});

test("the browser going away (the response body cancelled) leaves the run working too", async () => {
  fake("exec sleep 30");
  const { res, id } = connect();
  await until(() => spawned().length === 1);
  await res.body!.cancel();
  await wait(300);
  expect(alive(spawned()[0]!)).toBe(true);
  await turnOff(id);
  await until(() => !alive(spawned()[0]!));
});

test("no new run starts once the agents are turned off, even while waiting between runs", async () => {
  fake("true");
  const { id } = connect();
  await until(() => spawned().length >= 2); // it loops
  await turnOff(id);
  await wait(50);
  const count = spawned().length;
  await wait(400); // longer than the gap
  expect(spawned().length).toBe(count);
  expect(spawned().every((p) => !alive(p))).toBe(true);
});

test("turning the agents off right away leaves nothing running", async () => {
  fake("exec sleep 30");
  const { id } = connect();
  await turnOff(id);
  await wait(300);
  expect(openAgents()).not.toContain(id);
  expect(spawned().every((p) => !alive(p))).toBe(true);
});

test("one set of agents per page: a second stream joins it, and is told about the run in flight first", async () => {
  fake("exec sleep 30");
  const first = connect("same");
  await until(() => spawned().length === 1);
  const second = connect("same");
  expect(second.res.status).toBe(200);
  const reader = second.res.body!.getReader();
  let text = "";
  while (!text.includes("event: start")) text += new TextDecoder().decode((await reader.read()).value);
  expect(text.indexOf("event: hello")).toBeLessThan(text.indexOf("event: start"));
  expect(text).toMatch(/event: start\ndata: .*"run":1.*"task":"abc"/);
  expect(spawned().length).toBe(1);
  first.ac.abort();
  second.ac.abort();
  await turnOff("same");
  await until(() => spawned().every((p) => !alive(p)));
});

test("a crashing agent is reported and retried, and still stops when turned off", async () => {
  fake("echo boom >&2; exit 3");
  const { id, res } = connect();
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("event: end")) text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('"ok":false');
  expect(text).toContain("boom");
  await until(() => spawned().length >= 2);
  await turnOff(id);
  await wait(50);
  const count = spawned().length;
  await wait(400); // longer than the gap
  expect(spawned().length).toBe(count);
});

test("every run starts its own agent, and its suggestion leaves nothing to run until a new placeholder comes", async () => {
  writeFileSync(page("serve"), `a ${WORK}`);
  // Answers each stdin line with a `result` line.
  fake(`while read l; do ${result('<suggestion mode="at" place="inline">x</suggestion>', { total_cost_usd: 0.01 })}; done`);
  const { ac, res } = connect("serve");
  const reader = res.body!.getReader();
  let text = "";
  const read = async (until: string) => { while (!text.includes(until)) text += new TextDecoder().decode((await reader.read()).value); };
  await read("event: skip"); // run 1 ended with a suggestion: nothing waits, no run 2
  expect(text).not.toContain('"run":2');
  writeFileSync(page("serve"), `b ${WORK}`);
  await read('"run":2');
  await until(() => spawned().length === 2); // a fresh process for the second run
  await until(() => !alive(spawned()[0]!)); // the first one was closed when its run ended
  ac.abort();
  await until(() => spawned().every((p) => !alive(p)));
});

test("a changed page is sent only once it has stopped changing", async () => {
  process.env.AGENT_SETTLE_MS = "400";
  writeFileSync(page("typing"), `a ${WORK}`);
  fake(`while read l; do ${SUGGESTS}; done`);
  const { ac, res } = connect("typing");
  const reader = res.body!.getReader();
  let text = "";
  void (async () => { for (;;) { const r = await reader.read(); if (r.done) return; text += new TextDecoder().decode(r.value); } })();
  await until(() => text.includes("event: skip"));
  for (let i = 0; i < 12; i++) { writeFileSync(page("typing"), `typing ${i} ${WORK}`); await wait(100); } // keeps changing for 1.2 s, under the quiet time each step
  expect(text).toContain("event: settling");
  expect(text).not.toContain('"run":2');
  await until(() => text.includes('"run":2')); // quiet at last
  ac.abort();
  await until(() => spawned().every((p) => !alive(p)));
  process.env.AGENT_SETTLE_MS = "150";
});

/** Reads the stream into `text` as it arrives. */
function collect(res: Response) {
  const r = res.body!.getReader();
  const out = { text: "" };
  void (async () => { for (;;) { const x = await r.read(); if (x.done) return; out.text += new TextDecoder().decode(x.value); } })();
  return out;
}
const answers = `while read l; do ${SUGGESTS}; done`;

test("a page with no pending placeholder gets no run, until one is added", async () => {
  writeFileSync(page("quiet"), "Just text.\n\n```\n<!-- gen:xyz -->\n```");
  fake(answers);
  const { ac, res } = connect("quiet");
  const out = collect(res);
  await until(() => out.text.includes("nothing pending"));
  await wait(300);
  expect(out.text).not.toContain("event: start"); // one in code is code
  writeFileSync(page("quiet"), `Just text. ${WORK}`);
  await until(() => out.text.includes('"run":1'));
  ac.abort();
  await until(() => spawned().every((p) => !alive(p)));
});

test("a change to the comments block alone is no reason to run again", async () => {
  writeFileSync(page("block"), `${WORK}\n\n<!-- solip-comments\n"meta":\n  "rev": 1\n-->\n`);
  fake(answers);
  const { ac, res } = connect("block");
  const out = collect(res);
  await until(() => out.text.includes("event: skip"));
  // The server recording a disk edit: the same body, a new rev.
  const { markdown, block } = parseFile(readFileSync(page("block"), "utf8"));
  writeFileSync(page("block"), serializeFile(markdown, { ...block, meta: { ...block.meta, rev: block.meta.rev + 5 } }));
  await wait(500);
  expect(out.text).not.toContain('"run":2');
  ac.abort();
  await until(() => spawned().every((p) => !alive(p)));
});

test("a bad page id starts nothing", async () => {
  fake("exec sleep 30");
  const res = connect("../etc").res;
  expect(res.status).toBe(400);
  await wait(100);
  expect(spawned()).toEqual([]);
});

const scratchDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("solip-agent-run-"));

test("every run's scratch directory is removed when the page's agents stop", async () => {
  fake("exec sleep 30");
  const before = scratchDirs().length;
  const { id } = connect();
  await until(() => spawned().length === 1);
  expect(scratchDirs().length).toBe(before + 1);
  await turnOff(id);
  await until(() => scratchDirs().length === before);
});

group("no spinner is left behind", () => {
  // A page whose task has a record, as the server keeps it.
  const withRecord = (body: string) => `${body}\n\n<!-- solip-comments\n"meta":\n  "rev": 3\n  "body_rev": 3\n  "body_by": "disk"\n"comments": {}\n"tasks":\n  "abc":\n    "type": "gen"\n    "created_by": "writer"\n    "created": "2026-10-25T10:00:00.000Z"\n    "status": "pending"\n-->\n`;
  /** A fake agent that does `then` on every prompt. The server acknowledged the task before sending it. */
  const acksThen = (_id: string, then: string) => fake(`while read l; do ${then}; done`);
  const body = (id: string) => readFileSync(page(id), "utf8");
  const record = (id: string) => body(id).match(/"abc":[\s\S]*?"status": "(\w+)"/)?.[1];

  test("a run that crashes after the ack: the placeholder waits again, its record too, and the panel is told", async () => {
    writeFileSync(page("crash"), withRecord(WORK));
    acksThen("crash", "exit 1");
    // The retry comes after the gap, exactly (the loop sleeps until it): a long one, so the page is read before it.
    const gap = process.env.AGENT_GAP_MS;
    process.env.AGENT_GAP_MS = "3000";
    try {
      const { ac, res } = connect("crash");
      const out = collect(res);
      await until(() => out.text.includes("event: warning"));
      expect(out.text).toContain("moved back to waiting");
      expect(body("crash")).toContain("<!-- gen:abc -->");
      expect(record("crash")).toBe("pending");
      ac.abort();
      await until(() => spawned().every((p) => !alive(p)));
    } finally { process.env.AGENT_GAP_MS = gap; }
  });

  test("a run whose reply has no suggestion: the same, and the panel is told why", async () => {
    writeFileSync(page("lazy"), withRecord(WORK));
    acksThen("lazy", `echo '{"type":"result","is_error":false,"result":"ok"}'`);
    const { ac, res } = connect("lazy");
    const out = collect(res);
    await until(() => out.text.includes("event: warning"));
    expect(out.text).toMatch(/event: end\ndata: [^\n]*"ok":false[^\n]*no <suggestion>, <edit>, <answer> or <decline>/);
    expect(body("lazy")).toContain("<!-- gen:abc -->");
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("turning the agents off mid-run: the same", async () => {
    writeFileSync(page("closed"), withRecord(WORK));
    acksThen("closed", "sleep 30");
    connect("closed");
    await until(() => body("closed").includes("gen:abc:ack") && spawned().length === 1);
    await turnOff("closed");
    await until(() => body("closed").includes("<!-- gen:abc -->"));
    expect(record("closed")).toBe("pending");
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("an ack already in the page when the agent starts was left by an earlier run: reset, then taken", async () => {
    writeFileSync(page("left"), withRecord("Some text. <!-- gen:abc:ack -->"));
    fake(answers);
    const { ac, res } = connect("left");
    const out = collect(res);
    await until(() => out.text.includes('"run":1'));
    expect(out.text.indexOf("event: warning")).toBeLessThan(out.text.indexOf("event: start"));
    await until(() => body("left").includes("<!-- gen:abc:sug -->")); // taken again, and this time finished
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("a run that breaks the comments block is reported, and the last good block is kept", async () => {
    writeFileSync(page("broke"), withRecord(WORK));
    fake(`while read l; do perl -pi -e 's/"meta":/"meta": [oops/' ${page("broke")}; echo '{"type":"result","is_error":false,"result":"ok"}'; done`);
    const { ac, res } = connect("broke");
    const out = collect(res);
    await until(() => out.text.includes("broke the comments block"));
    expect(body("broke")).toContain('"type": "gen"');
    expect(body("broke")).not.toContain("[oops");
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });
});

test("the prompt names the page's file in full", () => {
  expect(promptFor("abc", { id: "abc", taskType: "gen" })).toContain(join(docs, "abc.md"));
});

group("the prompt", () => {
  test("carries everything a run needs, so it can start without reading files: the file's path, each pending kind's instructions, the page", () => {
    const body = "A <!-- sel:aaa -->task<!-- /sel:aaa --> and <!-- gen:bbb --> and <!-- gen:ccc:ack -->. Braces {page} stay.";
    writeFileSync(page("both"), body);
    const p = promptFor("both", { id: "aaa", taskType: "sel" });
    expect(p).toContain(page("both"));
    expect(p).toContain(`<page-file path="${page("both")}">\n${body}\n</page-file>`);
    const gen = readFileSync(kindPromptFile("gen"), "utf8").trim();
    const selPrompt = readFileSync(kindPromptFile("sel"), "utf8").trim();
    expect(p).toContain(`<task-type name="gen" shape="point">\n${gen}\n</task-type>`);
    expect(p).toContain(`<task-type name="sel" shape="range">\n${selPrompt}\n</task-type>`);
    expect(p.indexOf('name="sel"')).toBeLessThan(p.indexOf('name="gen"')); // the run's own kind first
    expect(p).not.toContain(protocolFile()); // the protocol is in the system prompt
    for (const k of ["{id}", "{file}", "{target}", "{kinds}"]) expect(p).not.toContain(k);
  });

  test("names the one placeholder the run is for, with its comments", () => {
    writeFileSync(page("named"), "A <!-- sel:aaa -->task<!-- /sel:aaa --> and <!-- gen:bbb -->.");
    // As the run finds them: the server acknowledged it before the run started.
    expect(promptFor("named", { id: "aaa", taskType: "sel" })).toContain("Your task this run: the sel task aaa, marked `<!-- sel:aaa:ack -->…<!-- /sel:aaa:ack -->`.");
    expect(promptFor("named", { id: "bbb", taskType: "gen" })).toContain("Your task this run: the gen task bbb, marked `<!-- gen:bbb:ack -->`.");
    expect(promptFor("named", { id: "bbb", taskType: "gen" })).toContain("Don't edit the page");
  });

  test("names the instruction of a placeholder that has one, on its comment and in words", () => {
    writeFileSync(page("said"), `A <!-- sel:aaa "make it &quot;short&quot;" -->task<!-- /sel:aaa -->.`);
    const [target] = pendingTasks("said");
    expect(target).toEqual({ id: "aaa", taskType: "sel", instruction: 'make it "short"' });
    expect(promptFor("said", target!)).toContain(`the sel task aaa, marked \`<!-- sel:aaa:ack "make it &quot;short&quot;" -->…<!-- /sel:aaa:ack -->\`, with the writer's instruction <instruction>make it "short"</instruction>`);
  });

  test("lists its own kind, acknowledged as it is, and the other kinds with a pending placeholder", () => {
    writeFileSync(page("onlygen"), "A <!-- sel:aaa:ack -->task<!-- /sel:aaa:ack --> and <!-- gen:bbb:ack -->.");
    expect(promptFor("onlygen", { id: "bbb", taskType: "gen" })).not.toContain('<task-type name="sel"');
    expect(promptFor("onlygen", { id: "bbb", taskType: "gen" })).toContain('<task-type name="gen"');
    expect(promptFor("onlygen", { id: "aaa", taskType: "sel" })).toContain('<task-type name="sel"');
  });

  test("when the writer asked again, carries the suggestion they turned down", () => {
    const rec = (extra: string) => `A <!-- gen:bbb:ack -->.\n\n<!-- solip-comments\n"meta":\n  "rev": 1\n"comments": {}\n"tasks":\n  "bbb":\n    "type": "gen"\n    "created_by": "writer"\n    "created": "t"\n    "status": "ack"\n${extra}-->\n`;
    writeFileSync(page("again"), rec(""));
    expect(promptFor("again", { id: "bbb", taskType: "gen" })).not.toContain("asked again");
    writeFileSync(page("again"), rec(`    "asked_again": 1\n    "suggestion": "The first try."\n`));
    const p = promptFor("again", { id: "bbb", taskType: "gen" });
    expect(p).toContain("asked again");
    expect(p).toContain("<rejected-suggestion>\nThe first try.\n</rejected-suggestion>");
    writeFileSync(page("again"), rec(`    "asked_again": 2\n    "note": "Nothing to go on."\n`));
    expect(promptFor("again", { id: "bbb", taskType: "gen" })).toContain("Last time you declined: Nothing to go on.");
    expect(promptFor("again", { id: "bbb", taskType: "gen" })).not.toContain("keep your result as a button");
    // Asked again as a button: told what a button needs.
    writeFileSync(page("again"), rec(`    "asked_again": 1\n    "wants_button": true\n    "suggestion": "The first try."\n`));
    expect(promptFor("again", { id: "bbb", taskType: "gen" })).toContain("The writer wants to keep your result as a button");
  });

  test("every built-in plugin has its instructions, and the protocol is there", () => {
    expect(existsSync(protocolFile())).toBe(true);
    for (const p of BUILTIN_PLUGINS) {
      const text = readFileSync(kindPromptFile(p.taskType), "utf8");
      // Its comment, as the agent will see it: with an instruction for a kind that takes one.
      expect(text).toMatch(new RegExp(`<!-- ${p.taskType}:abc( "[^"]*")? -->`));
    }
  });
});

const models = join(dir, "models");
const startedModels = () => (existsSync(models) ? readFileSync(models, "utf8").split("\n").filter(Boolean) : []);
const switchTo = (id: string, model: string) => setAgentModel(Object.assign(new Request("http://x/", { method: "POST", body: JSON.stringify({ model }) }), { params: { id } }));
const reader = (res: Response) => {
  const r = res.body!.getReader();
  let text = "";
  return { get text() { return text; }, read: async (until: string) => { while (!text.includes(until)) text += new TextDecoder().decode((await r.read()).value); } };
};

group("the model", () => {
  const slow = () => fake(`echo $0 >> ${models}; while read l; do sleep 0.4; ${SUGGESTS}; done`);
  beforeEach(() => rmSync(models, { force: true }));

  test("a page starts on Small unless asked, and an unknown model means Small", async () => {
    slow();
    const a = connect(undefined, "?model=fake:large");
    const b = connect(undefined, "?model=fake:gpt");
    await until(() => startedModels().length === 2);
    expect(startedModels().sort()).toEqual(["large", "small"]);
    a.ac.abort(); b.ac.abort();
  });

  test("switching mid-run lets the run finish, and the next run starts on the new model", async () => {
    slow();
    const { id, ac, res } = connect(undefined, "?model=fake:small");
    const out = reader(res);
    await until(() => spawned().length === 1);
    const first = spawned()[0]!;
    expect((await switchTo(id, "fake:large")).status).toBe(200);
    expect(alive(first)).toBe(true); // the run in flight is not cut short
    await out.read("event: end"); // the run ends...
    expect(out.text).toContain('"ok":true');
    writeFileSync(page(id), `again ${WORK}`);
    await until(() => spawned().length === 2); // ...and the next one is a new process
    // Its pid is written before its model: wait for both, or a busy machine reads the file in between.
    await until(() => startedModels().length === 2);
    expect(startedModels()).toEqual(["small", "large"]);
    await until(() => !alive(first)); // the old one is gone
    await out.read("event: model");
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("switching while the agent is idle is said at once, and the next run is on the new model", async () => {
    writeFileSync(page("idle"), WORK);
    slow();
    const { ac, res } = connect("idle");
    const out = reader(res);
    await out.read("event: skip"); // run 1 done; nothing to do
    await switchTo("idle", "fake:large");
    await out.read("event: model");
    writeFileSync(page("idle"), `again ${WORK}`);
    await until(() => startedModels().length === 2);
    expect(startedModels()[1]).toBe("large");
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("a bad model is refused, and so is a page that does not exist", async () => {
    slow();
    const { id } = connect();
    expect((await switchTo(id, "fake:gpt")).status).toBe(400);
    expect((await switchTo("nobody", "fake:large")).status).toBe(404); // no such page
    await turnOff(id);
    await until(() => spawned().every((p) => !alive(p)));
    expect((await switchTo(id, "fake:large")).status).toBe(200); // the page's choice is kept for when it is on again
  });

  test("a model whose engine isn't set up (Pi with no key) is refused, and asked for at the start means the default", async () => {
    // `bun test` loads .env, and Pi would also use its own login or OPENROUTER_API_KEY: tests never reach the network.
    const saved = { key: process.env.SOLIPSIST_OPENROUTER_KEY, or: process.env.OPENROUTER_API_KEY, pi: process.env.PI_CODING_AGENT_DIR };
    delete process.env.SOLIPSIST_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.PI_CODING_AGENT_DIR = join(dir, "no-pi");
    try {
      slow();
      const { id, ac, res } = connect(undefined, "?model=pi:acme/acme-small-5.5");
      const out = reader(res);
      await out.read("event: hello");
      expect(out.text).toContain('"model":"fake:small"');
      expect(out.text).toContain("SOLIPSIST_OPENROUTER_KEY"); // the picker is told why Pi is greyed out
      const r = await switchTo(id, "pi:acme/acme-small-5.5");
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe("unavailable");
      expect((await switchTo(id, "fake:large")).status).toBe(200);
      ac.abort();
      await until(() => spawned().every((p) => !alive(p)));
    } finally {
      for (const [k, v] of [["SOLIPSIST_OPENROUTER_KEY", saved.key], ["OPENROUTER_API_KEY", saved.or], ["PI_CODING_AGENT_DIR", saved.pi]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});

test("a run that takes longer than AGENT_RUN_TIMEOUT_MS is stopped, counted as failed, and its placeholder waits again", async () => {
  process.env.AGENT_RUN_TIMEOUT_MS = "300";
  try {
    writeFileSync(page("hung"), WORK);
    fake("while read l; do sleep 30; done");
    const { ac, res } = connect("hung");
    const out = collect(res);
    await until(() => out.text.includes("Timed out"));
    expect(out.text).toMatch(/event: end\ndata: [^\n]*"ok":false[^\n]*Timed out/);
    await until(() => !alive(spawned()[0]!)); // its agent was stopped
    await until(() => readFileSync(page("hung"), "utf8").includes("<!-- gen:abc -->")); // no spinner left
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  } finally { delete process.env.AGENT_RUN_TIMEOUT_MS; }
});

group("runs at once", () => {
  /** A fake agent: for the prompt that names `slow`, `slowly`; for any other, `then`. */
  const by = (slow: string, slowly: string, then = SUGGESTS) =>
    fake(`while read l; do case "$l" in *"task ${slow},"*) ${slowly};; *) ${then};; esac; done`);
  const two = (id: string) => writeFileSync(page(id), "One <!-- gen:aaa --> and two <!-- gen:bbb -->.");

  test("each placeholder gets its own run and agent, and a slow one holds up no other", async () => {
    two("pair");
    by("aaa", "sleep 30");
    const { res } = connect("pair");
    const out = collect(res);
    await until(() => out.text.includes('"task":"aaa"') && out.text.includes('"task":"bbb"'));
    await until(() => /event: end\ndata: [^\n]*"task":"bbb"[^\n]*"ok":true/.test(out.text)); // bbb is done...
    expect(out.text).not.toMatch(/event: end\ndata: [^\n]*"task":"aaa"/); // ...while aaa still works
    expect(spawned().length).toBe(2);
    await turnOff("pair");
    await until(() => spawned().every((p) => !alive(p))); // the slow one is stopped with the page's agents
  });

  test("no more runs at once than AGENT_CONCURRENCY", async () => {
    process.env.AGENT_CONCURRENCY = "1";
    try {
      two("one-at-a-time");
      fake("exec sleep 30");
      const { res } = connect("one-at-a-time");
      const out = collect(res);
      await until(() => out.text.includes("event: start"));
      await wait(400);
      expect(spawned().length).toBe(1);
      expect(out.text.match(/event: start/g)!.length).toBe(1);
      await turnOff("one-at-a-time");
      await until(() => spawned().every((p) => !alive(p)));
    } finally { delete process.env.AGENT_CONCURRENCY; }
  });

  test("a run that ends leaves the ack of a run still working alone", async () => {
    two("acks");
    // aaa: worked on for a long time. bbb: the run ends without a suggestion. The server acknowledged both.
    by("aaa", "sleep 30", `sleep 0.3; echo '{"type":"result","is_error":false,"result":"ok"}'`);
    const { res } = connect("acks");
    const out = collect(res);
    await until(() => out.text.includes("event: warning"));
    const body = readFileSync(page("acks"), "utf8");
    expect(body).toContain("<!-- gen:aaa:ack -->"); // still being worked on
    expect(body).toContain("<!-- gen:bbb -->"); // waits again
    await turnOff("acks");
    await until(() => readFileSync(page("acks"), "utf8").includes("<!-- gen:aaa -->")); // turned off: nobody works on it now
    await until(() => spawned().every((p) => !alive(p)));
  });
});

group("a run's result is a suggestion", () => {
  const body = (id: string) => readFileSync(page(id), "utf8");
  const record = (id: string) => (parseFile(body(id)).block.tasks ?? {}).abc;
  const done = async (id: string, out: { text: string }) => {
    await until(() => out.text.includes("event: end"));
    return out;
  };

  test("the server acknowledges it before the agent starts, and the agent finds it so", async () => {
    writeFileSync(page("acked"), WORK);
    // Says what it found: the reply is a suggestion only if the page already had the ack when the prompt came.
    fake(`while read l; do if grep -q 'gen:abc:ack' ${page("acked")}; then ${SUGGESTS}; else ${result("not acked")}; fi; done`);
    const { ac, res } = connect("acked");
    const out = await done("acked", collect(res));
    expect(out.text).toMatch(/event: end\ndata: [^\n]*"ok":true[^\n]*"outcome":"suggested"/);
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("its suggestion goes in the record and the placeholder moves to sug; the page is otherwise untouched", async () => {
    writeFileSync(page("sugg"), "The plan is <!-- gen:abc --> done.");
    fake(`while read l; do ${SUGGESTS}; done`);
    const { ac, res } = connect("sugg");
    await done("sugg", collect(res));
    expect(parseFile(body("sugg")).markdown).toBe("The plan is <!-- gen:abc:sug --> done.");
    expect(record("sugg")).toMatchObject({ type: "gen", created_by: "writer", status: "suggested", mode: "at", place: "inline", suggestion: "Filled.", note: "A word.", failures: 0 });
    expect(record("sugg")?.acked).toBeString();
    expect(record("sugg")?.finished).toBeString();
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("a decline goes in the record with its reason", async () => {
    writeFileSync(page("decl"), "The plan is <!-- gen:abc --> done.");
    fake(`while read l; do ${result("<decline>Nothing around it says what goes here.</decline>")}; done`);
    const { ac, res } = connect("decl");
    const out = await done("decl", collect(res));
    expect(out.text).toContain('"outcome":"declined"');
    expect(parseFile(body("decl")).markdown).toBe("The plan is <!-- gen:abc:sug --> done.");
    expect(record("decl")).toMatchObject({ status: "declined", note: "Nothing around it says what goes here." });
    expect(record("decl")?.suggestion).toBeUndefined();
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("a reply that can't be used is retried, and given up on the third time: declined with why", async () => {
    writeFileSync(page("bad"), "The plan is <!-- gen:abc --> done.");
    fake(`while read l; do ${result('<suggestion mode="replace" place="inline">x</suggestion>')}; done`);
    const { ac, res } = connect("bad");
    const out = collect(res);
    await until(() => body("bad").includes("gen:abc:sug"));
    expect(out.text.match(/event: start/g)!.length).toBe(3);
    expect(record("bad")).toMatchObject({ status: "declined", failures: 3 });
    expect(record("bad")?.note).toContain('mode="at"');
    await wait(300);
    expect(out.text.match(/event: start/g)!.length).toBe(3); // nothing more to do
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });

  test("the writer deleting the placeholder mid-run: nothing goes in the page, the record keeps the suggestion as dropped", async () => {
    writeFileSync(page("gone"), "The plan is <!-- gen:abc --> done.");
    fake(`while read l; do sleep 0.4; ${SUGGESTS}; done`);
    const { ac, res } = connect("gone");
    const out = collect(res);
    await until(() => body("gone").includes("gen:abc:ack"));
    writeFileSync(page("gone"), body("gone").replace(" <!-- gen:abc:ack -->", ""));
    await done("gone", out);
    await until(() => record("gone")?.status === "dropped");
    expect(parseFile(body("gone")).markdown).toBe("The plan is done.");
    expect(record("gone")?.suggestion).toBe("Filled.");
    ac.abort();
    await until(() => spawned().every((p) => !alive(p)));
  });
});

test("no agent is left open at the end", () => {
  expect(openAgents()).toEqual([]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
