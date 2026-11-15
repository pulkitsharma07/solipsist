/**
 * The body of a GitHub Release, from `CHANGELOG.md`:
 *
 *   bun scripts/release-notes.ts <version> [--prev vX.Y.Z] [--sums dist/release/SHA256SUMS] [--repo owner/name] > notes.md
 *
 * The changelog section, with any `UPGRADE:` lines lifted into a callout at the top, then (for a stable release) how to
 * install, the diff from the previous tag, the checksums, and how to check that a file was built by the release
 * workflow (its build provenance, attested by GitHub). A pre-release says it is one and gives no install command:
 * it never becomes what the install command fetches.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sectionOf } from "./release";

const UPGRADE = /^\s*(?:[-*]\s+)?UPGRADE:\s*(.*)$/;

export const isPrerelease = (version: string) => version.includes("-");

/** The section's text without its `UPGRADE:` lines, and those lines' words. */
export function splitUpgrade(section: string): { body: string; upgrade: string[] } {
  const upgrade: string[] = [];
  const kept = section.split("\n").filter((l) => {
    const m = UPGRADE.exec(l);
    if (m) upgrade.push(m[1]!.trim());
    return !m;
  });
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), upgrade };
}

export type Notes = { version: string; section: string; repo: string; prev?: string; sums?: string };

export function releaseNotes(n: Notes): string {
  const { body, upgrade } = splitUpgrade(n.section);
  const out: string[] = [];
  if (upgrade.length) out.push(["> [!IMPORTANT]", "> **When you update:**", ...upgrade.map((u) => `> - ${u}`)].join("\n"));
  if (isPrerelease(n.version)) out.push("> [!NOTE]\n> This is a pre-release. The install command does not fetch it; download your system's file below.");
  out.push(body || "No notes.");
  if (!isPrerelease(n.version)) {
    out.push(
      [
        "## Install or update",
        "",
        "```sh",
        "# macOS and Linux",
        "curl -fsSL https://solipsist.sh/install | sh",
        "```",
        "",
        "```powershell",
        "# Windows",
        "irm https://solipsist.sh/install.ps1 | iex",
        "```",
      ].join("\n"),
    );
  }
  if (n.prev) out.push(`**Full diff:** https://github.com/${n.repo}/compare/${n.prev}...v${n.version}`);
  if (n.sums?.trim()) out.push(["## Checksums (SHA-256)", "", "```", n.sums.trim(), "```"].join("\n"));
  out.push(
    [
      "## Check a download",
      "",
      "Every file here was built from this tag by the repository's release workflow, and GitHub keeps a signed record of",
      "that. To check one with the [GitHub CLI](https://cli.github.com):",
      "",
      "```sh",
      `gh attestation verify solipsist-linux-x64.tar.gz --repo ${n.repo}`,
      "```",
    ].join("\n"),
  );
  return out.join("\n\n") + "\n";
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const version = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!version) {
    console.error("Usage: bun scripts/release-notes.ts <version> [--prev vX.Y.Z] [--sums <file>] [--repo owner/name]");
    process.exit(1);
  }
  const root = resolve(import.meta.dir, "..");
  const section = sectionOf(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), version!);
  if (section === null) {
    console.error(`CHANGELOG.md has no section for ${version}.`);
    process.exit(1);
  }
  const sumsFile = opt("sums");
  process.stdout.write(
    releaseNotes({ version: version!, section, repo: opt("repo") ?? "pulkitsharma07/solipsist", prev: opt("prev"), sums: sumsFile ? readFileSync(sumsFile, "utf8") : undefined }),
  );
}
