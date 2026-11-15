import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../scripts/build";

// The tests that start many shells get a long timeout: a full `bun test` on a busy machine took them past the default 5 s.
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
  expect(r.out).toContain("https://solipsist.sh/docs/");
  // No key and no Pi login: it says how to connect a model.
  expect(r.out).toContain("No model connected yet");
});

test("a login Pi already has, or a key in the environment, is a connected model; Pi's folder is only read", () => {
  makeRelease("linux-x64", "solipsist 0.0.0 (linux-x64)");
  const pi = join(root, "pi-agent");
  mkdirSync(pi, { recursive: true });
  const auth = `{"github-copilot":{"type":"oauth"}}`;
  writeFileSync(join(pi, "auth.json"), auth);
  const a = run({ SOLIPSIST_INSTALL_DIR: join(root, "login-a"), PI_CODING_AGENT_DIR: pi }, { s: "Linux", m: "x86_64" });
  expect(a.code).toBe(0);
  expect(a.out).not.toContain("No model connected");
  expect(readFileSync(join(pi, "auth.json"), "utf8")).toBe(auth);
  const b = run({ SOLIPSIST_INSTALL_DIR: join(root, "login-b"), SOLIPSIST_OPENROUTER_KEY: "sk-or-test" }, { s: "Linux", m: "x86_64" });
  expect(b.out).not.toContain("No model connected");
  expect(existsSync(join(root, "home", ".pi"))).toBe(false);
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

test("piped in and cut off at any line, the script runs nothing", () => {
  makeRelease("linux-x64", "solipsist 0.0.0 (linux-x64)");
  const lines = readFileSync(script, "utf8").split("\n");
  const last = lines.findLastIndex((l) => l.trim() !== "");
  const dir = join(root, "cut");
  for (let i = 1; i <= last; i++) {
    const r = Bun.spawnSync(["/bin/sh", "-s"], {
      stdin: Buffer.from(lines.slice(0, i).join("\n") + "\n"),
      env: { PATH: `${stubs}:${process.env.PATH}`, HOME: join(root, "home"), TMPDIR: root, SOLIPSIST_BASE_URL: `file://${release}`, SOLIPSIST_INSTALL_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.stdout.toString().includes("Downloading")) throw new Error(`cut after line ${i}, the script started downloading`);
  }
  expect(existsSync(dir)).toBe(false);
}, 60_000);

/** Runs the script with only `tools` on the PATH (plus a fake uname) and a fake `curl` or `wget` that records its arguments and fails. */
function recordFetch(fetcher: "curl" | "wget", env: Record<string, string>) {
  const bin = mkdtempSync(join(root, `only-${fetcher}-`));
  const log = join(bin, "args");
  writeFileSync(join(bin, fetcher), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 22\n`);
  writeFileSync(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n`);
  chmodSync(join(bin, fetcher), 0o755);
  chmodSync(join(bin, "uname"), 0o755);
  for (const tool of ["mktemp", "rm", "grep", "sh"]) {
    const where = Bun.which(tool);
    if (where) Bun.spawnSync(["ln", "-s", where, join(bin, tool)]);
  }
  const r = Bun.spawnSync(["/bin/sh", script], { env: { PATH: bin, HOME: join(root, "home"), TMPDIR: root, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, args: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("from GitHub, curl and wget fetch over HTTPS only (no redirect to http)", () => {
  const c = recordFetch("curl", {});
  expect(c.code).toBe(1);
  expect(c.args).toContain("--proto =https --tlsv1.2");
  expect(c.args).toContain("https://github.com/pulkitsharma07/solipsist/releases/latest/download/solipsist-linux-x64.tar.gz");
  const w = recordFetch("wget", { SOLIPSIST_VERSION: "v1.2.3" });
  expect(w.code).toBe(1);
  expect(w.args).toContain("--https-only");
  expect(w.args).toContain("/releases/download/v1.2.3/solipsist-linux-x64.tar.gz");
}, 60_000);

test("SOLIPSIST_BASE_URL is fetched as given (a mirror or a test may be http or file)", () => {
  const c = recordFetch("curl", { SOLIPSIST_BASE_URL: "http://mirror.test/rel" });
  expect(c.args).not.toContain("--proto");
  expect(c.args).toContain("http://mirror.test/rel/solipsist-linux-x64.tar.gz");
}, 60_000);

test("no variable is followed straight by a non-ASCII character: macOS's bash 3.2 reads its bytes as part of the name", () => {
  const bad = readFileSync(script, "utf8")
    .split("\n")
    .filter((l) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(l));
  expect(bad).toEqual([]);
});
