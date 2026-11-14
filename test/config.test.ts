import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ENV_ONLY, loadConfig, printConfig, TABLE } from "../src/server/config";
import { renderExample, spliceReference } from "../src/server/configDocs";

// Everything goes through loadConfig with a scratch folder and an explicit env: no real file, no real environment.
let root: string;
let home: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "solip-config-"));
  home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "notes"));
  mkdirSync(join(root, "work"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const load = (yaml: string | null, env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(root, "case-"));
  if (yaml !== null) writeFileSync(join(dir, "solipsist.yaml"), yaml);
  return loadConfig({ cwd: dir, env, home });
};
const fails = (yaml: string | null, env: Record<string, string>, message: RegExp | string) => {
  try { load(yaml, env); } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected a ConfigError");
};

test("no file: every default, a project in the working directory", () => {
  const c = load(null);
  expect(c.file).toBeNull();
  expect(c.server).toEqual({ port: 3000, host: "localhost" });
  expect(c.agent).toMatchObject({ gap_ms: 1000, settle_ms: 2000, concurrency: 3, max_runs: 6, run_timeout_ms: 600000, wait_ms: 300000, max_waiting: 6, max_failures: 3 });
  expect(c.agent.cost_limit_usd).toBeUndefined();
  expect(c.suggestions).toEqual({ max_chars: 20000, max_edits: 20 });
  expect(c.chat.max_message_chars).toBe(20000);
  expect(c.pi.models[0]).toBe("openrouter/~deepseek/deepseek-flash-latest");
  // No preferred models of the writer's own: the engines' own order decides the default.
  expect(c.agent.preferred_models).toEqual(["pi:openrouter/~deepseek/deepseek-flash-latest"]);
  expect(c.pi.openrouter_key).toBeUndefined();
  expect(c.md_search_paths).toEqual(["*.md"]);
  expect(c.pagesDir.endsWith(join(".solipsist", "pages"))).toBe(true);
  expect(c.log.file).toBe(join(c.pagesDir, "..", "server.log"));
  expect(Object.values(c.sources).every((s) => s === "default")).toBe(true);
});

test("the file overrides the defaults, the environment overrides the file", () => {
  const yaml = "server:\n  port: 4000\nagent:\n  concurrency: 2\n  cost_limit_usd: 1.5\npi:\n  models: [a/b, c/d]\n";
  const c = load(yaml);
  expect(c.server.port).toBe(4000);
  expect(c.agent).toMatchObject({ concurrency: 2, cost_limit_usd: 1.5 });
  expect(c.pi.models).toEqual(["a/b", "c/d"]);
  expect(c.sources["server.port"]).toBe("file");
  const e = load(yaml, { PORT: "5000", AGENT_CONCURRENCY: "4", SOLIPSIST_PI_MODELS: "x/y, z/w ", MOCK_COMMENTS: "1" });
  expect(e.server.port).toBe(5000);
  expect(e.agent.concurrency).toBe(4);
  expect(e.pi.models).toEqual(["x/y", "z/w"]);
  expect(e.dev.mock_comments).toBe(true);
  expect(e.sources["server.port"]).toBe("env:PORT");
});

test("an empty variable is unset; booleans take the old spellings", () => {
  expect(load("server:\n  port: 4000\n", { PORT: "" }).server.port).toBe(4000);
  expect(load(null, { SOLIPSIST_TUI: "0" }).log.tui).toBe(false);
  expect(load(null, { SOLIPSIST_LOG: "off" }).log.file).toBe("off");
  expect(load(null, { SOLIPSIST_LOG: "0" }).log.file).toBe("off");
});

test("md_search_paths are patterns, kept as written", () => {
  const c = load("md_search_paths:\n  - \"*.md\"\n  - docs/**/*.md\n  - specs\n");
  expect(c.md_search_paths).toEqual(["*.md", "docs/**/*.md", "specs"]);
  expect(c.sources.md_search_paths).toBe("file");
});

test("the pages are always the project's own working copies: nothing names a pages folder", () => {
  // `DOCS_DIR` used to, under the test runner, and it was the only thing in the app with two modes behind it.
  const dir = mkdtempSync(join(root, "docs-"));
  const c = loadConfig({ cwd: dir, env: { DOCS_DIR: "./pages", NODE_ENV: "test" }, home });
  expect(c.pagesDir).toBe(join(dir, ".solipsist", "pages"));
  expect(c.log.file).toBe(join(dir, ".solipsist", "server.log"));
});

test("the file is found by --config / SOLIPSIST_CONFIG, then the working directory, then the user's", () => {
  const dir = mkdtempSync(join(root, "find-"));
  const other = join(dir, "other.yaml");
  writeFileSync(other, "server:\n  port: 1111\n");
  writeFileSync(join(dir, "solipsist.yaml"), "server:\n  port: 2222\n");
  mkdirSync(join(home, ".config", "solipsist"), { recursive: true });
  writeFileSync(join(home, ".config", "solipsist", "config.yaml"), "server:\n  port: 3333\n");
  expect(loadConfig({ cwd: dir, env: { SOLIPSIST_CONFIG: other }, home }).server.port).toBe(1111);
  expect(loadConfig({ cwd: dir, file: other, env: {}, home }).server.port).toBe(1111);
  expect(loadConfig({ cwd: dir, env: {}, home }).server.port).toBe(2222);
  const bare = mkdtempSync(join(root, "bare-"));
  expect(loadConfig({ cwd: bare, env: {}, home }).server.port).toBe(3333);
  rmSync(join(home, ".config"), { recursive: true });
  expect(() => loadConfig({ cwd: dir, file: join(dir, "nope.yaml"), env: {}, home })).toThrow(/does not exist/);
});

test("errors name the key, or the variable for an environment value", () => {
  fails("agent:\n  concurrency: three\n", {}, 'solipsist.yaml: agent.concurrency must be a whole number ≥ 1 (got "three")');
  fails("agent:\n  concurrency: 0\n", {}, /agent\.concurrency must be a whole number ≥ 1 \(got 0\)/);
  fails("agent:\n  concurrency: 1.5\n", {}, /agent\.concurrency/);
  fails(null, { AGENT_CONCURRENCY: "three" }, 'AGENT_CONCURRENCY must be a whole number ≥ 1 (got "three")');
  fails(null, { PORT: "70000" }, /PORT must be a whole number from 0 to 65535/);
  fails(null, { SOLIPSIST_TUI: "maybe" }, /SOLIPSIST_TUI must be true or false/);
  fails("agent:\n  cost_limit_usd: 0\n", {}, /agent\.cost_limit_usd must be a number > 0/);
  fails("pi:\n  models: []\n", {}, /pi\.models must be a list of text/);
  fails("pi:\n  models: just-one\n", {}, /pi\.models/);
});

test("unknown keys and sections are errors, with a hint for a near miss", () => {
  fails("agent:\n  concurency: 2\n", {}, "solipsist.yaml: unknown key agent.concurency (did you mean agent.concurrency?)");
  fails("colour: red\n", {}, /unknown key colour/);
  fails("agent: 3\n", {}, /agent must be a section/);
  fails("- a\n- b\n", {}, /must be a mapping/);
  fails("agent: [unclosed\n", {}, /not valid YAML/);
  expect(load("agent:\n")).toBeTruthy(); // an empty section is fine
  expect(load("agent:\n  cost_limit_usd:\n").agent.cost_limit_usd).toBeUndefined(); // so is an empty value
});

test("a pattern must stay inside the project, and there must be one", () => {
  fails("md_search_paths: [/etc/*.md]\n", {}, /md_search_paths\[0\] must stay inside the project/);
  fails("md_search_paths: [\"*.md\", ../other/*.md]\n", {}, /md_search_paths\[1\] must stay inside the project/);
  fails("md_search_paths: [~/notes]\n", {}, /md_search_paths\[0\] must stay inside the project/);
  fails("md_search_paths: []\n", {}, /md_search_paths/);
});

test("a secret is never in an error or in --print-config", () => {
  fails("pi:\n  openrouter_key: [1]\n", {}, /^solipsist\.yaml: pi\.openrouter_key must be text$/);
  const c = load("pi:\n  openrouter_key: sk-or-SECRET\n", {});
  expect(c.pi.openrouter_key).toBe("sk-or-SECRET");
  const text = printConfig(c);
  expect(text).not.toContain("SECRET");
  expect(text).toContain("pi.openrouter_key: set  [file]");
  expect(text).toContain("agent.cost_limit_usd: unset  [default]");
});

test("the table is consistent: unique keys and env names, none in the env-only list, a default or an example", () => {
  const keys = TABLE.map((s) => s.key);
  expect(new Set(keys).size).toBe(keys.length);
  const envs = [...TABLE.map((s) => s.env), ...ENV_ONLY.map((e) => e.name)];
  expect(new Set(envs).size).toBe(envs.length);
  for (const s of TABLE) {
    expect(s.summary.length).toBeGreaterThan(10);
    expect(s.purpose.length).toBeGreaterThan(10);
    if (s.default === undefined) expect(s.example).toBeDefined();
  }
});

test("solipsist.example.yaml parses to the defaults and is current; CONFIGURATION.md is current", () => {
  const example = readFileSync(join(import.meta.dir, "../solipsist.example.yaml"), "utf8");
  expect(example).toBe(renderExample());
  const dir = mkdtempSync(join(root, "example-"));
  writeFileSync(join(dir, "solipsist.yaml"), example);
  const c = loadConfig({ cwd: dir, env: {}, home });
  const d = load(null);
  const { file: _f, sources: _s, ...rest } = c;
  const { file: _f2, sources: _s2, ...expected } = d;
  expect(rest).toEqual({ ...expected, projectRoot: dir, pagesDir: join(dir, ".solipsist", "pages"), log: { ...expected.log, file: join(dir, ".solipsist", "server.log") } });
  expect(Object.values(c.sources).filter((s) => s !== "file" && s !== "default")).toEqual([]);
  for (const s of TABLE) if (s.default !== undefined) expect(example).toContain(`${s.key.split(".").at(-1)}:`);
  const doc = readFileSync(join(import.meta.dir, "../CONFIGURATION.md"), "utf8");
  expect(doc).toBe(spliceReference(doc));
  for (const s of TABLE) expect(doc).toContain(`#### \`${s.key}\``);
});

test("every yaml example in CONFIGURATION.md loads, and names no one's own paths or keys", () => {
  const doc = readFileSync(join(import.meta.dir, "../CONFIGURATION.md"), "utf8");
  const examples = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  expect(examples.length).toBeGreaterThan(0);
  for (const yaml of examples) expect(() => load(yaml)).not.toThrow();
  expect(doc).not.toMatch(/\/(Users|home)\/[a-z]|[\w.+-]+@[\w-]+\.[a-z]{2,}|sk-(or-v1|ant-api03)-[A-Za-z0-9]{8,}/);
});
