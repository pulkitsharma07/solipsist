import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesDir } from "./runtime";

/**
 * One server per folder. Two on the same pages would both write them, and their agents would both answer every
 * request. The lock is a file in the temp folder keyed by the pages folder (so the writer's folder stays untouched
 * until they pick their files), made exclusively, naming the process and the address. A lock whose process is gone,
 * or whose address answers nothing (a pid since used by another program), is left over from a crash and is taken
 * over; a lock whose server answers is a second server being started, and is refused with what to do about it.
 */
export const lockPath = (pages = pagesDir()) => join(tmpdir(), `solip-lock-${Bun.hash(pages).toString(36)}.json`);

export interface Lock { pid: number; host: string; port: number; started: string }

export function readLock(path = lockPath()): Lock | null {
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as Lock;
    return typeof l.pid === "number" && typeof l.port === "number" ? l : null;
  } catch {
    return null;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours to signal
  }
};

const answers = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host, port });
    const end = (ok: boolean) => { s.destroy(); done(ok); };
    s.setTimeout(700, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });

/** Whether the server a lock names is really running: its process exists and its address answers. */
export const isRunning = async (l: Lock) => alive(l.pid) && (await answers(l.host, l.port));

export type Acquired = { ok: true } | { ok: false; other: Lock };

/** Takes the lock for this process, or says whose it is. A lock of this very process (a hot reload) is already ours. */
export async function acquire(host: string, port: number, path = lockPath()): Promise<Acquired> {
  const mine: Lock = { pid: process.pid, host, port, started: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { ok: true }; // a temp folder we can't write: don't stop the server for it
    }
    const other = readLock(path);
    if (other?.pid === process.pid) return { ok: true };
    if (other && (await isRunning(other))) return { ok: false, other };
    rmSync(path, { force: true }); // left over from a crash
  }
  return { ok: true };
}

/** Gives the lock up, if it is this process's. */
export function release(path = lockPath()) {
  if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
}

/** What the writer is told when a second server is started: where the first one is, and how to stop it or clear a wrong lock. */
export function conflictMessage(other: Lock, path = lockPath(), platform = process.platform): string {
  const url = `http://${other.host}:${other.port}`;
  const stop = platform === "win32" ? `taskkill /PID ${other.pid}` : `kill ${other.pid}`;
  return [
    `Solipsist is already running for this folder (process ${other.pid}, ${url}, started ${other.started.slice(0, 16).replace("T", " ")} UTC).`,
    "",
    `  - To use it, open ${url} in your browser.`,
    `  - To stop it, press Ctrl+C in the terminal it runs in, or run: ${stop}`,
    `  - If nothing is running and this is wrong, delete ${path} and start again.`,
  ].join("\n");
}
