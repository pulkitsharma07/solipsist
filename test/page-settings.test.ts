// A page's agent settings: kept in its file, read by the stream, the chat and the
// loop, changed by one route. The loop and the engines are fakes; nothing here touches the network.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFileSync } from "./outside";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEngine } from "../src/server/agent/engine";
import { setEngines } from "../src/server/agent/engines";
import { stopAllPages } from "../src/server/agent/pageAgents";
import { onSettings, readSettings, writeSettings } from "../src/server/agent/settings";
import { agentStream, setAgentModel, stopAgents } from "../src/server/agent";
import { emptyBlock, parseFile, serializeFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-settings-test-");
const dir = P.docs;
// Entered in `beforeEach`, not here: every test file in the process shares one working directory, and a file
// that changed it while the files were being loaded would be overruled by the next one's.
process.env.AGENT_SETTLE_MS = "30";
process.env.AGENT_GAP_MS = "50";
afterAll(() => P.done());
beforeEach(() => P.enter());
afterEach(() => stopAllPages("test over"));

const WORK = "Plan: <!-- gen:abc --> end.\n";
const file = (id: string) => join(dir, `${id}.md`);
const page = (id: string, body = WORK, block = emptyBlock()) => writeFileSync(file(id), serializeFile(body, block));

/** A fake engine, counting its starts. */
function fake(name: string) {
  const starts: string[] = [];
  let off: string | null = null;
  const engine: AgentEngine = {
    name, title: name.toUpperCase(), chats: true, models: () => [{ id: "m", title: "M" }, { id: "n", title: "N" }], unavailable: () => off,
    async start(o) {
      starts.push(o.model);
      return { died: new Promise<string>(() => {}), history: () => [], close: async () => {}, run: async () => ({ ok: true, result: `<decline>no</decline>` }) };
    },
  };
  return { engine, starts, setOff: (w: string | null) => { off = w; } };
}

describe("the file", () => {
  test("settings that differ from the default are in the block, and read back; the defaults are not written", () => {
    const withSettings = serializeFile("Hi.\n", { ...emptyBlock(), agent: { on: false, model: "fake:small" } });
    expect(withSettings).toContain('"agent":');
    expect(parseFile(withSettings).block.agent).toEqual({ on: false, model: "fake:small" });
    expect(parseFile(serializeFile("Hi.\n", { ...emptyBlock(), agent: { model: "pi:x" } })).block.agent).toEqual({ model: "pi:x" });
    expect(parseFile(serializeFile("Hi.\n", emptyBlock())).block.agent).toBeUndefined();
    // Only what the app writes is read, and `on: true` (the writer's opt-in to start a page nobody has open): a model
    // that isn't text, an `on` that isn't true or false, or anything else is the default.
    const odd = (agent: string) => parseFile(`Hi.\n\n<!-- solip-comments\nmeta: {rev: 1, body_rev: 1, body_by: null}\ncomments: {}\nagent: ${agent}\n-->\n`).block.agent;
    expect(odd("{on: true}")).toEqual({ on: true });
    expect(odd("{on: yes please}")).toBeUndefined();
    expect(odd("{model: 3}")).toBeUndefined();
    expect(odd("{model: '  '}")).toBeUndefined();
    // A setting this build doesn't know is kept as written (a newer build's: test/format.test.tsx).
    expect(odd("{other: 1, model: pi:y}")).toEqual({ other: 1, model: "pi:y" } as object);
    expect(odd("nonsense")).toBeUndefined();
  });
});

describe("reading and writing them", () => {
  let a: ReturnType<typeof fake>;
  let old: AgentEngine[] | null;
  beforeEach(() => { a = fake("alpha"); old = setEngines([a.engine, fake("beta").engine]); });
  afterEach(() => { setEngines(old); });

  test("a page with none is on, with the default model; a page with no file too", () => {
    page("plain");
    expect(readSettings("plain")).toMatchObject({ on: true, model: "alpha:m", saved: {} });
    expect(readSettings("nobody")).toMatchObject({ on: true, model: "alpha:m" });
  });

  test("off and a model are written to the file, and on removes the entry again; the rest of the block is kept", async () => {
    const block = { ...emptyBlock(), comments: { c1: { id: "c1", quote: "x", title: "t" } as never }, tasks: { abc: { type: "gen", created_by: "writer", created: "2026-01-01T00:00:00.000Z" } as never } };
    page("w", WORK, block);
    expect(await writeSettings("w", { on: false })).toMatchObject({ on: false });
    const { rev, body_rev } = parseFile(readFileSync(file("w"), "utf8")).block.meta; // (the first write also records that the file was written by hand)
    expect(await writeSettings("w", { model: "beta:n" })).toMatchObject({ on: false, model: "beta:n" });
    let f = parseFile(readFileSync(file("w"), "utf8"));
    expect(f.block.agent).toEqual({ on: false, model: "beta:n" });
    expect(f.block.meta.rev).toBe(rev + 1); // a change is a write
    expect(f.block.meta.body_rev).toBe(body_rev); // and not a change of the body
    expect(f.block.comments).toEqual(block.comments);
    expect(f.block.tasks).toEqual(block.tasks);
    expect(f.markdown).toBe(WORK.trimEnd());
    await writeSettings("w", { on: true });
    f = parseFile(readFileSync(file("w"), "utf8"));
    expect(f.block.agent).toEqual({ model: "beta:n" }); // on is the default: not written
    expect(readSettings("w")).toMatchObject({ on: true, model: "beta:n" });
  });

  test("a change to what the file already says is no write; a page with no file is null", async () => {
    page("same");
    await writeSettings("same", { on: true });
    const before = statSync(file("same")).mtimeMs;
    await Bun.sleep(15);
    expect(await writeSettings("same", { on: true })).toMatchObject({ on: true });
    expect(statSync(file("same")).mtimeMs).toBe(before);
    expect(await writeSettings("ghost", { on: false })).toBeNull();
    expect(existsSync(file("ghost"))).toBe(false);
  });

  test("a model whose engine can't run now is the default until it can; the file keeps the choice", async () => {
    page("away");
    await writeSettings("away", { model: "beta:n" });
    expect(readSettings("away").model).toBe("beta:n");
    const b = fake("beta");
    b.setOff("no key");
    setEngines([a.engine, b.engine]);
    expect(readSettings("away")).toMatchObject({ model: "alpha:m", saved: { model: "beta:n" } });
    b.setOff(null);
    expect(readSettings("away").model).toBe("beta:n");
  });

  test("those listening are told of a change, and not after they stop", async () => {
    page("tell");
    const seen: string[] = [];
    const off = onSettings("tell", (s) => seen.push(`${s.on}:${s.model}`));
    await writeSettings("tell", { on: false });
    off();
    await writeSettings("tell", { on: true });
    expect(seen).toEqual(["false:alpha:m"]);
  });
});

/** The agent stream of `id`, read as text. */
function stream(id: string, query = "") {
  const ac = new AbortController();
  const res = agentStream(Object.assign(new Request(`http://x/${query}`, { signal: ac.signal }), { params: { id } }), { timeout() {} });
  const r = res.body!.getReader();
  let text = "";
  let done = false;
  const pump = (async () => { for (;;) { const c = await r.read(); if (c.done) { done = true; return; } text += new TextDecoder().decode(c.value); } })();
  return {
    get text() { return text; },
    get ended() { return done; },
    ended_: () => pump,
    async until(f: () => boolean, ms = 5000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error(`timed out in:\n${text}`); await Bun.sleep(10); } },
    stop: () => ac.abort(),
  };
}
const post = (id: string, body: object) => setAgentModel(Object.assign(new Request("http://x/", { method: "POST", body: JSON.stringify(body) }), { params: { id } }));

describe("the switch and the model, through the stream and the route", () => {
  let a: ReturnType<typeof fake>;
  let b: ReturnType<typeof fake>;
  let old: AgentEngine[] | null;
  beforeEach(() => { a = fake("alpha"); b = fake("beta"); old = setEngines([a.engine, b.engine]); });
  afterEach(() => { setEngines(old); });

  test("turned off, it stays off after a reload: the stream starts no agents and says so, and holds until they are turned on", async () => {
    page("off", "Just words.\n"); // nothing to run: the agents of an open page would idle
    const first = stream("off");
    await first.until(() => first.text.includes("event: hello"));
    expect(first.text).toContain('"on":true');
    expect((await post("off", { on: false })).status).toBe(200);
    await first.until(() => first.ended); // its agents stopped, so its stream is done
    expect(parseFile(readFileSync(file("off"), "utf8")).block.agent).toEqual({ on: false });

    // The tab opens a new stream, as it does: no agents, and the stream waits.
    page("off", WORK, { ...emptyBlock(), agent: { on: false } });
    const second = stream("off");
    await second.until(() => second.text.includes("event: hello"));
    expect(second.text).toContain('"on":false');
    await Bun.sleep(200);
    expect(a.starts).toEqual([]); // the placeholder is pending, and nothing runs
    expect(second.ended).toBe(false);

    // A model change while off is told, not acted on.
    await post("off", { model: "beta:n" });
    await second.until(() => second.text.includes("event: settings"));
    expect(second.text).toMatch(/event: settings\ndata: [^\n]*"on":false[^\n]*"model":"beta:n"/);
    expect(second.ended).toBe(false);

    // Turned on: the stream closes, and the next one starts the agents (on the page's model).
    expect((await post("off", { on: true })).status).toBe(200);
    await second.until(() => second.ended);
    const third = stream("off");
    await third.until(() => b.starts.length === 1);
    expect(third.text).toContain('"on":true');
    expect(a.starts).toEqual([]);
    third.stop();
  });

  test("the old stop route turns them off the same way: it is kept in the page", async () => {
    page("stopped");
    const s = stream("stopped");
    await s.until(() => a.starts.length === 1);
    expect((await stopAgents(Object.assign(new Request("http://x/", { method: "POST" }), { params: { id: "stopped" } }))).status).toBe(204);
    expect(parseFile(readFileSync(file("stopped"), "utf8")).block.agent).toEqual({ on: false });
    s.stop();
  });

  test("a page with a model of its own runs on it, whatever a stream asks for; one without may be started on one", async () => {
    page("mine", WORK, { ...emptyBlock(), agent: { model: "beta:n" } });
    const s = stream("mine", "?model=alpha:m");
    await s.until(() => b.starts.length === 1);
    expect(b.starts).toEqual(["n"]);
    expect(a.starts).toEqual([]);
    expect(s.text).toContain('"model":"beta:n"');
    s.stop();
    await stopAllPages("next");
    page("asked");
    const t = stream("asked", "?model=beta:m");
    await t.until(() => b.starts.length === 2);
    expect(parseFile(readFileSync(file("asked"), "utf8")).block.agent).toBeUndefined(); // only the writer's change is written
    t.stop();
  });

  test("a change from one tab reaches a running page, and the next run is on it; another tab's stream is told", async () => {
    page("two", "Just words.\n");
    const one = stream("two");
    const other = stream("two");
    await one.until(() => one.text.includes("event: hello"));
    expect((await post("two", { model: "beta:n" })).status).toBe(200);
    await other.until(() => other.text.includes("event: model"));
    expect(other.text).toMatch(/event: model\ndata: [^\n]*"model":"beta:n"/);
    expect(parseFile(readFileSync(file("two"), "utf8")).block.agent).toEqual({ model: "beta:n" });
    writeFileSync(file("two"), serializeFile(WORK, { ...emptyBlock(), agent: { model: "beta:n" } }));
    await one.until(() => b.starts.length === 1);
    expect(b.starts).toEqual(["n"]);
    one.stop(); other.stop();
  });

  test("the route refuses what it can't use, and says why", async () => {
    page("r");
    const body = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    expect(await body(await post("r", { model: "gpt" }))).toBe("bad_model");
    expect(await body(await post("r", { on: "yes" }))).toBe("bad_request");
    expect(await body(await post("r", {}))).toBe("bad_request");
    expect(await body(await post("nobody", { on: false }))).toBe("not_found");
    expect(await body(await post("../up", { on: false }))).toBe("bad_id");
    b.setOff("Set a key");
    const res = await post("r", { model: "beta:m" });
    expect(res.status).toBe(400);
    expect(await body(res)).toBe("unavailable");
    expect(parseFile(readFileSync(file("r"), "utf8")).block.agent).toBeUndefined(); // nothing written for a refusal
    // A good one answers with what the page has.
    expect(await (await post("r", { model: "alpha:n" })).json()).toEqual({ on: true, model: "alpha:n" });
  });
});
