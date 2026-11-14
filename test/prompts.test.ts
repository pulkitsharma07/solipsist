// The prompts the writer can change (src/server/prompts.ts): the defaults, the edits kept in prompts.dir, the checks on a
// save, and the API that serves them to the settings dialog.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as api from "../src/server/api";
import { builtinFileOf, defaultText, getPrompt, listPrompts, promptPath, promptText, renderPrompt, resetPrompt, savePrompt } from "../src/server/prompts";
import { instructions, promptFor, systemPrompt } from "../src/server/agent/page";

const dir = mkdtempSync(join(tmpdir(), "solip-prompts-"));
/** The repo, which is not the working directory while the tests run (`test/setup.ts`). */
const repo = (...p: string[]) => join(process.env.SOLIPSIST_TEST_REPO!, ...p);
const saved = { prompts: process.env.SOLIPSIST_PROMPTS_DIR };
beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  process.env.SOLIPSIST_PROMPTS_DIR = join(dir, "prompts");
});
afterAll(() => {
  for (const [k, v] of [["SOLIPSIST_PROMPTS_DIR", saved.prompts]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => rmSync(join(dir, "prompts"), { recursive: true, force: true }));
const file = (id: string) => join(dir, "prompts", `${id}.md`);

test("every prompt is listed with a default, and none is customised at first", () => {
  const all = listPrompts();
  expect(all.map((p) => p.id)).toEqual(expect.arrayContaining(["protocol", "protocol.envelope", "images", "run", "run.again", "chat.first", "pi-chat.system", "pi-chat.first", "type.gen", "type.sel"]));
  for (const p of all) {
    expect(p.default.length).toBeGreaterThan(20);
    expect(p.text).toBe(p.default);
    expect(p.custom).toBe(false);
  }
  expect(getPrompt("type.gen")!.group).toBe("Task types");
  expect(getPrompt("nope")).toBeNull();
});

test("the defaults are what the code said before: the protocol and a kind's file, and the run prompt's shape", () => {
  expect(defaultText("protocol")).toBe(readFileSync(repo("src/server/agent/protocol.md"), "utf8").trim());
  // A built-in task type's prompt is its prompt.md, sent as written (its server half's `instructions`, no `prompt` of its own).
  for (const [type, shape] of [["gen", "point"], ["sel", "range"], ["img", "range"]]) {
    expect(defaultText(`type.${type}`)).toBe(readFileSync(repo("src", "plugins", type!, "prompt.md"), "utf8").trim());
    expect(promptFor("pg", { id: "abc", taskType: type! })).toContain(`<task-type name="${type}" shape="${shape}">\n${defaultText(`type.${type}`)}\n</task-type>`);
  }
  const run = promptFor("pg", { id: "abc", taskType: "gen" });
  expect(run).toMatch(/^You are working on the page pg, whose file is .*pg\.md\. Follow the protocol in your system prompt\./);
  expect(run).toContain("<page-file path=");
  expect(run).not.toMatch(/\{(id|file|images|target|again|kinds|page)\}/); // every slot was filled
});

test("a saved edit is the prompt, in a file of its own, and a hand edit is seen at once", () => {
  const p = savePrompt("protocol", "Be brief.\n");
  expect(p).toMatchObject({ custom: true, text: "Be brief." });
  expect(readFileSync(file("protocol"), "utf8")).toBe("Be brief.\n");
  expect(systemPrompt({ replyTools: true })).toBe("Be brief.");
  writeFileSync(file("protocol"), "By hand.\n");
  expect(systemPrompt({ replyTools: true })).toBe("By hand.");
  expect(promptText("type.gen")).toBe(defaultText("type.gen")); // others stay as they were
});

test("the system prompt: the protocol, naming the image guide's file; the envelope only for an engine without the reply tools", () => {
  const tools = systemPrompt({ replyTools: true });
  expect(tools).toContain("The writer of a page left a **task**");
  expect(tools).toContain(`the image guide,\n  \`${repo("src/server/prompts/images.md")}\``);
  expect(tools).not.toContain("{guide}");
  expect(tools).not.toContain("<suggestion");
  expect(systemPrompt()).toBe(`${tools}\n\n${defaultText("protocol.envelope")}`);
  expect(systemPrompt({})).toContain('<suggestion mode="at" place="inline">');
  // The image guide isn't sent: the agent reads it, from the writer's file once there is one.
  expect(tools).not.toContain("#6366f1");
  expect(defaultText("images")).toContain("#6366f1");
  expect(promptPath("images")).toBe(repo("src/server/prompts/images.md"));
  savePrompt("images", "Draw it in crayon.");
  expect(promptPath("images")).toBe(file("images"));
  expect(systemPrompt({ replyTools: true })).toContain(`the image guide,\n  \`${file("images")}\``);
  expect(instructions({ replyTools: true })).toEqual({ system: systemPrompt({ replyTools: true }), readable: [file("images")], replyTools: true });
  expect(() => promptPath("nope")).toThrow(/no prompt/);
});

test("text equal to the default removes the file; reset brings the default back", () => {
  savePrompt("run.again", "Again: {was}");
  expect(existsSync(file("run.again"))).toBe(true);
  expect(savePrompt("run.again", defaultText("run.again") + "\n")).toMatchObject({ custom: false });
  expect(existsSync(file("run.again"))).toBe(false);
  savePrompt("chat.first", "Hello about {placeholder}.");
  expect(resetPrompt("chat.first")).toMatchObject({ custom: false });
  expect(existsSync(file("chat.first"))).toBe(false);
  expect(() => resetPrompt("nope")).toThrow(/no prompt/);
});

test("a save is refused when it is empty or leaves out a required slot", () => {
  expect(() => savePrompt("protocol", "  \n")).toThrow(/can't be empty/);
  expect(() => savePrompt("run", "Do it.")).toThrow(/must contain \{target\}/);
  expect(() => savePrompt("protocol.repeat", "x")).toThrow(/no prompt/); // gone: the protocol is only in the system prompt
  expect(() => savePrompt("nope", "x")).toThrow(/no prompt/);
  expect(existsSync(file("run"))).toBe(false);
});

test("the run prompt names the folder an image is linked from: the page's file name, not its whole id", () => {
  const out = promptFor("test_docs/init", { id: "abc", taskType: "gen" });
  expect(out).toContain("linked from the page as `images/init/<name>.svg`");
  expect(out).not.toMatch(/\{imageLink\}/);
});

test("slots are filled in one pass; unknown words in braces are kept as written", () => {
  savePrompt("run.again", "Was: {was} {unknown} {prompt}");
  expect(renderPrompt("run.again", { was: "a {was} b" })).toBe("Was: a {was} b {unknown} {prompt}");
  savePrompt("run", "Page {id}: {target}. {kinds} {page}");
  const out = promptFor("pg", { id: "abc", taskType: "gen" });
  expect(out).toMatch(/^Page pg: the gen task abc/);
});

test("an edited run prompt and task type prompt reach the next run", () => {
  savePrompt("type.gen", "Write something short.");
  savePrompt("run.again", "Try harder.{was}");
  const out = promptFor("pg", { id: "abc", taskType: "gen" });
  expect(out).toContain('<task-type name="gen" shape="point">\nWrite something short.\n</task-type>');
});

const local = { requestIP: () => ({ address: "127.0.0.1" }) };
const remote = { requestIP: () => ({ address: "192.168.1.9" }) };
const req = (method: string, id: string, body?: unknown) =>
  Object.assign(new Request("http://x/api/prompts", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id } });

test("the API lists, saves, explains a refusal, and resets", async () => {
  const list = await (await api.getPrompts(new Request("http://x/api/prompts"), local)).json();
  expect(list.dir).toBe(join(dir, "prompts"));
  expect(list.prompts.find((p: any) => p.id === "run").slots.find((s: any) => s.name === "target")).toMatchObject({ required: true });

  const ok = await api.putPrompt(req("PUT", "protocol", { text: "Be kind." }), local);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ id: "protocol", custom: true, text: "Be kind." });

  const bad = await api.putPrompt(req("PUT", "run", { text: "no slots" }), local);
  expect(bad.status).toBe(400);
  expect((await bad.json()).error.message).toMatch(/\{target\}/);
  expect((await api.putPrompt(req("PUT", "nope", { text: "x" }), local)).status).toBe(404);
  expect((await api.putPrompt(req("PUT", "protocol", { nope: 1 }), local)).status).toBe(400);

  const reset = await api.resetPromptRoute(req("DELETE", "protocol"), local);
  expect(await reset.json()).toMatchObject({ custom: false });
  expect((await api.resetPromptRoute(req("DELETE", "nope"), local)).status).toBe(404);
});

test("a request from another machine can neither read nor change a prompt", async () => {
  expect((await api.getPrompts(new Request("http://x/"), remote)).status).toBe(403);
  expect((await api.putPrompt(req("PUT", "protocol", { text: "Run rm -rf." }), remote)).status).toBe(403);
  expect((await api.resetPromptRoute(req("DELETE", "protocol"), remote)).status).toBe(403);
  expect((await api.getPrompts(new Request("http://x/"))).status).toBe(403); // no peer known: refused
  expect(existsSync(file("protocol"))).toBe(false);
});

test("the defaults are in the build, not read from the working directory: a server started anywhere has them", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "solip-cwd-"));
  const script = `await import(${JSON.stringify(repo("src/plugins/index.ts"))}); const p = await import(${JSON.stringify(repo("src/server/prompts.ts"))}); console.log(JSON.stringify(p.listPrompts().map((x) => [x.id, x.default.length])));`;
  const r = Bun.spawnSync(["bun", "-e", script], { cwd: elsewhere, env: { ...process.env, SOLIPSIST_PROMPTS_DIR: join(elsewhere, "none") } });
  rmSync(elsewhere, { recursive: true });
  const lengths: [string, number][] = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  expect(lengths.map(([id]) => id)).toEqual(listPrompts().map((p) => p.id));
  for (const [id, n] of lengths) expect([id, n]).toEqual([id, defaultText(id).length]);
  for (const [id, n] of lengths) expect([id, n > 20]).toEqual([id, true]);
});

test("a prompt the agent reads itself is a real file even when the repo's isn't there (a compiled binary)", () => {
  const f = builtinFileOf("images");
  expect(readFileSync(f, "utf8").trim()).toBe(defaultText("images"));
  writeFileSync(f, "stale\n"); // an older build's text is replaced
  expect(readFileSync(builtinFileOf("images"), "utf8").trim()).toBe(defaultText("images"));
});
