// The pre-commit hook (`.githooks/pre-commit`), run with stand-ins for gitleaks and bun.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hook = join(import.meta.dir, "..", ".githooks", "pre-commit");
const stubs = mkdtempSync(join(tmpdir(), "pre-commit-"));
afterAll(() => rmSync(stubs, { recursive: true, force: true }));

// macOS checks a script it hasn't seen before on its first run, which can take seconds.
const SLOW_FIRST_RUN = 30_000;

const stub = (name: string, body: string) => {
  writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(stubs, name), 0o755);
};

test("the tests run without git's pointers to this repo, which git sets for a hook in a worktree", () => {
  stub("gitleaks", "exit 0");
  stub("bun", `env | grep '^GIT_' > '${join(stubs, "env")}' || true`);
  const r = Bun.spawnSync(["/bin/sh", hook], {
    env: { PATH: `${stubs}:/usr/bin:/bin`, GIT_DIR: "/repo/.git/worktrees/x", GIT_INDEX_FILE: "/repo/.git/worktrees/x/index", GIT_WORK_TREE: "/repo", GIT_AUTHOR_NAME: "kept" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  expect(readFileSync(join(stubs, "env"), "utf8").trim()).toBe("GIT_AUTHOR_NAME=kept");
}, SLOW_FIRST_RUN);

test("without gitleaks the commit stops, and the tests don't run", () => {
  rmSync(join(stubs, "gitleaks"), { force: true });
  stub("bun", "exit 0");
  const r = Bun.spawnSync(["/bin/sh", hook], { env: { PATH: `${stubs}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("gitleaks isn't installed");
}, SLOW_FIRST_RUN);
