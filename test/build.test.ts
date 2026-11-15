import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { archive, archiveName, buildTime, pickTargets, sha256, sumsText, TARGETS } from "../scripts/build";

test("every target is named as --version prints it", () => {
  expect([...TARGETS]).toEqual(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"]);
});

test("--target: none is all, host is this machine, a list is each, an unknown one is refused", () => {
  expect(pickTargets(undefined)).toEqual([...TARGETS]);
  expect(pickTargets("host", "darwin-arm64")).toEqual(["darwin-arm64"]);
  expect(pickTargets("linux-x64,windows-x64")).toEqual(["linux-x64", "windows-x64"]);
  expect(() => pickTargets("freebsd-x64")).toThrow(/Unknown target "freebsd-x64"/);
  expect(() => pickTargets("host", "linux-riscv64")).toThrow(/Unknown target/);
});

test("archives: tar.gz, and zip for windows, no version in the name (a stable releases/latest/download URL)", () => {
  expect(archiveName("darwin-arm64")).toBe("solipsist-darwin-arm64.tar.gz");
  expect(archiveName("windows-x64")).toBe("solipsist-windows-x64.zip");
});

test("SHA256SUMS is what `shasum -a 256 -c` reads: hash, two spaces, the file's name", () => {
  const dir = mkdtempSync(join(tmpdir(), "sums-"));
  const f = join(dir, "a.tar.gz");
  writeFileSync(f, "abc");
  expect(sha256(f)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sumsText([f])).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.tar.gz\n");
});

describe("archives are reproducible", () => {
  const T = 1_700_000_000;
  /** A stage like the build's: a folder holding the binary and the docs, written with whatever times and modes. */
  function stage(root: string) {
    const dir = join(root, "solipsist-1.0.0-linux-x64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "solipsist"), "#!/bin/sh\necho hi\n");
    for (const f of ["README.md", "NOTICE", "LICENSE"]) writeFileSync(join(dir, f), `${f}\n`);
    chmodSync(join(dir, "README.md"), 0o600);
    return { parent: root, dir: basename(dir) };
  }

  for (const ext of ["tar.gz", "zip"]) {
    test(`the same files make the same ${ext}, whenever and however they were written`, async () => {
      const a = stage(mkdtempSync(join(tmpdir(), "arch-a-")));
      await Bun.sleep(1100); // the second stage's files are a second younger
      const b = stage(mkdtempSync(join(tmpdir(), "arch-b-")));
      chmodSync(join(b.parent, b.dir, "NOTICE"), 0o666);
      archive({ ...a, out: join(a.parent, `out.${ext}`), mtime: T });
      archive({ ...b, out: join(b.parent, `out.${ext}`), mtime: T });
      expect(sha256(join(a.parent, `out.${ext}`))).toBe(sha256(join(b.parent, `out.${ext}`)));
      archive({ ...b, out: join(b.parent, `later.${ext}`), mtime: T + 60 });
      expect(sha256(join(b.parent, `later.${ext}`))).not.toBe(sha256(join(b.parent, `out.${ext}`)));
    }, 10_000);
  }

  test("a tar.gz holds the folder, sorted, owned by 0, the binary executable and the rest not, nothing else", () => {
    const s = stage(mkdtempSync(join(tmpdir(), "arch-c-")));
    const out = join(s.parent, "x.tar.gz");
    archive({ ...s, out, mtime: T });
    const listing = Bun.spawnSync(["tar", "-tvzf", out], { stdout: "pipe" }).stdout.toString().trim().split("\n");
    const names = listing.map((l) => l.split(/\s+/).at(-1));
    expect(names).toEqual([`${s.dir}/`, `${s.dir}/LICENSE`, `${s.dir}/NOTICE`, `${s.dir}/README.md`, `${s.dir}/solipsist`]);
    expect(listing.map((l) => l.slice(0, 10))).toEqual(["drwxr-xr-x", "-rw-r--r--", "-rw-r--r--", "-rw-r--r--", "-rwxr-xr-x"]);
    for (const l of listing) expect(l).toMatch(/^\S+\s+\d+\s+0\s+0\s/);
    const gz = readFileSync(out);
    expect(gz.readUInt32LE(4)).toBe(0); // the gzip header's time
  });

  test("the build's time: SOURCE_DATE_EPOCH, else the commit's, else now", () => {
    expect(buildTime({ SOURCE_DATE_EPOCH: "1600000000" }, "1700000000")).toBe(1600000000);
    expect(buildTime({}, "1700000000")).toBe(1700000000);
    const now = Math.floor(Date.now() / 1000);
    expect(buildTime({}, "")).toBeGreaterThanOrEqual(now);
  });
});
