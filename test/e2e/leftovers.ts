// What the browser suites (`bun run test:ui`) start, and how none of it is left running afterwards.
//
// A leftover is invisible and permanent: a headless Chrome or a test server keeps its memory and its port, and the
// next run leaves another beside it. Three things went wrong before this. One suite launched Chrome with nothing to
// name it by, so no teardown could find it again. `pkill` on the marker killed the browser process but not the
// helpers it had started, which went on running. And a teardown that never ran — the run was killed, a `beforeAll`
// threw — left everything that run had started, for ever.
//
// So, the way the server deals with the agents a dead server left (`src/server/agent/leftovers.ts`, the same shape):
// everything a suite starts is written down, the next run kills what a run that is over left behind, a browser is
// killed by its process group rather than alone, and a run that ends in any ordinary way cleans up after itself. A
// process is known by its pid and its start time, so a pid since used by something else is never killed, and only a
// run whose own process is gone is tidied up — a suite running beside this one is left alone.
//
// A fourth went wrong after that (five browsers found running, 2026-11-08, the oldest four days old). What is written
// down lives in the temp dir, and the temp dir is swept. A run killed outright runs none of its handlers, and once its
// notes have gone with the temp folder the browsers it left are invisible for ever: nothing looks for them again. So
// the marker is swept too — it is the part that lives on the process itself and outlasts any note about it. Anything
// written down is left alone, which is still what protects a suite running beside this one, and among the rest only a
// browser older than `SWEEP_AFTER_MS` is taken, so one being launched this moment is never caught.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

/** Every suite's Chrome carries this in its arguments; what follows names the run. */
const MARK = "--solip-e2e=";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const registry = () => join(tmpdir(), "solip-e2e-leftovers");

interface Entry {
  pid: number;
  /** When it started, so a pid used again by something else is never killed. */
  started: string;
  /** The test run that started it: while that is alive, this is not a leftover. */
  owner: number;
  /** A browser is killed with the helpers it started; a server is killed alone. */
  kind: "browser" | "server";
}

/** When a process started, as `ps` says (empty: it is gone). */
const startedAt = (pid: number) => {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return r.stdout.toString().trim();
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * How long a process has been running, in ms, as `ps` says it (`[[dd-]hh:]mm:ss`); null when it is gone or `ps` says
 * something this doesn't read. macOS `ps` has no `etimes`, so the elapsed time is parsed.
 */
export function ageMs(pid: number): number | null {
  const r = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const said = r.stdout.toString().trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(said);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return ((((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60) + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/**
 * How old a browser nothing has written down must be before the marker sweep takes it. Long enough that one being
 * launched right now — by a suite beside this one, in the moment between starting it and writing it down — is never
 * caught, and short enough that the next run clears what the one before it left.
 */
export const SWEEP_AFTER_MS = 10 * 60_000;

/**
 * Kills a browser and the helpers it started. Playwright puts each browser in its own process group, so the group is
 * what has to go: killing the browser alone can leave its helpers running, which is how they piled up.
 */
function killTree(pid: number) {
  try { process.kill(-pid, "SIGKILL"); return; } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

/**
 * The pids of the Chromes whose marker starts with `mark` (every suite's, by default).
 *
 * `--` before the pattern, and not for tidiness: the marker itself starts with `--`, and without it `pgrep` reads the
 * pattern as one of its own options and exits with `illegal option -- -`, finding nothing. That is how the browsers
 * piled up after they were supposed to be looked after — nothing was ever written down, and no teardown ever found
 * anything to kill, each silently (`killLeftovers` is called for its effect, and tracking a pid that was never
 * returned is a no-op). The tests below pin it.
 */
export function marked(mark = MARK): number[] {
  const found = Bun.spawnSync(["pgrep", "-f", "--", mark], { stdout: "pipe", stderr: "ignore" });
  return found.stdout.toString().split("\n").map((s) => Number(s.trim())).filter((pid) => pid > 0 && pid !== process.pid);
}

/** Writes down something this run started; the returned function forgets it, once it has been stopped. */
export function track(pid: number, kind: Entry["kind"]): () => void {
  const file = join(registry(), `${pid}.json`);
  try {
    mkdirSync(registry(), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid, started: startedAt(pid), owner: process.pid, kind } satisfies Entry));
  } catch {}
  return () => rmSync(file, { force: true });
}

/** A server a suite started (`Bun.spawn`), so a run that is killed doesn't leave it holding its port. */
export function trackServer<T extends { pid: number }>(proc: T): T {
  track(proc.pid, "server");
  return proc;
}

/** Said when a teardown has stopped the server itself, so no later run goes looking for it. */
export function untrackServer(proc?: { pid: number }) {
  if (proc) rmSync(join(registry(), `${proc.pid}.json`), { force: true });
}

/**
 * Kills the browsers and servers a run that is no longer going left behind, and forgets them. What this run, or
 * another running beside it, started is left alone. Returns the pids killed.
 */
export function killLeftovers(sweepAfterMs = SWEEP_AFTER_MS, mark = MARK): number[] {
  const killed: number[] = [];
  /** Every pid something is written down for, whether it is killed here or left alone: the marker sweep skips these. */
  const noted = new Set<number>();
  let names: string[] = [];
  try { names = readdirSync(registry()).filter((n) => n.endsWith(".json")); } catch {}
  for (const name of names) {
    const file = join(registry(), name);
    let e: Entry;
    try { e = JSON.parse(readFileSync(file, "utf8")); } catch { rmSync(file, { force: true }); continue; }
    noted.add(e.pid);
    if (e.owner === process.pid || alive(e.owner)) continue;
    if (alive(e.pid) && e.started && startedAt(e.pid) === e.started) {
      if (e.kind === "browser") killTree(e.pid);
      else try { process.kill(e.pid, "SIGKILL"); } catch {}
      killed.push(e.pid);
    }
    rmSync(file, { force: true });
  }
  // The browsers carrying a suite's marker that nothing is written down for: a run whose notes went with the temp dir
  // they lived in. Without this they are never found again, since the registry is the only other record of them.
  for (const pid of marked(mark)) {
    if (noted.has(pid) || killed.includes(pid)) continue;
    const age = ageMs(pid);
    if (age === null || age < sweepAfterMs) continue;
    killTree(pid);
    killed.push(pid);
  }
  return killed;
}

/** What this run has open, stopped when it ends in any way an `exit` handler can see. */
const open = new Set<() => void>();
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  // Synchronous, since that is all an `exit` handler may be. A run that is killed outright leaves its own cleaning
  // up to the next run's `killLeftovers`, which is why everything is written down.
  const sweep = () => { for (const stop of [...open]) stop(); };
  process.once("exit", sweep);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => { sweep(); process.exit(1); });
}

export interface E2EBrowser {
  browser: Browser;
  /** Closes it, and kills whatever is left of it. Safe to call twice, or not at all. */
  close(): Promise<void>;
}

/**
 * Chrome for one suite, named after `run` (its scratch folder, say) so it can always be found again. Kills what runs
 * that are over left behind before it starts, and its own browser when this run ends.
 */
export async function launchBrowser(run: string, opts: LaunchOptions = {}): Promise<E2EBrowser> {
  const left = killLeftovers();
  if (left.length) console.error(`e2e: killed ${left.length} process(es) an earlier run left behind`);

  install();
  const mark = `${MARK}${run}`;
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL ?? "chrome",
    ...opts,
    args: [mark, ...(opts.args ?? [])],
  });
  const forget = marked(mark).map((pid) => track(pid, "browser"));

  let shut = false;
  const kill = () => {
    if (shut) return;
    shut = true;
    for (const pid of marked(mark)) killTree(pid);
    for (const f of forget) f();
    open.delete(kill);
  };
  open.add(kill);

  return {
    browser,
    async close() {
      if (shut) return;
      // Now and then Chrome doesn't quit on close (1 run in 5 or so) and Playwright waits for it with no timeout, and
      // one that lost its connection (the machine slept) refuses to close: give it a few seconds, then kill it.
      await Promise.race([browser.close().catch(() => {}), wait(5000)]);
      kill();
    },
  };
}

/**
 * A random port from `base` to `base + span`, never one Chrome refuses to load (`net::ERR_UNSAFE_PORT`: 5060 and 5061,
 * SIP, are in every range the suites use).
 */
export function testPort(base: number, span = 800): number {
  const unsafe = new Set([5060, 5061]);
  for (;;) {
    const port = base + Math.floor(Math.random() * span);
    if (!unsafe.has(port)) return port;
  }
}
