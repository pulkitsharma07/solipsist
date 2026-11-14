import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesDir } from "../runtime";

/**
 * The agent processes this server has spawned, one file each, so that a server that starts after one that died
 * (killed, crashed) can stop what that one left running: an agent mid-run would otherwise go on editing its page. Kept
 * per docs folder, outside it. A process is known by its pid and its start time, so a pid used again by something
 * else is never killed: the entry is written just after the process starts, so a process that started after the
 * entry was written is not the one it names.
 *
 * The entry is written at once, with nothing to wait for. It used to ask `ps` for the start time first, and that took
 * up to a few hundred milliseconds under load (or failed outright, and the entry with it): a server killed in that
 * window left its agent running with nothing to find it by.
 */
export const registry = () => join(tmpdir(), `solip-agents-${Bun.hash(pagesDir()).toString(36)}`);

/** `started`: what `ps` said when the process was recorded, in entries written before the file's own time was used. */
interface Entry { pid: number; server: number; started?: string }

/** When a process started, as `ps` says (empty: it is gone); in UTC and English when `utc`. */
const lstart = (pid: number, utc = false) => {
  const env = utc ? { ...process.env, TZ: "UTC", LC_ALL: "C" } : process.env;
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", env });
  return r.stdout.toString().trim();
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** When a process started, in ms, to the second (rounded down); NaN when it is gone. Read in UTC, so no time zone can shift it. */
function startedMs(pid: number): number {
  const m = /^\w{3} +(\w{3}) +(\d+) +(\d+):(\d+):(\d+) +(\d{4})$/.exec(lstart(pid, true));
  if (!m || !MONTHS.includes(m[1]!)) return NaN;
  return Date.UTC(Number(m[6]), MONTHS.indexOf(m[1]!), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}
/**
 * Whether `e.pid` is still the process `e` recorded, in a file written at `writtenMs`: it started before the file was
 * written. (`ps` says the second it started, rounded down, so the one recorded always passes; a pid used again in the
 * same second as the entry was written would too, which a pid isn't.)
 */
function same(e: Entry, writtenMs: number): boolean {
  if (e.started !== undefined) return lstart(e.pid) === e.started;
  return startedMs(e.pid) <= writtenMs;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Records an agent process; the returned function forgets it (call it once the process has exited). */
export function track(pid: number): () => void {
  let file: string | undefined;
  try {
    const dir = registry();
    mkdirSync(dir, { recursive: true });
    writeFileSync((file = join(dir, `${pid}.json`)), JSON.stringify({ pid, server: process.pid } satisfies Entry));
  } catch {}
  return () => { if (file) rmSync(file, { force: true }); };
}

/** A page's agents' scratch folder in the temp dir is named with its server's pid: `solip-agent-run-<pid>-…`. */
export const SCRATCH_PREFIX = "solip-agent-run-";
const SCRATCH_RE = new RegExp(`^${SCRATCH_PREFIX}(\\d+)-`);

/** Removes the scratch folders of servers that are no longer running (one that was killed can't remove its own). */
function removeDeadScratch() {
  let names: string[];
  try { names = readdirSync(tmpdir()); } catch { return; }
  for (const name of names) {
    const pid = Number(SCRATCH_RE.exec(name)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

/**
 * Kills the agent processes a server that is no longer running left behind, and forgets them. Agents of a server that
 * is still running (this one, or another on the same docs folder) are left alone. Returns the pids killed.
 */
export function killLeftovers(): number[] {
  removeDeadScratch();
  const dir = registry();
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const killed: number[] = [];
  for (const name of names) {
    let e: Entry;
    let written: number;
    try { e = JSON.parse(readFileSync(join(dir, name), "utf8")); written = statSync(join(dir, name)).mtimeMs; } catch { rmSync(join(dir, name), { force: true }); continue; }
    if (e.server === process.pid || alive(e.server)) continue;
    if (alive(e.pid) && same(e, written)) {
      try { process.kill(e.pid, "SIGKILL"); killed.push(e.pid); } catch {}
    }
    rmSync(join(dir, name), { force: true });
  }
  return killed;
}
