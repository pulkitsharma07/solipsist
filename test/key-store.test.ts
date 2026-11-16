// The OpenRouter key pasted on a page (`src/server/keyStore.ts`) and its route (`POST/DELETE /api/agent/key`): kept in
// the keychain or a file only its owner reads, behind a key set in the environment, and what makes Pi ready. The
// sandbox puts the store in a scratch file; the keychain is only ever a stand-in here, never the developer's own.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKey, forgetKey, keyProblem, loadSavedKey, openRouterKey, openRouterKeySource, resetKeyCache, savedKey, savedKeyPlace, saveKey, setKeyCheck } from "../src/server/keyStore";
import { forgetOpenRouterKey, saveOpenRouterKey } from "../src/server/agent";
import { runError } from "../src/server/agent/engines/pi";

const dir = mkdtempSync(join(tmpdir(), "solip-key-"));
const file = join(dir, "sub", "openrouter.key");
const saved = { store: process.env.SOLIPSIST_KEY_STORE, file: process.env.SOLIPSIST_KEY_FILE, key: process.env.SOLIPSIST_OPENROUTER_KEY };

beforeEach(() => {
  process.env.SOLIPSIST_KEY_STORE = "file";
  process.env.SOLIPSIST_KEY_FILE = file;
  process.env.SOLIPSIST_OPENROUTER_KEY = "";
  rmSync(join(dir, "sub"), { recursive: true, force: true });
  resetKeyCache();
  setKeyCheck(async () => "ok");
});
afterEach(() => setKeyCheck(null));
afterAll(() => {
  for (const [k, v] of [["SOLIPSIST_KEY_STORE", saved.store], ["SOLIPSIST_KEY_FILE", saved.file], ["SOLIPSIST_OPENROUTER_KEY", saved.key]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  resetKeyCache();
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "sk-or-v1-fake-key-for-tests";
const local = { requestIP: () => ({ address: "127.0.0.1" }) };
const remote = { requestIP: () => ({ address: "10.0.0.7" }) };
const post = (body: unknown) => new Request("http://localhost/api/agent/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a key must look like OpenRouter's", () => {
  expect(keyProblem("")).toBe("Paste your OpenRouter key.");
  expect(keyProblem("sk-or-v1 abc")).toContain("no spaces");
  expect(keyProblem("sk-proj-abc")).toContain("start with sk-or-");
  expect(keyProblem(KEY)).toBeNull();
});

test("the file store: written for its owner only, read back, forgotten", async () => {
  expect(savedKey()).toBeNull();
  expect(await saveKey(KEY)).toEqual({ place: "file", file });
  expect(readFileSync(file, "utf8").trim()).toBe(KEY);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  resetKeyCache();
  expect(savedKey()).toBe(KEY); // read from the file, without the async load
  expect(savedKeyPlace()).toBe("file");
  expect(await forgetKey()).toBe(true);
  expect(existsSync(file)).toBe(false);
  expect(savedKey()).toBeNull();
  expect(await forgetKey()).toBe(false);
});

test("a key in the environment comes before the saved one", async () => {
  await saveKey(KEY);
  expect(openRouterKey()).toBe(KEY);
  expect(openRouterKeySource()).toBe("saved");
  process.env.SOLIPSIST_OPENROUTER_KEY = "sk-or-from-env";
  expect(openRouterKey()).toBe("sk-or-from-env");
  expect(openRouterKeySource()).toBe("config");
});

test("off keeps nothing and reads nothing", async () => {
  writeFileSync(join(dir, "stray.key"), KEY);
  process.env.SOLIPSIST_KEY_FILE = join(dir, "stray.key");
  process.env.SOLIPSIST_KEY_STORE = "off";
  expect(savedKey()).toBeNull();
  expect(await loadSavedKey()).toBeNull();
  expect(saveKey(KEY)).rejects.toThrow("turned off");
});

test("the keychain: used when there is one, and the file when there isn't", async () => {
  process.env.SOLIPSIST_KEY_STORE = "keychain";
  const vault = new Map<string, string>();
  const name = (o: { service: string; name: string }) => `${o.service}/${o.name}`;
  const get = spyOn(Bun.secrets, "get").mockImplementation(async (o: any) => vault.get(name(o)) ?? null);
  const set = spyOn(Bun.secrets, "set").mockImplementation(async (o: any) => { vault.set(name(o), o.value); });
  const del = spyOn(Bun.secrets, "delete").mockImplementation(async (o: any) => vault.delete(name(o)));
  try {
    expect(await saveKey(KEY)).toEqual({ place: "keychain" });
    expect(existsSync(file)).toBe(false);
    resetKeyCache();
    expect(await loadSavedKey()).toBe(KEY);
    expect(savedKeyPlace()).toBe("keychain");
    await forgetKey();
    expect(vault.size).toBe(0);

    // No keychain on this machine (a Linux box without a Secret Service): the file, and read back from it.
    set.mockImplementation(async () => { throw new Error("no secret service"); });
    get.mockImplementation(async () => { throw new Error("no secret service"); });
    expect(await saveKey(KEY)).toEqual({ place: "file", file });
    resetKeyCache();
    expect(await loadSavedKey()).toBe(KEY);
    expect(savedKeyPlace()).toBe("file");
  } finally {
    get.mockRestore(); set.mockRestore(); del.mockRestore();
  }
});

test("under bun test the real check never goes to the network", async () => {
  setKeyCheck(null);
  const fetched = spyOn(globalThis, "fetch");
  try {
    expect(await checkKey(KEY)).toBe("unknown");
    expect(fetched).not.toHaveBeenCalled();
  } finally { fetched.mockRestore(); }
});

test("the route: local only, checks the key, keeps it, and Pi is ready", async () => {
  expect((await saveOpenRouterKey(post({ key: KEY }), remote)).status).toBe(403);
  const bad = await saveOpenRouterKey(post({ key: "sk-proj-abc" }), local);
  expect(bad.status).toBe(400);
  expect((await bad.json()).error.code).toBe("bad_key");

  setKeyCheck(async () => "refused");
  const refused = await saveOpenRouterKey(post({ key: KEY }), local);
  expect((await refused.json()).error.code).toBe("refused");
  expect(savedKey()).toBeNull();

  setKeyCheck(async () => "ok");
  const ok = await saveOpenRouterKey(post({ key: `  ${KEY}\n` }), local);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ place: "file", file, checked: true, noEngine: false });
  expect(savedKey()).toBe(KEY);
  // A 401 later names the saved key and how to replace it.
  expect(runError("401 Unauthorized")).toStartWith("OpenRouter refused the key saved in Solipsist: run `solipsist forget-key`");

  const gone = await forgetOpenRouterKey(new Request("http://localhost/api/agent/key", { method: "DELETE" }), local);
  expect(await gone.json()).toEqual({ forgotten: true, noEngine: true });
});

test("OpenRouter out of reach: the key is kept anyway, marked unchecked", async () => {
  setKeyCheck(async () => "unknown");
  const r = await saveOpenRouterKey(post({ key: KEY }), local);
  expect((await r.json()).checked).toBe(false);
  expect(savedKey()).toBe(KEY);
});
