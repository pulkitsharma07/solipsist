import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

/**
 * The server's log of its core actions: one JSON line per action, `{"t":"<ISO time>","action":"run.end",…}`, so a
 * page's story (saves, disk edits, runs, acks, chats, errors) can be read back or grepped. In
 * `SOLIPSIST_LOG` (a file path), by default `.solipsist/server.log`; `SOLIPSIST_LOG=off` turns it off, and
 * it is off under `bun test` unless `SOLIPSIST_LOG` is set. Past `log.max_bytes` the file moves to `server.log.1`
 * (the one before is dropped). Writing it never fails the action it records. The terminal view (`tui.ts`) shows the
 * latest lines too.
 */

export interface LogLine { t: string; action: string; [k: string]: unknown }


/** The log file, or null when logging is off. */
export function logFile(): string | null {
  const c = config();
  if (c.log.file === "off") return null;
  // Under `bun test` the log is off unless a path is set on purpose.
  if (c.sources["log.file"] === "default" && process.env.NODE_ENV === "test") return null;
  return c.log.file;
}

const listeners = new Set<(line: LogLine) => void>();
/** Hears every line logged from now on (the terminal view); the returned function stops. */
export function onLog(f: (line: LogLine) => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

let written = 0;
export function log(action: string, data: Record<string, unknown> = {}) {
  const line: LogLine = { t: new Date().toISOString(), action, ...data };
  for (const f of listeners) try { f(line); } catch {}
  const file = logFile();
  if (!file) return;
  try {
    const text = `${JSON.stringify(line)}\n`;
    // Checked now and then, not on every line.
    if ((written += text.length) > 64 * 1024) {
      written = 0;
      try { if (statSync(file).size > config().log.max_bytes) renameSync(file, `${file}.1`); } catch {}
    }
    // A project's folder is made when the writer picks their files: until then, launching leaves nothing behind.
    if (config().sources["log.file"] === "default" && !existsSync(dirname(file))) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text);
  } catch {}
}

/** An error's message, for a log line. */
export const why = (e: unknown) => String((e as Error)?.message ?? e);
