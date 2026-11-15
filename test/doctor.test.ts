// `solipsist doctor` (src/server/doctor.ts): one paste for a bug report, with nothing private in it.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, format, lastErrors, tilde, type DoctorReport } from "../src/server/doctor";

const base: DoctorReport = {
  version: "solipsist 1.0.0 (linux-x64, abc1234, 2026-11-15)",
  system: "linux 6.1",
  runtime: "Bun 1.4.3",
  pi: "1.4.0",
  configFile: "/home/ann/notes/solipsist.yaml",
  server: { host: "localhost", port: 3000, free: true },
  folder: { root: "/home/ann/notes", pages: "/home/ann/notes/.solipsist/pages", exists: true, writable: true, count: 2 },
  engines: [{ name: "pi", problem: null }],
  log: { file: "/home/ann/notes/.solipsist/server.log", errors: [] },
};

test("home is shown as ~", () => {
  expect(tilde("/home/ann/notes/a.md", "/home/ann")).toBe("~/notes/a.md");
  expect(tilde("/etc/x", "")).toBe("/etc/x");
});

test("the report names the facts and hides the home folder", () => {
  const text = format(base, "/home/ann");
  expect(text).toContain("solipsist 1.0.0 (linux-x64, abc1234, 2026-11-15)");
  expect(text).toContain("Settings: ~/notes/solipsist.yaml");
  expect(text).toContain("Server:   localhost:3000 is free");
  expect(text).toContain("Pages:    2 pages in ~/notes/.solipsist/pages");
  expect(text).toContain("Agent:    pi ready");
  expect(text).toContain("Last errors: none");
  expect(text).not.toContain("/home/ann");
});

test("problems are said plainly: a busy port, an engine that can't run, a folder that can't be written", () => {
  const text = format(
    { ...base, configFile: null, server: { ...base.server, free: false }, engines: [{ name: "pi", problem: "no model key" }], folder: { ...base.folder, writable: false, exists: false }, log: { file: null, errors: [] } },
    "/home/ann",
  );
  expect(text).toContain("no settings file");
  expect(text).toContain("is in use (not by Solipsist");
  expect(format({ ...base, server: { ...base.server, free: false, solipsist: 4242 } }, "/home/ann")).toContain("already running for this folder (process 4242)");
  expect(text).toContain("Agent:    pi can't run: no model key");
  expect(text).toContain("NOT WRITABLE");
  expect(text).toContain("Log:      off");
});

test("the last errors come from the log, newest last, and a torn line is skipped", () => {
  const lines = [
    JSON.stringify({ t: "1", action: "save" }),
    JSON.stringify({ t: "2", action: "run.error", error: "boom" }),
    "{torn",
    JSON.stringify({ t: "3", action: "put", error: "late" }),
    JSON.stringify({ t: "4", action: "run.end" }),
  ].join("\n");
  expect(lastErrors(lines)).toEqual(["2 run.error boom", "3 put late"]);
  expect(lastErrors(lines, 1)).toEqual(["3 put late"]);
});

test("run for real in an empty folder: it reports, and a key never appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  mkdirSync(join(dir, ".solipsist", "pages"), { recursive: true });
  writeFileSync(join(dir, ".solipsist", "pages", "a.md"), "# private page text\n");
  const was = { root: process.env.SOLIPSIST_PROJECT_ROOT, key: process.env.SOLIPSIST_OPENROUTER_KEY };
  process.env.SOLIPSIST_PROJECT_ROOT = dir;
  process.env.SOLIPSIST_OPENROUTER_KEY = "sk-or-fake-secret-123";
  try {
    const text = await doctor();
    expect(text).toContain("solipsist ");
    expect(text).toContain("Pages:    1 page");
    expect(text).not.toContain("sk-or-fake-secret-123");
    expect(text).not.toContain("private page text");
  } finally {
    for (const [k, v] of [["SOLIPSIST_PROJECT_ROOT", was.root], ["SOLIPSIST_OPENROUTER_KEY", was.key]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}, 30_000); // loads Pi's model catalog: a cold import takes seconds under load
