// A server that dies (SIGKILL, a crash) can't stop its agents: the next server to start on the same docs folder does
// (`killLeftovers`), and leaves alone the agents of a server that is still running, and a pid now used by another process.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killLeftovers, registry, track } from "../src/server/agent/leftovers";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "solip-leftovers-")));
const root = dir;
const docs = join(dir, ".solipsist", "pages");
mkdirSync(docs, { recursive: true });
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT;
const restoreProject = () => { if (wasProject === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT; else process.env.SOLIPSIST_PROJECT_ROOT = wasProject; };
// The registry is per pages folder: the same project as the servers below. Entered in `beforeAll`, since
// every test file in the process shares one working directory.
afterAll(() => {
  restoreProject();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms = 5000) => { for (const t = Date.now(); !ok(); await wait(20)) if (Date.now() - t > ms) throw new Error("timeout"); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const started: number[] = [];
afterEach(() => { for (const p of started.splice(0)) try { process.kill(p, "SIGKILL"); } catch {} });

let n = 0;
/** A server (its own process) with one page open, whose fake agent takes the prompt and then works for 30 s. */
async function server() {
  const id = `p${n++}`;
  const pids = join(dir, `${id}.pids`);
  writeFileSync(join(docs, `${id}.md`), "Text <!-- gen:abc -->");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "agent-server.ts"), id], {
    cwd: root,
    env: { ...process.env, AGENT_CMD: JSON.stringify(["sh", "-c", `echo $$ >> ${pids}; read l; exec sleep 30`]) },
    stdout: "ignore",
    stderr: "inherit",
  });
  started.push(proc.pid);
  await until(() => existsSync(pids) && readFileSync(pids, "utf8").trim() !== "");
  const agent = Number(readFileSync(pids, "utf8").trim().split("\n")[0]);
  started.push(agent);
  // The server records its agent in the same tick as it starts it, but the agent may say its pid first.
  await until(() => existsSync(join(registry(), `${agent}.json`)));
  return { proc, agent };
}

beforeAll(() => void (process.env.SOLIPSIST_PROJECT_ROOT = root));
test("an agent left running by a server that was killed is stopped by the next one", async () => {
  const { proc, agent } = await server();
  proc.kill("SIGKILL");
  await proc.exited;
  await wait(300);
  expect(alive(agent)).toBe(true); // nothing stopped it: it would go on working on its page
  expect(killLeftovers()).toEqual([agent]);
  await until(() => !alive(agent));
  expect(killLeftovers()).toEqual([]); // forgotten
});

test("the agents of a server still running are left alone", async () => {
  const { proc, agent } = await server();
  expect(killLeftovers()).toEqual([]);
  await wait(100);
  expect(alive(agent)).toBe(true);
  proc.kill("SIGKILL");
  await proc.exited;
  expect(killLeftovers()).toEqual([agent]);
});

test("a recorded pid now used by another process is not killed", async () => {
  // Recorded with a start time that isn't this process's: as if the agent had exited and its pid been reused.
  const other = Bun.spawn(["sleep", "30"]);
  started.push(other.pid);
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const registry = join(tmpdir(), `solip-agents-${Bun.hash(docs).toString(36)}`);
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, `${other.pid}.json`), JSON.stringify({ pid: other.pid, started: "Mon Jan  1 00:00:00 2001", server: dead.pid }));
  expect(killLeftovers()).toEqual([]);
  expect(alive(other.pid)).toBe(true);
});

test("a recorded pid whose process started after the entry was written is not killed", async () => {
  // An entry is written just after its process starts: one older than the process is about an earlier one of that pid.
  const other = Bun.spawn(["sleep", "30"]);
  started.push(other.pid);
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  const file = join(registry(), `${other.pid}.json`);
  mkdirSync(registry(), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: other.pid, server: dead.pid }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
  expect(killLeftovers()).toEqual([]);
  expect(alive(other.pid)).toBe(true);
  expect(existsSync(file)).toBe(false); // forgotten
});

test("an agent recorded by a server that died before it said anything more is still found", async () => {
  // All a dead server may have written is the pid and itself: that is enough.
  const agent = Bun.spawn(["sleep", "30"]);
  started.push(agent.pid);
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  mkdirSync(registry(), { recursive: true });
  writeFileSync(join(registry(), `${agent.pid}.json`), JSON.stringify({ pid: agent.pid, server: dead.pid }));
  expect(killLeftovers()).toEqual([agent.pid]);
  await agent.exited;
});

test("a server's own agents are recorded while they run, and forgotten once they exit", async () => {
  const p = Bun.spawn(["sleep", "30"]);
  started.push(p.pid);
  const forget = track(p.pid);
  const file = join(tmpdir(), `solip-agents-${Bun.hash(docs).toString(36)}`, `${p.pid}.json`);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: p.pid, server: process.pid });
  expect(killLeftovers()).toEqual([]); // this server is alive
  forget();
  expect(existsSync(file)).toBe(false);
});
