import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveName, pickTargets, sha256, sumsText, TARGETS } from "../scripts/build";

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
