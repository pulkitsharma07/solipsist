// `cut` (scripts/release.ts) on scratch repos: a clone of a bare "origin", with the suite stood in for.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cut } from "../scripts/release";

const scratch = mkdtempSync(join(tmpdir(), "release-cut-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n- Something a writer would notice.\n\n## [0.1.0] — 2026-01-01\n\n- First.\n";

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}

/** A clone of its own, ignoring the developer's git config (hooks, signing). */
function clone(origin: string, name: string) {
  const dir = join(scratch, name);
  git(scratch, "clone", "-q", origin, dir);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.hooksPath", join(dir, ".git", "hooks")]]) git(dir, "config", k!, v!);
  return dir;
}

let n = 0;
/** A fresh origin holding version 0.1.0 and a changelog with an entry, and a clone of it on main. */
function repo() {
  const origin = join(scratch, `origin-${++n}.git`);
  git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  const dir = clone(origin, `work-${n}`);
  git(dir, "checkout", "-q", "-b", "main");
  writeFileSync(join(dir, "package.json"), '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "start");
  git(dir, "push", "-q", "origin", "main");
  return { origin, dir };
}

const green = () => true;

test("bumps, commits, tags, and says to push main and the tag atomically", () => {
  const { dir } = repo();
  const r = cut({ root: dir, arg: "patch", runTests: green, date: "2026-11-15" });
  expect(r).toEqual({ version: "0.1.1", tag: "v0.1.1", push: "git push --atomic origin main v0.1.1" });
  expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.1.1");
  expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toContain("## [Unreleased]\n\n## [0.1.1] — 2026-11-15\n\n- Something");
  expect(git(dir, "log", "-1", "--format=%s")).toBe("Release 0.1.1");
  expect(git(dir, "rev-parse", "v0.1.1^{commit}")).toBe(git(dir, "rev-parse", "HEAD"));
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("a dry run checks everything and writes nothing", () => {
  const { dir } = repo();
  const head = git(dir, "rev-parse", "HEAD");
  let ran = false;
  expect(cut({ root: dir, arg: "minor", dry: true, runTests: () => (ran = true) }).version).toBe("0.2.0");
  expect(ran).toBe(false);
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("refused, with nothing written, when main is behind origin's (the push would send the tag alone)", () => {
  const { origin, dir } = repo();
  const other = clone(origin, `other-${n}`);
  writeFileSync(join(other, "x.md"), "pushed by someone else\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "elsewhere");
  git(other, "push", "-q", "origin", "main");
  const head = git(dir, "rev-parse", "HEAD");
  expect(() => cut({ root: dir, arg: "patch", runTests: green })).toThrow("behind origin/main");
  expect(git(dir, "rev-parse", "HEAD")).toBe(head);
  expect(git(dir, "status", "--porcelain")).toBe("");
  expect(git(dir, "tag")).toBe("");
});

test("a main ahead of origin's is fine: the push is a fast-forward", () => {
  const { dir } = repo();
  writeFileSync(join(dir, "y.md"), "not pushed yet\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "local");
  expect(cut({ root: dir, arg: "patch", runTests: green }).tag).toBe("v0.1.1");
});

test("refused when origin can't be reached", () => {
  const { origin, dir } = repo();
  rmSync(origin, { recursive: true, force: true });
  expect(() => cut({ root: dir, arg: "patch", runTests: green })).toThrow("Could not fetch origin's main");
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("refused: a dirty tree, another branch, a tag that exists, a red suite", () => {
  const a = repo();
  writeFileSync(join(a.dir, "dirty.md"), "x\n");
  expect(() => cut({ root: a.dir, arg: "patch", runTests: green })).toThrow("working tree has changes");
  const b = repo();
  git(b.dir, "checkout", "-q", "-b", "feature");
  expect(() => cut({ root: b.dir, arg: "patch", runTests: green })).toThrow("not feature");
  const c = repo();
  git(c.dir, "tag", "v0.1.1");
  expect(() => cut({ root: c.dir, arg: "patch", runTests: green })).toThrow("already exists");
  const d = repo();
  expect(() => cut({ root: d.dir, arg: "patch", runTests: () => false })).toThrow("red");
  expect(git(d.dir, "status", "--porcelain")).toBe("");
});
