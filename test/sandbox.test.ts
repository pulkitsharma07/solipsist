// The test sandbox (`sandbox.ts`) holds for test helpers that run as a process of their own, not only for test files:
// one started by hand, outside `bun test`, once ran on the developer's real Pi login and began a real, paid agent run.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** The developer's environment as a shell would give it to a script run by hand: keys set, no sandbox. */
const byHand = () => {
  const env: Record<string, string> = { ...process.env as Record<string, string>, SOLIPSIST_OPENROUTER_KEY: "sk-or-v1-real-looking", OPENROUTER_API_KEY: "sk-or-v1-real-looking", SOME_PROVIDER_API_KEY: "sk-real-looking", SOME_PROVIDER_OAUTH_TOKEN: "real-looking" };
  for (const k of ["PI_CODING_AGENT_DIR", "SOLIPSIST_CONFIG", "SOLIPSIST_PROJECT_ROOT", "AGENT_CMD"]) delete env[k];
  return env;
};

test("loading the sandbox blanks every key and points Pi, the config and the project at scratch folders", () => {
  const r = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "sandbox.ts"))}); console.log(JSON.stringify(process.env))`], { cwd: ROOT, env: byHand(), stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  const env = JSON.parse(r.stdout.toString());
  expect([env.SOLIPSIST_OPENROUTER_KEY, env.OPENROUTER_API_KEY, env.SOME_PROVIDER_API_KEY, env.SOME_PROVIDER_OAUTH_TOKEN]).toEqual(["", "", "", ""]);
  const tmp = [tmpdir(), "/private" + tmpdir(), "/var/folders", "/private/var/folders"];
  for (const k of ["PI_CODING_AGENT_DIR", "SOLIPSIST_CONFIG", "SOLIPSIST_PROJECT_ROOT"]) expect(tmp.some((t) => String(env[k]).startsWith(t))).toBe(true);
});

test("the agent helper, started by hand without its fake agent, refuses to run instead of reaching a real one", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "agent-server.ts"), "p0"], { cwd: ROOT, env: byHand(), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("AGENT_CMD");
  expect(r.stdout.toString()).not.toContain("event: start");
});

/** Every `.ts` file under test/ that a test starts as a process of its own (`Bun.spawn(["bun", <file>])`). */
function spawnedHelpers(): string[] {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "fixtures") walk(p); } else if (/\.tsx?$/.test(f)) files.push(p); } };
  walk(import.meta.dir);
  const found = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/Bun\.spawn\(\[\s*"bun",\s*([^\]]*?)\]/g)) {
      const name = m[1]!.match(/["'`]([^"'`]*?\.tsx?)["'`]/)?.[1];
      if (!name || m[1]!.startsWith('"test"')) continue; // `bun test …` loads the preload itself
      const all = files.filter((x) => x.endsWith(`/${name.replace(/^\.?\/?(test\/)?/, "")}`));
      for (const x of all) found.add(relative(ROOT, x));
    }
  }
  return [...found].sort();
}

test("every test helper that runs as a process of its own loads the sandbox before anything else", () => {
  const helpers = spawnedHelpers();
  expect(helpers).toEqual(expect.arrayContaining(["test/agent-server.ts", "test/chat-harness/server.ts", "test/e2e/pi-server.ts"]));
  for (const h of helpers) {
    const first = readFileSync(join(ROOT, h), "utf8").match(/^import\s[^;]*;/m)?.[0];
    expect({ helper: h, first }).toEqual({ helper: h, first: expect.stringMatching(/^import "(\.\.?\/)+(test\/)?sandbox";$/) });
  }
});
