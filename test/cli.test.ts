// The command line (src/server/cli.ts): everything else is a setting, so an unknown flag is refused, not served on.
import { expect, test } from "bun:test";
import { parseArgs, USAGE, VERSION } from "../src/server/cli";
import pkg from "../package.json";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, lineOf, sourceCommit, targetOf, versionInfo, versionLine } from "../src/server/version";

test("flags", () => {
  expect(parseArgs([])).toEqual({ run: "serve" });
  expect(parseArgs(["--help"])).toEqual({ run: "help" });
  expect(parseArgs(["-h"])).toEqual({ run: "help" });
  expect(parseArgs(["--version"])).toEqual({ run: "version" });
  expect(parseArgs(["--print-config"])).toEqual({ run: "print-config" });
  expect(parseArgs(["--config", "a.yaml", "--print-config"])).toEqual({ run: "print-config" });
  expect(parseArgs(["--config=a.yaml"])).toEqual({ run: "serve" });
  expect(parseArgs(["--config"])).toMatchObject({ run: "error", message: expect.stringContaining("--config needs a file") });
  expect(parseArgs(["--port", "4000"])).toEqual({ run: "error", message: "Unknown option --port" });
  expect(parseArgs(["notes"])).toEqual({ run: "error", message: "Unknown option notes" });
  expect(parseArgs(["doctor"])).toEqual({ run: "doctor" });
  expect(parseArgs(["doctor", "--config", "a.yaml"])).toEqual({ run: "doctor" });
  expect(parseArgs(["--print-config", "doctor"])).toEqual({ run: "error", message: "Unknown option doctor" });
});

test("the version is package.json's, and the usage names every flag", () => {
  expect(VERSION).toBe(pkg.version);
  for (const f of ["--config", "--print-config", "--version", "--help"]) expect(USAGE).toContain(f);
});

test("--version says which build: the number, and from source the commit", () => {
  const release = describe({ number: "1.4.2", target: "darwin-arm64", release: { commit: "a1b2c3d", built: "2026-11-10" } });
  expect(lineOf(release)).toBe("solipsist 1.4.2 (darwin-arm64, a1b2c3d, 2026-11-10)");
  expect(release.dev).toBe(false);
  expect(lineOf(describe({ number: "0.1.0", target: "darwin-x64", source: { commit: "a1b2c3d", dirty: false } }))).toBe("solipsist 0.1.0-dev+a1b2c3d (darwin-x64)");
  expect(lineOf(describe({ number: "0.1.0", target: "darwin-x64", source: { commit: "a1b2c3d", dirty: true } }))).toBe("solipsist 0.1.0-dev+a1b2c3d.dirty (darwin-x64)");
  expect(lineOf(describe({ number: "0.1.0", target: "linux-x64", source: null }))).toBe("solipsist 0.1.0-dev (linux-x64)");
  expect(targetOf("win32", "x64")).toBe("windows-x64");
  expect(sourceCommit(mkdtempSync(join(tmpdir(), "solip-nogit-")))).toBeNull();
  // This checkout: a run from source.
  expect(versionInfo()).toMatchObject({ dev: true, version: expect.stringMatching(new RegExp(`^${VERSION.replaceAll(".", "\\.")}-dev\\+[0-9a-f]{7,}(\\.dirty)?$`)) });
});

test("--help and --version answer without starting a server", () => {
  for (const [flag, out] of [["--help", "Usage: solipsist"], ["--version", versionLine()]] as const) {
    const r = Bun.spawnSync(["bun", "src/index.ts", flag], { env: { ...process.env, PORT: "1" } });
    expect([flag, r.exitCode, r.stdout.toString()]).toEqual([flag, 0, expect.stringContaining(out)]);
  }
  const bad = Bun.spawnSync(["bun", "src/index.ts", "--nope"], { env: { ...process.env, PORT: "1" } });
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("Unknown option --nope");
}, 30_000); // each start loads the whole server
