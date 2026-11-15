/**
 * `solipsist doctor`: what a bug report needs, in one paste. The version, the system, which settings file is in
 * effect, whether the port is free, whether the folder can be written, which engines can run (and why one can't),
 * and the last errors in the log. Nothing private: no key, no page text, home shown as `~`; run it in the folder
 * that has the problem.
 */
import { existsSync, readdirSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform, release } from "node:os";
import { config } from "./config";
import { engines, warmEngines } from "./agent/engines";
import { logFile } from "./log";
import { versionLine } from "./version";
import piPkg from "../../node_modules/@earendil-works/pi-coding-agent/package.json";

export interface DoctorReport {
  version: string;
  system: string;
  runtime: string;
  pi: string;
  configFile: string | null;
  server: { host: string; port: number; free: boolean };
  folder: { root: string; pages: string; exists: boolean; writable: boolean; count: number };
  engines: { name: string; problem: string | null }[];
  log: { file: string | null; errors: string[] };
}

/** `~` for the home folder, so a pasted report doesn't carry the user's name. */
export const tilde = (s: string, home = homedir()) => (home ? s.split(home).join("~") : s);

/** The last `n` lines of a log that record a failure: an action ending `.error`/`.failed`, or carrying an `error`. */
export function lastErrors(text: string, n = 5): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw) as { t?: string; action?: string; error?: unknown; message?: unknown };
      const bad = /(^|\.)(error|failed|fail)$/.test(l.action ?? "") || l.error !== undefined;
      if (bad) out.push(`${l.t ?? ""} ${l.action ?? ""} ${String(l.error ?? l.message ?? "")}`.trim());
    } catch { /* a torn line: skip it */ }
  }
  return out.slice(-n);
}

const portFree = (host: string, port: number) =>
  new Promise<boolean>((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, host, () => s.close(() => done(true)));
  });

export async function gather(): Promise<DoctorReport> {
  const c = config();
  await warmEngines();
  const pages = c.pagesDir;
  const exists = existsSync(pages);
  let writable = false;
  try { accessSync(exists ? pages : c.projectRoot, constants.W_OK); writable = true; } catch {}
  let count = 0;
  try { count = readdirSync(pages, { recursive: true }).filter((f) => String(f).endsWith(".md")).length; } catch {}
  const file = logFile();
  let errors: string[] = [];
  try { if (file && statSync(file).size > 0) errors = lastErrors(readFileSync(file, "utf8")); } catch {}
  return {
    version: versionLine(),
    system: `${platform()} ${release()}`,
    runtime: `Bun ${Bun.version}`,
    pi: piPkg.version,
    configFile: c.file,
    server: { host: c.server.host, port: c.server.port, free: await portFree(c.server.host, c.server.port) },
    folder: { root: c.projectRoot, pages, exists, writable, count },
    engines: engines().map((e) => ({ name: e.name, problem: e.unavailable() })),
    log: { file, errors },
  };
}

export function format(r: DoctorReport, home = homedir()): string {
  const t = (s: string) => tilde(s, home);
  const lines = [
    r.version,
    `System:   ${r.system}, ${r.runtime}`,
    `Pi:       ${r.pi}`,
    `Settings: ${r.configFile ? t(r.configFile) : "no settings file, defaults and environment"}`,
    `Server:   ${r.server.host}:${r.server.port} ${r.server.free ? "is free" : "is in use (another Solipsist, or something else)"}`,
    `Folder:   ${t(r.folder.root)}`,
    `Pages:    ${r.folder.exists ? `${r.folder.count} page${r.folder.count === 1 ? "" : "s"} in ${t(r.folder.pages)}` : "none yet (the first launch picks them)"}${r.folder.writable ? "" : " — NOT WRITABLE"}`,
    ...r.engines.map((e) => `Agent:    ${e.name} ${e.problem ? `can't run: ${e.problem}` : "ready"}`),
    `Log:      ${r.log.file ? t(r.log.file) : "off"}`,
  ];
  if (r.log.errors.length) lines.push("Last errors:", ...r.log.errors.map((e) => `  ${t(e)}`));
  else if (r.log.file) lines.push("Last errors: none");
  return lines.join("\n");
}

export async function doctor(): Promise<string> {
  return format(await gather());
}
