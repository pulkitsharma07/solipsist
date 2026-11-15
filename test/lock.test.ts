// One server per folder (src/server/lock.ts).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, conflictMessage, isRunning, readLock, release } from "../src/server/lock";

const dir = mkdtempSync(join(tmpdir(), "lock-"));
const path = join(dir, "x.json");
let listening: Server | undefined;
afterEach(() => { rmSync(path, { force: true }); listening?.close(); listening = undefined; });

const listen = () => new Promise<number>((r) => { listening = createServer().listen(0, "127.0.0.1", () => r((listening!.address() as any).port)); });
const write = (l: object) => writeFileSync(path, JSON.stringify(l));

test("a free folder: the lock is taken and names this process; releasing removes it", async () => {
  expect(await acquire("localhost", 3000, path)).toEqual({ ok: true });
  expect(readLock(path)).toMatchObject({ pid: process.pid, host: "localhost", port: 3000 });
  release(path);
  expect(existsSync(path)).toBe(false);
});

test("our own lock again (a hot reload) is still ours", async () => {
  await acquire("localhost", 3000, path);
  expect(await acquire("localhost", 3000, path)).toEqual({ ok: true });
});

test("a live server's lock refuses a second one, naming it", async () => {
  const port = await listen();
  write({ pid: process.ppid, host: "127.0.0.1", port, started: "2026-11-15T10:00:00Z" }); // a live process other than this one
  const r = await acquire("127.0.0.1", port, path);
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.other.pid).toBe(process.ppid);
  expect(readLock(path)?.pid).toBe(process.ppid); // the refused one didn't touch it
});

test("a lock left by a crash is taken over: the process is gone, or its address answers nothing", async () => {
  write({ pid: 2 ** 22 + 12345, host: "127.0.0.1", port: 1, started: "x" });
  expect(await acquire("localhost", 3000, path)).toEqual({ ok: true });
  expect(readLock(path)?.pid).toBe(process.pid);
  rmSync(path);
  write({ pid: process.ppid, host: "127.0.0.1", port: 1, started: "x" }); // the pid lives (reused), nothing listens
  expect(await acquire("localhost", 3000, path)).toEqual({ ok: true });
});

test("a torn lock file is taken over; a lock of another process is never released by this one", async () => {
  writeFileSync(path, "{torn");
  expect(await acquire("localhost", 3000, path)).toEqual({ ok: true });
  write({ pid: process.ppid, host: "h", port: 1, started: "x" });
  release(path);
  expect(existsSync(path)).toBe(true);
});

test("isRunning needs both the process and the address", async () => {
  const port = await listen();
  expect(await isRunning({ pid: process.pid, host: "127.0.0.1", port, started: "" })).toBe(true);
  expect(await isRunning({ pid: process.pid, host: "127.0.0.1", port: 1, started: "" })).toBe(false);
  expect(await isRunning({ pid: 2 ** 22 + 12345, host: "127.0.0.1", port, started: "" })).toBe(false);
});

test("the message says where it runs, how to stop it, and how to clear a wrong lock", () => {
  const l = { pid: 4242, host: "localhost", port: 3000, started: "2026-11-15T10:32:00.000Z" };
  const m = conflictMessage(l, "/tmp/solip-lock-x.json", "darwin");
  expect(m).toContain("already running for this folder (process 4242, http://localhost:3000, started 2026-11-15 10:32 UTC)");
  expect(m).toContain("open http://localhost:3000 in your browser");
  expect(m).toContain("kill 4242");
  expect(m).toContain("delete /tmp/solip-lock-x.json and start again");
  expect(conflictMessage(l, "C:\\t\\x.json", "win32")).toContain("taskkill /PID 4242");
});

test("two real servers on one folder: the second is refused with the message, and the first keeps serving", async () => {
  const folder = mkdtempSync(join(tmpdir(), "two-"));
  const root = join(import.meta.dir, "..");
  const env = { ...process.env, PORT: "47311", SOLIPSIST_TUI: "0" };
  const first = Bun.spawn(["bun", join(root, "src/index.ts")], { cwd: folder, env, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 50 && !(await isRunning({ pid: first.pid, host: "localhost", port: 47311, started: "" })); i++) await Bun.sleep(200);
    const second = Bun.spawnSync(["bun", join(root, "src/index.ts")], { cwd: folder, env: { ...env, PORT: "47312" }, stdout: "pipe", stderr: "pipe" });
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain(`already running for this folder (process ${first.pid}`);
    expect((await fetch("http://localhost:47311/")).status).toBe(200);
  } finally {
    first.kill();
    await first.exited;
  }
  // The first one released its lock on the way out.
  const after = Bun.spawn(["bun", join(root, "src/index.ts")], { cwd: folder, env: { ...env, PORT: "47313" }, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 50 && !(await isRunning({ pid: after.pid, host: "localhost", port: 47313, started: "" })); i++) await Bun.sleep(200);
    expect(await isRunning({ pid: after.pid, host: "localhost", port: 47313, started: "" })).toBe(true);
  } finally {
    after.kill();
    await after.exited;
  }
}, 40_000);
