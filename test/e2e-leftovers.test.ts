// `killLeftovers` (`test/e2e/leftovers.ts`), which the browser suites call before they start one of their own. The
// suites themselves need a real Chrome (`bun run test:ui`); what is tested here is which processes it takes and which
// it leaves, with plain `sleep` processes carrying the suites' marker in their arguments.
//
// Every test passes its own `mark`, so the sweep only ever sees processes this file started: with the real marker it
// would find any browser on the machine, including one a `bun run test:ui` running beside this is using.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ageMs, killLeftovers, marked as markedPids, SWEEP_AFTER_MS, track } from "./e2e/leftovers";

const registry = () => join(tmpdir(), "solip-e2e-leftovers");
const started: { pid: number; kill(): void }[] = [];

/**
 * A process carrying `mark` in its arguments, as a suite's Chrome does. `sleep 60; :` rather than `sleep 60`, so that
 * `sh` does not replace itself with `sleep` — which would drop the marker from the arguments and leave nothing to find.
 */
function marked(mark: string) {
  const proc = Bun.spawn(["sh", "-c", "sleep 60; :", mark], { stdout: "ignore", stderr: "ignore" });
  started.push({ pid: proc.pid, kill: () => proc.kill("SIGKILL") });
  return proc.pid;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Waits for `pid` to go, so a kill that has been asked for isn't read as one that didn't happen. */
async function gone(pid: number) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

afterEach(() => {
  for (const p of started.splice(0)) p.kill();
  // Only what these tests wrote: the registry is shared with any suite running beside this one.
  try { for (const n of readdirSync(registry())) if (n.endsWith(".json")) rmSync(join(registry(), n), { force: true }); } catch {}
});

test("a marker nothing is written down for is swept: a run whose notes went with the temp dir", async () => {
  const mark = `--solip-e2e=test-lost-${process.pid}`;
  const pid = marked(mark);
  // Nothing in the registry: the case the registry alone could never find again.
  expect(killLeftovers(0, mark)).toContain(pid);
  expect(await gone(pid)).toBe(true);
});

test("a browser younger than the sweep's age is left alone, so one being launched now is never caught", async () => {
  const mark = `--solip-e2e=test-young-${process.pid}`;
  const pid = marked(mark);
  // It started a moment ago, so the default age spares it even with nothing written down for it.
  expect(killLeftovers(SWEEP_AFTER_MS, mark)).not.toContain(pid);
  expect(alive(pid)).toBe(true);
});

test("a browser a running suite has written down is left alone, however old", async () => {
  const mark = `--solip-e2e=test-busy-${process.pid}`;
  const pid = marked(mark);
  // Written down by an owner that is alive — this very process stands in for the suite beside us.
  track(pid, "browser");
  expect(killLeftovers(0, mark)).not.toContain(pid);
  expect(alive(pid)).toBe(true);
});

test("what a run that is over wrote down is still killed, and forgotten", async () => {
  const mark = `--solip-e2e=test-over-${process.pid}`;
  const pid = marked(mark);
  const file = join(registry(), `${pid}.json`);
  mkdirSync(registry(), { recursive: true });
  // An owner that is gone: a pid no process has (its own run's), which is what makes this a leftover.
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  writeFileSync(file, JSON.stringify({ pid, started: r.stdout.toString().trim(), owner: 999_999, kind: "browser" }));
  expect(killLeftovers(SWEEP_AFTER_MS, mark)).toContain(pid);
  expect(await gone(pid)).toBe(true);
  expect(readdirSync(registry())).not.toContain(`${pid}.json`);
});

test("a pid since used by something else is never killed", async () => {
  const mark = `--solip-e2e=test-reused-${process.pid}`;
  const pid = marked(mark);
  mkdirSync(registry(), { recursive: true });
  // The note says it started at a different moment, so this is not the process that was written down.
  writeFileSync(join(registry(), `${pid}.json`), JSON.stringify({ pid, started: "Thu Jan  1 00:00:00 2026", owner: 999_999, kind: "browser" }));
  expect(killLeftovers(SWEEP_AFTER_MS, mark)).not.toContain(pid);
  expect(alive(pid)).toBe(true);
});

test("a marker is found although it starts with `--`, which pgrep reads as its own option unless told not to", () => {
  const mark = `--solip-e2e=test-dashes-${process.pid}`;
  const pid = marked(mark);
  // Without `--` before the pattern, pgrep exits with "illegal option -- -" and this is empty: nothing is ever
  // written down and no teardown finds anything, which is how five browsers came to be left running.
  expect(markedPids(mark)).toContain(pid);
});

test("how long a process has been running is read from `ps`, and a pid that is gone has no age", () => {
  const age = ageMs(process.pid);
  expect(age).not.toBeNull();
  expect(age!).toBeGreaterThanOrEqual(0);
  expect(age!).toBeLessThan(24 * 60 * 60_000);
  // A pid nothing holds: `ps` says nothing, and nothing is swept on the strength of it.
  expect(ageMs(999_999)).toBeNull();
});
