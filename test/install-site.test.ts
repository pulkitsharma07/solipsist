// The website's install stand-ins (site/public/install, install.ps1): each fetches the latest release's own installer
// and runs it. Run here with a fake `curl` first on PATH that serves a local script, so no network.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = join(import.meta.dir, "..", "site", "public");
const latest = "https://github.com/pulkitsharma07/solipsist/releases/latest/download";
let root: string;
let stubs: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "install-site-"));
  stubs = join(root, "stubs");
  mkdirSync(stubs);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A fake curl that writes down the URL it was asked for and "downloads" `served` (or fails when it is null). */
function fakeCurl(served: string | null) {
  const body = join(root, "served.sh");
  if (served !== null) writeFileSync(body, served);
  const fetch = served === null ? "exit 22" : `cp '${body}' "$out"`;
  writeFileSync(
    join(stubs, "curl"),
    `#!/bin/sh\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; https://*) url=$1;; esac; shift; done\n` +
      `printf '%s\\n' "$url" > '${join(root, "asked")}'\n${fetch}\n`,
  );
  chmodSync(join(stubs, "curl"), 0o755);
}

const run = (stdin = "") => {
  const r = Bun.spawnSync(["/bin/sh", "-c", `sh '${join(site, "install")}'`], {
    env: { PATH: `${stubs}:${process.env.PATH}`, TMPDIR: root, SOLIPSIST_VERSION: "9.9.9" },
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

test("runs the latest release's install.sh, with the writer's variables, and passes on its exit code", () => {
  fakeCurl(`echo "release installer, version=$SOLIPSIST_VERSION"\nexit 3\n`);
  const r = run();
  expect(readFileSync(join(root, "asked"), "utf8").trim()).toBe(`${latest}/install.sh`);
  expect(r.out).toContain("release installer, version=9.9.9");
  expect(r.code).toBe(3);
});

test("leaves no temporary file behind", () => {
  fakeCurl("exit 0\n");
  expect(run().code).toBe(0);
  const left = new Bun.Glob("solipsist-install.*").scanSync(root);
  expect([...left]).toEqual([]);
});

test("says what it couldn't download, and fails", () => {
  fakeCurl(null);
  const r = run();
  expect(r.code).toBe(1);
  expect(r.err).toContain(`could not download ${latest}/install.sh`);
});

test("works piped into sh, as the install command runs it", () => {
  fakeCurl(`echo piped ok\n`);
  const r = Bun.spawnSync(["/bin/sh", "-c", `sh < '${join(site, "install")}'`], {
    env: { PATH: `${stubs}:${process.env.PATH}`, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.stdout.toString()).toContain("piped ok");
  expect(r.exitCode).toBe(0);
});

test("install.ps1 runs the latest release's install.ps1", () => {
  const ps1 = readFileSync(join(site, "install.ps1"), "utf8");
  expect(ps1).toContain(`"${latest}/install.ps1"`);
  expect(ps1).toContain("Invoke-RestMethod $url | Invoke-Expression");
  expect(ps1.trimStart().split("\n").filter((l) => !l.startsWith("#"))[0]).toBe("& {");
});
