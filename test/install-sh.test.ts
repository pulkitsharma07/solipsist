import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../scripts/build";

const script = join(import.meta.dir, "..", "scripts", "install.sh");
let root: string;
let release: string; // a fake release folder: the archive and SHA256SUMS the script fetches
let stubs: string; // a folder first on PATH holding a fake `uname`

const run = (env: Record<string, string>, uname?: { s: string; m: string }) => {
  if (uname) writeFileSync(join(stubs, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${uname.s};; -m) echo ${uname.m};; esac\n`);
  else rmSync(join(stubs, "uname"), { force: true });
  if (uname) chmodSync(join(stubs, "uname"), 0o755);
  const home = join(root, "home");
  const r = Bun.spawnSync(["/bin/sh", script], {
    env: { PATH: `${stubs}:${process.env.PATH}`, HOME: home, TMPDIR: root, SOLIPSIST_BASE_URL: `file://${release}`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

/** A release holding one archive for `target` whose binary is a shell script printing `line`. */
function makeRelease(target: string, line: string, binaryBody?: string) {
  const stage = join(root, "stage", `solipsist-0.0.0-${target}`);
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "solipsist"), binaryBody ?? `#!/bin/sh\necho '${line}'\n`);
  chmodSync(join(stage, "solipsist"), 0o755);
  mkdirSync(release, { recursive: true });
  const asset = `solipsist-${target}.tar.gz`;
  Bun.spawnSync(["tar", "-czf", join(release, asset), `solipsist-0.0.0-${target}`], { cwd: join(root, "stage") });
  writeFileSync(join(release, "SHA256SUMS"), `${sha256(join(release, asset))}  ${asset}\n`);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "install-sh-"));
  release = join(root, "release");
  stubs = join(root, "stubs");
  mkdirSync(stubs);
  mkdirSync(join(root, "home"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("installs the file for this system, checked, into ~/.local/bin, and says how to put it on the PATH", () => {
  makeRelease("linux-x64", "solipsist 0.0.0 (linux-x64)");
  const r = run({}, { s: "Linux", m: "x86_64" });
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const bin = join(root, "home", ".local", "bin", "solipsist");
  expect(readFileSync(bin, "utf8")).toContain("solipsist 0.0.0 (linux-x64)");
  expect(r.out).toContain("Installed: solipsist 0.0.0 (linux-x64)");
  expect(r.out).toContain("is not on your PATH");
  expect(r.out).toContain("your pages are never touched");
});

test("an arm64 Mac gets darwin-arm64; an aarch64 Linux gets linux-arm64", () => {
  makeRelease("darwin-arm64", "solipsist 0.0.0 (darwin-arm64)");
  expect(run({ SOLIPSIST_INSTALL_DIR: join(root, "a") }, { s: "Darwin", m: "arm64" }).out).toContain("Downloading Solipsist for darwin-arm64");
  makeRelease("linux-arm64", "solipsist 0.0.0 (linux-arm64)");
  expect(run({ SOLIPSIST_INSTALL_DIR: join(root, "b") }, { s: "Linux", m: "aarch64" }).out).toContain("for linux-arm64");
});

test("a second run replaces the first, and a dir already on the PATH gets no hint", () => {
  makeRelease("linux-x64", "solipsist 0.0.1 (linux-x64)");
  const dir = join(root, "onpath");
  const r = run({ SOLIPSIST_INSTALL_DIR: dir, PATH: `${dir}:${stubs}:${process.env.PATH}` }, { s: "Linux", m: "x86_64" });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("is not on your PATH");
  makeRelease("linux-x64", "solipsist 0.0.2 (linux-x64)");
  run({ SOLIPSIST_INSTALL_DIR: dir }, { s: "Linux", m: "x86_64" });
  expect(readFileSync(join(dir, "solipsist"), "utf8")).toContain("0.0.2");
});

test("a checksum that doesn't match: exit 2, nothing installed", () => {
  makeRelease("linux-x64", "solipsist 0.0.0 (linux-x64)");
  writeFileSync(join(release, "SHA256SUMS"), `${"0".repeat(64)}  solipsist-linux-x64.tar.gz\n`);
  const dir = join(root, "bad");
  const r = run({ SOLIPSIST_INSTALL_DIR: dir }, { s: "Linux", m: "x86_64" });
  expect(r.code).toBe(2);
  expect(r.err).toContain("checksum mismatch");
  expect(existsSync(join(dir, "solipsist"))).toBe(false);
});

test("a binary that doesn't run: exit 3, nothing installed", () => {
  makeRelease("linux-x64", "", "#!/bin/sh\necho broken >&2\nexit 7\n");
  const dir = join(root, "broken");
  const r = run({ SOLIPSIST_INSTALL_DIR: dir }, { s: "Linux", m: "x86_64" });
  expect(r.code).toBe(3);
  expect(existsSync(join(dir, "solipsist"))).toBe(false);
});

test("an unsupported system is named, and nothing is downloaded", () => {
  const a = run({}, { s: "FreeBSD", m: "amd64" });
  expect(a.code).toBe(1);
  expect(a.err).toContain("unsupported system: FreeBSD");
  const b = run({}, { s: "Linux", m: "riscv64" });
  expect(b.code).toBe(1);
  expect(b.err).toContain("unsupported system: linux/riscv64");
});

test("a release that has no file for this system is an error, not a crash", () => {
  rmSync(release, { recursive: true, force: true });
  const r = run({ SOLIPSIST_INSTALL_DIR: join(root, "none") }, { s: "Linux", m: "x86_64" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("could not download");
});
