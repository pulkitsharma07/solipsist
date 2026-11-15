import { expect, test } from "bun:test";
import { isPrerelease, releaseNotes, splitUpgrade } from "../scripts/release-notes";

const SECTION = "### Added\n\n- A thing.\n- UPGRADE: run `solipsist --print-config` and rename `old.key`.\n\n### Fixed\n\n- A bug.";

test("UPGRADE lines come out of the body and into a list", () => {
  const { body, upgrade } = splitUpgrade(SECTION);
  expect(upgrade).toEqual(["run `solipsist --print-config` and rename `old.key`."]);
  expect(body).not.toContain("UPGRADE");
  expect(body).toContain("- A thing.");
  expect(body).toContain("- A bug.");
});

test("a stable release: callout, notes, install commands, diff, checksums", () => {
  const md = releaseNotes({ version: "0.2.0", section: SECTION, repo: "o/r", prev: "v0.1.0", sums: "abc  solipsist-linux-x64.tar.gz\n" });
  expect(md.startsWith("> [!IMPORTANT]\n> **When you update:**\n> - run `solipsist --print-config`")).toBe(true);
  expect(md).toContain("curl -fsSL https://get.solipsist.sh | sh");
  expect(md).toContain("irm https://get.solipsist.sh/install.ps1 | iex");
  expect(md).toContain("https://github.com/o/r/compare/v0.1.0...v0.2.0");
  expect(md).toContain("abc  solipsist-linux-x64.tar.gz");
});

test("a pre-release says so and gives no install command", () => {
  expect(isPrerelease("0.2.0-beta.1")).toBe(true);
  const md = releaseNotes({ version: "0.2.0-beta.1", section: "- A thing.", repo: "o/r" });
  expect(md).toContain("This is a pre-release");
  expect(md).not.toContain("curl");
  expect(md).not.toContain("Full diff");
});

test("no UPGRADE lines, no callout; an empty section still says something", () => {
  expect(releaseNotes({ version: "1.0.0", section: "- A.", repo: "o/r" })).not.toContain("IMPORTANT");
  expect(releaseNotes({ version: "1.0.0", section: "", repo: "o/r" })).toContain("No notes.");
});
