import { homedir } from "node:os";
import { versionInfo } from "./version";
import { relative } from "node:path";
import { costLimit, spentUsd, unmeteredRunLimit, unmeteredRuns } from "./agent/budget";
import { maxRuns } from "./agent/page";
import { allPageAgents, runsEverywhere, type PageSnapshot } from "./agent/pageAgents";
import { config } from "./config";
import { pagesDir } from "./runtime";
import { logFile, onLog, type LogLine } from "./log";
import { viewers } from "./presence";

/**
 * The server's terminal view: the pages whose agents are running and where each task's agent stands (running,
 * with its last step; waiting for the writer; in the chat), the run and cost limits, and the latest lines of the log
 * (`log.ts`), as the debug panel shows one page in the browser. It takes the terminal over (its alternate screen)
 * while the server runs in one; `SOLIPSIST_TUI=0` keeps the plain output. `renderDashboard` is pure, for the tests.
 */

export interface DashboardState {
  /** This build, `0.1.0` or `0.1.0-dev+a1b2c3d` (`version.ts`). */
  version?: string;
  url: string;
  docs: string;
  log: string | null;
  startedAt: number;
  runs: number;
  maxRuns: number;
  spentUsd: number;
  limitUsd: number | null;
  /** Runs today that reported no cost, so the figure above doesn't include them, and their daily limit. */
  unmeteredRuns: number;
  unmeteredLimit: number | null;
  pages: PageSnapshot[];
  recent: LogLine[];
  /** Browser windows with the app open (`presence.ts`). 0: the view only says which address to open. */
  viewers?: number;
}

/**
 * The view while no browser has the app open: the address to open, big and alone, and what is still going on behind
 * it (agents keep working after the last tab closes).
 */
export function renderWaiting(s: DashboardState, width: number, height: number, now = Date.now(), color = true): string[] {
  const working = s.pages.filter((p) => p.runs.length).length;
  const errors = s.recent.filter((l) => /error/.test(l.action)).slice(-3);
  const body = [
    `${paint("1", "Solipsist", color)}${s.version ? ` ${paint("2", s.version, color)}` : ""} is running.`,
    "",
    "Open this address in your browser to start writing:",
    "",
    `    ${paint("1;36", s.url, color)}`,
    "",
    paint("2", `Pages: ${s.docs}${s.log ? ` · log ${s.log}` : ""} · up ${duration(now - s.startedAt)}`, color),
    ...(working ? [paint("2", `Agents are still working on ${working} page${working > 1 ? "s" : ""}.`, color)] : []),
    ...(errors.length ? ["", paint("31", "Recent errors:", color), ...errors.map((l) => logLine(l, color))] : []),
    "",
    paint("2", "The full view appears here once a browser connects. Ctrl-C stops the server.", color),
  ];
  const top = Math.max(0, Math.floor((height - body.length) / 3));
  const pad = "  ";
  return [...Array<string>(top).fill(""), ...body.map((l) => (l ? pad + l : l))].slice(0, height).map((l) => fit(l, width));
}

const ESC = "\x1b[";
const paint = (code: string, s: string, color: boolean) => (color ? `${ESC}${code}m${s}${ESC}0m` : s);
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
function fit(s: string, width: number): string {
  if (visible(s) <= width) return s;
  let out = "", n = 0;
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    const room = width - 1 - n;
    if (room <= 0) break;
    out += part.slice(0, room);
    n += Math.min(part.length, room);
  }
  return out.includes(ESC) ? `${out}…${ESC}0m` : `${out}…`;
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const usd = (v: number) => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const IDLE: Record<string, string> = { settling: "waiting for the page to settle", unchanged: "idle: page unchanged", "nothing pending": "idle: nothing to do", busy: "held: server run limit", chat: "held: the page's agent is in a chat", cost: "stopped: cost limit reached", runs: "stopped: daily run limit reached (cost not reported)" };

/** A log line as one short line: its time, action, page and what matters about it. */
function logLine(l: LogLine, color: boolean): string {
  const { t, action, page, task, ...rest } = l;
  const bits: string[] = [];
  if (typeof rest.outcome === "string") bits.push(rest.outcome);
  if (typeof rest.durationMs === "number") bits.push(duration(rest.durationMs));
  if (typeof rest.costUsd === "number") bits.push(usd(rest.costUsd));
  for (const k of ["reason", "model", "rev", "tabs", "message", "error"] as const) if (rest[k] !== undefined && rest[k] !== "") bits.push(k === "rev" ? `rev ${rest[k]}` : k === "tabs" ? `${rest[k]} tab(s)` : String(rest[k]));
  const tone = /error|failed|refused|bad_block/.test(action) || rest.ok === false ? "31" : /warning|budget/.test(action) ? "33" : "2";
  const where = [page, task].filter(Boolean).join(" ");
  return `${paint("2", clock(Date.parse(t)), color)} ${paint(tone === "2" ? "36" : tone, action.padEnd(16), color)} ${where}${bits.length ? `  ${paint(tone === "2" ? "2" : tone, bits.join(" · ").replace(/\s+/g, " "), color)}` : ""}`;
}

/** The view as lines, at most `height` of them, each at most `width` wide. */
export function renderDashboard(s: DashboardState, width: number, height: number, now = Date.now(), color = true): string[] {
  if (s.viewers === 0) return renderWaiting(s, width, height, now, color);
  const rule = paint("2", "─".repeat(Math.max(10, width)), color);
  const out: string[] = [];
  out.push(`${paint("1", "Solipsist", color)}${s.version ? ` ${paint("2", s.version, color)}` : ""} · ${s.url} · docs ${s.docs} · up ${duration(now - s.startedAt)}`);
  const cost = `cost ${usd(s.spentUsd)}${s.limitUsd !== null ? ` of ${usd(s.limitUsd)}` : ""}`;
  const over = s.limitUsd !== null && s.spentUsd >= s.limitUsd;
  // Runs no dollar figure covers are said separately, so an engine that reports no cost isn't read as a free one.
  const unmetered = s.unmeteredRuns
    ? ` · ${s.unmeteredRuns}${s.unmeteredLimit !== null ? `/${s.unmeteredLimit}` : ""} uncosted`
    : "";
  const overRuns = s.unmeteredLimit !== null && s.unmeteredRuns >= s.unmeteredLimit;
  out.push(`Runs ${s.runs}/${s.maxRuns} · ${over ? paint("31", `${cost}: no new runs`, color) : cost}${unmetered ? paint(overRuns ? "31" : "2", unmetered, color) : ""}${s.log ? paint("2", ` · log ${s.log}`, color) : ""}`);
  out.push(rule);
  if (!s.pages.length) out.push(paint("2", "No agents running. They start when a page with a request is opened.", color));
  for (const p of s.pages) {
    const busy = p.runs.length > 0;
    const head = `${paint(busy ? "32" : "2", busy ? "●" : "○", color)} ${paint("1", p.id, color)}  ${paint("2", p.model, color)}  ${p.tabs ? `${p.tabs} tab${p.tabs > 1 ? "s" : ""}` : paint("2", "no tab", color)}`;
    out.push(`${head}${p.idle && !busy ? `  ${paint(p.idle === "cost" || p.idle === "runs" ? "31" : "2", IDLE[p.idle] ?? p.idle, color)}` : ""}`);
    for (const r of p.runs) out.push(`    ${paint("32", "running ", color)} ${r.taskType}:${r.task}  run ${r.run}  ${duration(now - r.startedAt)}${r.step ? `  ${paint("2", r.step.replace(/\s+/g, " "), color)}` : ""}`);
    for (const k of p.kept) out.push(`    ${paint("33", "waiting ", color)} ${k.task}  finished ${short(k.finishedAt)} · snoozes ${short(k.until)}`);
    for (const c of p.chatting) out.push(`    ${paint("35", "in chat ", color)} ${c}`);
  }
  out.push(rule);
  out.push(paint("1", "Recent", color));
  const room = Math.max(0, height - out.length);
  for (const l of s.recent.slice(-room)) out.push(logLine(l, color));
  return out.slice(0, height).map((l) => fit(l, width));
}

/** A path as short as it reads well: from the working directory when it is inside it, otherwise whole (home as `~`). */
export function shownPath(path: string, cwd = process.cwd(), home = homedir()): string {
  const r = relative(cwd, path);
  if (!r) return ".";
  if (!r.startsWith("..")) return r;
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** What the view needs from the running server. */
export function dashboardState(url: string, startedAt: number, recent: LogLine[]): DashboardState {
  const log = logFile();
  return {
    version: versionInfo().version,
    url, startedAt, recent,
    docs: shownPath(pagesDir()),
    log: log && shownPath(log),
    runs: runsEverywhere(),
    maxRuns: maxRuns(),
    spentUsd: spentUsd(),
    limitUsd: costLimit(),
    unmeteredRuns: unmeteredRuns(),
    unmeteredLimit: unmeteredRunLimit(),
    pages: allPageAgents().map((p) => p.snapshot()),
    viewers: viewers(),
  };
}

export const wantsTui = () => !!process.stdout.isTTY && config().log.tui && process.env.NODE_ENV !== "test";

/**
 * Takes the terminal over and redraws the view twice a second, until the returned function gives it back. What the
 * server prints meanwhile (console.log and the like) goes into the view's recent lines instead of across it.
 */
export function startTui(url: string): () => void {
  const startedAt = Date.now();
  const recent: LogLine[] = [];
  const keep = (l: LogLine) => { recent.push(l); if (recent.length > 300) recent.splice(0, recent.length - 300); };
  const off = onLog(keep);
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const said = (action: string) => (...args: unknown[]) => keep({ t: new Date().toISOString(), action, message: args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ") });
  console.log = said("console");
  console.info = said("console");
  console.warn = said("console.warning");
  console.error = said("console.error");
  const out = process.stdout;
  out.write(`${ESC}?1049h${ESC}?25l`);
  const draw = () => {
    try {
      const lines = renderDashboard(dashboardState(url, startedAt, recent), out.columns || 100, out.rows || 30);
      out.write(`${ESC}H${lines.map((l) => `${l}${ESC}K`).join("\n")}${ESC}J`);
    } catch {}
  };
  draw();
  const timer = setInterval(draw, 500);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    off();
    Object.assign(console, original);
    out.write(`${ESC}?25h${ESC}?1049l`);
  };
}
