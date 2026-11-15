/**
 * Every setting of the server, read and checked here and nowhere else.
 *
 * Precedence: the default < `solipsist.yaml` < the environment. The TABLE is the one definition of a setting: its
 * place in the file, its env name, its type, its default and its documentation. `loadConfig` reads from it, and
 * `configDocs.ts` writes `CONFIGURATION.md` and `solipsist.example.yaml` from it, so none of them can drift.
 * A new setting is a row here, then `bun scripts/config-docs.ts`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { ConfigError, type Kind, type Setting } from "./config/types";
import { ENV_ONLY, GROUPS, TABLE } from "./config/table";

export { ConfigError, type Kind, type Setting } from "./config/types";
export { DEFAULT_PI_MODELS, DEFAULT_PI_TOOLS, ENV_ONLY, GROUPS, TABLE } from "./config/table";


// ---------------------------------------------------------------------------------------------------------------


export interface Config {
  /** The file loaded, or null when there is none. */
  file: string | null;
  /** Glob patterns, from the working directory: the files the file dialog offers. */
  md_search_paths: string[];
  /** The project being worked on: where the server was started, or `SOLIPSIST_PROJECT_ROOT` for the tests. */
  projectRoot: string;
  /** Where the pages (the working copies, in a project) live. */
  pagesDir: string;
  server: { port: number; host: string; allowed_hosts: string[] };
  agent: {
    gap_ms: number; settle_ms: number; single_agent: boolean; concurrency: number; max_runs: number; run_timeout_ms: number;
    cost_limit_usd?: number; cost_limit_day_usd: number; cost_limit_month_usd: number; max_unmetered_runs_day: number;
    wait_ms: number; max_waiting: number; max_failures: number; preferred_models: string[];
  };
  review: {
    on: boolean; curator: string; min_score: number; min_kept: number; kept_per_block: number;
    max_per_review: number; max_gloss_words: number;
  };
  suggestions: { max_chars: number; max_edits: number };
  chat: { max_message_chars: number };
  pi: { models: string[]; tools: string[]; openrouter_key?: string };
  prompts: { dir: string };
  comments: { orphan_keep_ms: number };
  support: { after_days: number; dir: string };
  log: { file: string; max_bytes: number; tui: boolean };
  dev: { mock_comments: boolean; mock_interval_ms: number };
  /** Where each setting's value came from: `default`, `file` or `env:NAME`. */
  sources: Record<string, string>;
}

export interface LoadOptions {
  /** The config file; otherwise `SOLIPSIST_CONFIG` in `env`, then `solipsist.yaml` in `cwd`, then the user's. */
  file?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
  /** The text of the file, when the caller already read it (the cached path of `config()`). */
  text?: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shown = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(JSON.stringify(v)));

/** The wording of what a kind accepts, for errors and the reference. */
export function describeKind(s: Setting): string {
  switch (s.kind) {
    case "int": return s.min !== undefined && s.max !== undefined ? `a whole number from ${s.min} to ${s.max}` : s.min !== undefined ? `a whole number ≥ ${s.min}` : "a whole number";
    case "number": return s.min === 0 ? "a number ≥ 0" : "a number > 0";
    case "bool": return "true or false";
    case "string": return s.choices ? `one of ${s.choices.map((c) => `\`${c}\``).join(", ")}` : "text";
    case "strings": return s.min ? "a list of text (at least one)" : "a list of text";
    case "path": return "a folder path";
    case "logfile": return 'a file path, or "off"';
  }
}

const expandHome = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const SECTIONS = new Set(TABLE.flatMap((s) => (s.key.includes(".") ? [s.key.split(".")[0]!] : [])));
const LEAVES = new Map(TABLE.map((s) => [s.key, s]));

/** Where a config file may be: the explicit one, then `./solipsist.yaml`, then `~/.config/solipsist/config.yaml`. */
export function findConfigFile(opts: { file?: string; env: Record<string, string | undefined>; cwd: string; home: string }): string | null {
  const explicit = opts.file ?? opts.env.SOLIPSIST_CONFIG;
  if (explicit) {
    const p = resolve(opts.cwd, expandHome(explicit, opts.home));
    if (!existsSync(p)) throw new ConfigError(`config file ${explicit} does not exist`);
    return p;
  }
  for (const p of [join(opts.cwd, "solipsist.yaml"), join(opts.home, ".config", "solipsist", "config.yaml")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** The file's text parsed and its keys checked; the values are checked when read. */
function parseFile(text: string, label: string): Record<string, unknown> {
  let data: unknown;
  try { data = YAML.parse(text); } catch (e: any) { throw new ConfigError(`${label}: not valid YAML (${String(e.message).split("\n")[0]})`); }
  if (data === null || data === undefined) return {};
  if (!isPlain(data)) throw new ConfigError(`${label}: must be a mapping of settings (got ${Array.isArray(data) ? "a list" : shown(data)})`);
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (LEAVES.has(path)) continue;
      if (!prefix && SECTIONS.has(k)) {
        if (v === null) continue;
        if (!isPlain(v)) throw new ConfigError(`${label}: ${path} must be a section of settings (got ${shown(v)})`);
        walk(v, path);
        continue;
      }
      const near = [...LEAVES.keys()].map((key) => [key, levenshtein(path, key)] as const).sort((a, b) => a[1] - b[1])[0];
      const hint = near && near[1] <= Math.max(2, Math.floor(path.length / 4)) ? ` (did you mean ${near[0]}?)` : "";
      throw new ConfigError(`${label}: unknown key ${path}${hint}`);
    }
  };
  walk(data, "");
  return data;
}

const fileValue = (data: Record<string, unknown>, key: string): unknown => {
  let cur: unknown = data;
  for (const part of key.split(".")) { if (!isPlain(cur)) return undefined; cur = cur[part]; }
  return cur ?? undefined;
};

/** One value of a kind, from the environment (a string) or from the file (typed). Throws the reason, without the place. */
function coerce(s: Setting, raw: unknown, fromEnv: boolean): unknown {
  const bad = () => new Error(`must be ${describeKind(s)}`);
  switch (s.kind) {
    case "int": {
      const n = typeof raw === "number" ? raw : fromEnv && typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || (s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) throw bad();
      return n;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : fromEnv && typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < (s.min ?? 0) || (s.min === undefined && n <= 0)) throw bad();
      return n;
    }
    case "bool": {
      if (typeof raw === "boolean") return raw;
      if (fromEnv && typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(v)) return true;
        if (["0", "false", "no", "off"].includes(v)) return false;
      }
      throw bad();
    }
    case "string": case "path": {
      if (typeof raw !== "string" || raw.trim() === "") throw bad();
      if (s.choices && !s.choices.includes(raw.trim())) throw bad();
      return raw.trim();
    }
    case "logfile": {
      if (raw === false) return "off";
      if (typeof raw !== "string" || raw.trim() === "") throw bad();
      return raw.trim() === "0" ? "off" : raw.trim();
    }
    case "strings": {
      const list = fromEnv && typeof raw === "string" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw;
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || x.trim() === "") || list.length < (s.min ?? 0)) throw bad();
      return list.map((x: string) => x.trim());
    }
  }
}

/** Pure: the settings from a file's text, an environment and a working directory. Throws a `ConfigError` naming the key. */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  // The project Solipsist is working on: where it was started, or, for the tests, the one they name. One mode —
  // the pages are always this project's working copies (`projectRoot`, `pagesDir`).
  const cwd = opts.cwd ?? env.SOLIPSIST_PROJECT_ROOT?.trim() ?? process.cwd();
  const home = opts.home ?? homedir();
  const file = findConfigFile({ file: opts.file, env, cwd, home });
  const label = file ? (relative(cwd, file).startsWith("..") ? file : relative(cwd, file)) : "";
  const text = opts.text ?? (file ? readFileSync(file, "utf8") : "");
  const data = file ? parseFile(text, label) : {};
  const baseDir = file ? resolve(file, "..") : cwd;

  const sources: Record<string, string> = {};
  const out: any = {};
  const put = (key: string, v: unknown) => {
    const parts = key.split(".");
    let cur = out;
    for (const p of parts.slice(0, -1)) cur = cur[p] ??= {};
    if (v !== undefined) cur[parts.at(-1)!] = v;
  };

  for (const s of TABLE) {
    const envRaw = env[s.env];
    const fromEnv = envRaw !== undefined && envRaw.trim() !== "";
    const fromFile = fileValue(data, s.key);
    const raw = fromEnv ? envRaw : fromFile;
    sources[s.key] = fromEnv ? `env:${s.env}` : fromFile !== undefined ? "file" : "default";
    let v: unknown;
    if (raw === undefined) v = s.default;
    else {
      try { v = coerce(s, raw, fromEnv); } catch (e: any) {
        const got = s.secret ? "" : ` (got ${shown(raw)})`;
        throw new ConfigError(fromEnv ? `${s.env} ${e.message}${got}` : `${label}: ${s.key} ${e.message}${got}`);
      }
    }
    if (s.kind === "path" && typeof v === "string") v = resolve(fromFile !== undefined && !fromEnv ? baseDir : cwd, expandHome(v, home));
    put(s.key, v);
  }

  // Where the pages live: always the working copies in the project's own `.solipsist/`. There is one mode — the
  // writer picks the project's `.md` files, Solipsist works on copies, and Sync writes the text back (`project.ts`).
  out.projectRoot = cwd;
  out.pagesDir = join(cwd, ".solipsist", "pages");
  (out.md_search_paths as string[]).forEach((p, i) => {
    if (p.startsWith("/") || p.startsWith("~") || p.split("/").includes("..")) throw new ConfigError(`${label}: md_search_paths[${i}] must stay inside the project (got ${shown(p)})`);
  });

  if (out.log.file === undefined) out.log.file = join(cwd, ".solipsist", "server.log");
  else if (out.log.file !== "off") out.log.file = resolve(sources["log.file"] === "file" ? baseDir : cwd, expandHome(out.log.file, home));

  out.file = file;
  out.sources = sources;
  return out as Config;
}

// ---------------------------------------------------------------------------------------------------------------

const argvFile = (argv: string[]) => {
  const i = argv.indexOf("--config");
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith("--config="))?.slice("--config=".length);
};

let cached: { key: string; config: Config } | null = null;
const fileText = new Map<string, string>();

/**
 * The settings now: the file (read once) and the current environment. Cached until the environment (or the working
 * directory) changes, so a test that sets `process.env.X` before a call sees it.
 */
export function config(): Config {
  // The project: where the server was started, or the one the tests name (`SOLIPSIST_PROJECT_ROOT`).
  const cwd = process.env.SOLIPSIST_PROJECT_ROOT?.trim() || process.cwd();
  const file = argvFile(process.argv);
  const key = JSON.stringify([cwd, file, process.env.SOLIPSIST_CONFIG, process.env.SOLIPSIST_PROJECT_ROOT, TABLE.map((s) => process.env[s.env])]);
  if (cached?.key === key) return cached.config;
  const path = findConfigFile({ file, env: process.env, cwd, home: homedir() });
  let text = path ? fileText.get(path) : undefined;
  if (path && text === undefined) { text = readFileSync(path, "utf8"); fileText.set(path, text); }
  const c = loadConfig({ file: path ?? undefined, text, env: process.env, cwd });
  cached = { key, config: c };
  return c;
}

/** A setting's effective value as lines (a list has one per item); null when unset. A secret shows as `set`. */
function valueLines(c: Config, s: Setting): string[] | null {
  const v = s.key.split(".").reduce((o: any, p) => o?.[p], c);
  if (v === undefined) return null;
  if (s.secret) return ["set"];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/** `--print-config`: every setting's effective value and where it came from. Secrets show as set or unset. */
export function printConfig(c: Config): string {
  const lines = [`# config file: ${c.file ?? "none (defaults)"}`];
  for (const s of TABLE) lines.push(`${s.key}: ${valueLines(c, s)?.join(", ") ?? "unset"}  [${c.sources[s.key]}]`);
  return lines.join("\n");
}

export interface SettingView {
  key: string;
  /** The section of the file it sits in (`pages` for the top-level keys). */
  group: string;
  env: string;
  summary: string;
  /** The effective value, a line per list item; null when unset. A secret is only ever `set`. */
  value: string[] | null;
  /** `default`, `file` or `env:NAME`. */
  source: string;
  secret: boolean;
}

/** What the debug panel shows: the loaded settings, with where each came from. Never a secret's value. */
export function configView(c: Config): { file: string | null; settings: SettingView[] } {
  return {
    file: c.file,
    settings: TABLE.map((s) => ({
      key: s.key, group: s.key.includes(".") ? s.key.split(".")[0]! : "pages", env: s.env, summary: s.summary,
      value: valueLines(c, s), source: c.sources[s.key] ?? "default", secret: !!s.secret,
    })),
  };
}
