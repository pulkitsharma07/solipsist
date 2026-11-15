import { expect, test } from "bun:test";
import { compare, nextVersion, promote, sectionOf } from "../scripts/release";

test("bumps: patch, minor, major, an explicit version", () => {
  expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
  expect(nextVersion("0.1.4", "minor")).toBe("0.2.0");
  expect(nextVersion("0.3.2", "major")).toBe("1.0.0");
  expect(nextVersion("0.1.0", "0.2.0-beta.1")).toBe("0.2.0-beta.1");
});

test("a pre-release's patch is the release it was heading for", () => {
  expect(nextVersion("0.2.0-beta.1", "patch")).toBe("0.2.0");
  expect(nextVersion("0.2.0-beta.1", "0.2.0-beta.2")).toBe("0.2.0-beta.2");
});

test("refused: nonsense, the same version, an older one", () => {
  expect(() => nextVersion("0.1.0", "huge")).toThrow(/isn't patch/);
  expect(() => nextVersion("0.1.0", "0.1.0")).toThrow(/already/);
  expect(() => nextVersion("0.2.0", "0.1.9")).toThrow(/older/);
  expect(() => nextVersion("0.2.0", "0.2.0-beta.1")).toThrow(/older/);
});

test("precedence follows semver", () => {
  expect(compare("1.0.0", "1.0.0-rc.1")).toBe(1);
  expect(compare("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
  expect(compare("1.0.0-beta.1", "1.0.0-rc.1")).toBe(-1);
  expect(compare("1.2.3", "1.2.3")).toBe(0);
});

const LOG = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [0.1.0] — first public build\n\n- Start.\n";

test("sectionOf reads one section's body", () => {
  expect(sectionOf(LOG, "Unreleased")).toBe("### Added\n\n- A thing.");
  expect(sectionOf(LOG, "0.1.0")).toBe("- Start.");
  expect(sectionOf(LOG, "9.9.9")).toBeNull();
});

test("promote renames Unreleased and leaves a new empty one", () => {
  const out = promote(LOG, "0.2.0", "2026-12-01");
  expect(out).toContain("## [Unreleased]\n\n## [0.2.0] — 2026-12-01\n\n### Added\n\n- A thing.");
  expect(sectionOf(out, "Unreleased")).toBe("");
  expect(sectionOf(out, "0.1.0")).toBe("- Start.");
});

test("promote refuses: no entries, no Unreleased, a version already there", () => {
  expect(() => promote("# C\n\n## [Unreleased]\n\n## [0.1.0] — x\n\n- a\n", "0.2.0", "d")).toThrow(/no entries/);
  expect(() => promote("# C\n\n## [0.1.0] — x\n\n- a\n", "0.2.0", "d")).toThrow(/no `## \[Unreleased\]`/);
  expect(() => promote(LOG, "0.1.0", "d")).toThrow(/already has a section/);
});
