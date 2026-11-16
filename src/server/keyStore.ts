/**
 * The OpenRouter key the writer saved in the app (the "Connect an AI model" dialog), for a writer who has neither
 * `SOLIPSIST_OPENROUTER_KEY` set nor a login of Pi's own.
 *
 * Where it is kept (`pi.key_store`): `keychain`, the system's own store through `Bun.secrets` (macOS Keychain, Windows
 * Credential Manager, the Secret Service on Linux), or the file `pi.key_file`, readable by its owner only (0600), when
 * there is no keychain or `pi.key_store` is `file`. `off` keeps nothing and the dialog only says how to set a key.
 *
 * A key set in the environment or the config file (`pi.openrouter_key`) comes first; the saved one is next.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

const SERVICE = "solipsist";
const NAME = "openrouter-api-key";

export type KeyPlace = "keychain" | "file";

/** What was read: undefined until `loadSavedKey`, then the key or null. */
let cached: { key: string | null; place: KeyPlace | null } | undefined;

const store = () => config().pi.key_store as "keychain" | "file" | "off";
const keyFile = () => config().pi.key_file;

function readFile(): string | null {
  try {
    const f = keyFile();
    if (!existsSync(f)) return null;
    return readFileSync(f, "utf8").trim() || null;
  } catch { return null; }
}

function writeFile(key: string): void {
  const f = keyFile();
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, `${key}\n`, { mode: 0o600 });
  // `mode` applies only to a file being created: one there already is narrowed too.
  try { chmodSync(f, 0o600); } catch { /* Windows */ }
}

/** Reads the saved key once (the keychain is asked asynchronously); `savedKey` answers from what this read. */
export async function loadSavedKey(): Promise<string | null> {
  const s = store();
  let key: string | null = null, place: KeyPlace | null = null;
  if (s === "keychain") {
    try { key = (await Bun.secrets.get({ service: SERVICE, name: NAME })) || null; } catch { key = null; }
    if (key) place = "keychain";
  }
  // A keychain that was missing when the key was saved left it in the file.
  if (!key && s !== "off") { key = readFile(); if (key) place = "file"; }
  cached = { key, place };
  return key;
}

/** The saved key, as last read; null before `loadSavedKey` and when none is saved. */
export const savedKey = (): string | null => {
  if (store() === "off") return null;
  // The file can be read at once; the keychain only by `loadSavedKey`, which the server awaits when it starts.
  if (cached === undefined && store() === "file") { const key = readFile(); cached = { key, place: key ? "file" : null }; }
  return cached?.key ?? null;
};
/** Whether the app may keep a pasted key (`pi.key_store` isn't `off`). */
export const canSaveKey = () => store() !== "off";
/** Where the saved key is kept, or null. */
export const savedKeyPlace = (): KeyPlace | null => (savedKey() ? cached?.place ?? null : null);

/** The OpenRouter key Pi is given: the configured one, else the saved one. Undefined with neither. */
export const openRouterKey = (): string | undefined => config().pi.openrouter_key || savedKey() || undefined;
/** Which of them that is, for an error that names the key OpenRouter refused. */
export const openRouterKeySource = (): "config" | "saved" | null => (config().pi.openrouter_key ? "config" : savedKey() ? "saved" : null);

/** Keeps `key`: in the keychain when there is one (and the file is cleared), else in the file. Says where. */
export async function saveKey(key: string): Promise<{ place: KeyPlace; file?: string }> {
  const s = store();
  if (s === "off") throw new Error("Saving a key is turned off (pi.key_store: off).");
  if (s === "keychain") {
    try {
      await Bun.secrets.set({ service: SERVICE, name: NAME, value: key });
      try { rmSync(keyFile(), { force: true }); } catch { /* not there */ }
      cached = { key, place: "keychain" };
      return { place: "keychain" };
    } catch { /* no keychain here (a Linux box without a Secret Service): the file instead */ }
  }
  writeFile(key);
  cached = { key, place: "file" };
  return { place: "file", file: keyFile() };
}

/** Forgets the saved key, wherever it is. Says whether there was one. */
export async function forgetKey(): Promise<boolean> {
  if (cached === undefined) await loadSavedKey();
  const had = !!cached?.key;
  if (store() === "keychain") { try { await Bun.secrets.delete({ service: SERVICE, name: NAME }); } catch { /* no keychain */ } }
  try { rmSync(keyFile(), { force: true }); } catch { /* not there */ }
  cached = { key: null, place: null };
  return had;
}

/** What a key must look like: OpenRouter's keys start `sk-or-`. Null when it does, else why not, in the writer's words. */
export function keyProblem(key: string): string | null {
  if (!key) return "Paste your OpenRouter key.";
  if (/\s/.test(key)) return "A key has no spaces in it: paste it again.";
  if (!key.startsWith("sk-or-")) return "That isn't an OpenRouter key: they start with sk-or-.";
  return null;
}

/**
 * Asks OpenRouter whether it takes `key` (`GET /api/v1/key`). "ok", "refused" (401/403), or "unknown" when it can't be
 * reached: the key is kept anyway, since the writer may be offline. Replaced by tests (`setKeyCheck`); under `bun test`
 * the default never goes to the network.
 */
export type KeyVerdict = "ok" | "refused" | "unknown";
const askOpenRouter = async (key: string): Promise<KeyVerdict> => {
  if (process.env.NODE_ENV === "test") return "unknown";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return "refused";
    return res.ok ? "ok" : "unknown";
  } catch { return "unknown"; }
};
let check: (key: string) => Promise<KeyVerdict> = askOpenRouter;
export const checkKey = (key: string) => check(key);
/** For tests: how a key is checked (`null` puts the real check back). */
export function setKeyCheck(f: ((key: string) => Promise<KeyVerdict>) | null): void { check = f ?? askOpenRouter; }
/** For tests: forget what was read, so the next `loadSavedKey` reads again. */
export function resetKeyCache(): void { cached = undefined; }
