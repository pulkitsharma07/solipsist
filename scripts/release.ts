/**
 * Cut a release: `bun scripts/release.ts <patch|minor|major|x.y.z[-beta.N]> [--dry-run]`.
 *
 * Refuses a checkout that isn't clean, isn't on `main`, whose tag exists, whose `## [Unreleased]` has no entries, or
 * whose `bun test` is red. Then it renames `## [Unreleased]` to `## [x.y.z] — YYYY-MM-DD` (a new empty one above it),
 * sets `package.json`'s version, commits "Release x.y.z" and makes the annotated tag `vx.y.z`. It never pushes: it
 * prints the command, so the tag (which starts the release workflow) is the maintainer's own push.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-((?:alpha|beta|rc)\.\d+))?$/;

/** The version a bump asks for: `patch`, `minor`, `major` or an explicit `x.y.z[-beta.N]`; throws on anything else. */
export function nextVersion(current: string, arg: string): string {
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`The current version "${current}" isn't x.y.z.`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre = m[4] !== undefined;
  let next: string;
  if (arg === "major") next = `${maj + 1}.0.0`;
  else if (arg === "minor") next = `${maj}.${min + 1}.0`;
  // A pre-release's patch is the release it was heading for: 0.2.0-beta.1 -> 0.2.0.
  else if (arg === "patch") next = pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
  else if (SEMVER.test(arg)) next = arg;
  else throw new Error(`"${arg}" isn't patch, minor, major or a version like 1.2.3 or 1.2.3-beta.1.`);
  if (next === current) throw new Error(`The version is already ${current}.`);
  if (compare(next, current) < 0) throw new Error(`${next} is older than ${current}.`);
  return next;
}

/** -1, 0, 1 by semver precedence (a pre-release is below its release; `beta.2` above `beta.1`). */
export function compare(a: string, b: string): number {
  const pa = SEMVER.exec(a)!, pb = SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const [ka, na] = pa[4].split("."), [kb, nb] = pb[4].split(".");
  if (ka !== kb) return ka! < kb! ? -1 : 1;
  return Number(na) < Number(nb) ? -1 : Number(na) > Number(nb) ? 1 : 0;
}

const heading = /^## \[([^\]]+)\].*$/;

/** The body of a version's section (`Unreleased` or `1.2.3`), trimmed; null when the changelog has none. */
export function sectionOf(changelog: string, name: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => heading.exec(l)?.[1] === name);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && heading.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** `## [Unreleased]` becomes `## [version] — date`, with a new empty one above; throws when it has no entries. */
export function promote(changelog: string, version: string, date: string): string {
  const body = sectionOf(changelog, "Unreleased");
  if (body === null) throw new Error("CHANGELOG.md has no `## [Unreleased]` section.");
  if (!/^\s*[-*] /m.test(body)) throw new Error("`## [Unreleased]` in CHANGELOG.md has no entries: write what changed first.");
  if (sectionOf(changelog, version) !== null) throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  const out = changelog.replace(/^## \[Unreleased\].*$/m, `## [Unreleased]\n\n## [${version}] — ${date}`);
  if (out === changelog) throw new Error("Could not rewrite the Unreleased heading.");
  return out;
}

function run(cmd: string[], cwd: string, inherit = false) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: inherit ? "inherit" : "pipe", stderr: inherit ? "inherit" : "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout?.toString().trim() ?? "", err: r.stderr?.toString().trim() ?? "" };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const arg = args.find((a) => !a.startsWith("--"));
  const fail = (m: string): never => {
    console.error(m);
    process.exit(1);
  };
  if (!arg) fail("Usage: bun scripts/release.ts <patch|minor|major|x.y.z[-beta.N]> [--dry-run]");
  const pkgPath = join(root, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const current = JSON.parse(pkgText).version as string;
  let version = "";
  try {
    version = nextVersion(current, arg!);
  } catch (e: any) {
    fail(e.message);
  }
  const tag = `v${version}`;
  if (run(["git", "status", "--porcelain"], root).out) fail("The working tree has changes: commit or move them first.");
  const branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], root).out;
  if (branch !== "main") fail(`A release is cut from main, not ${branch}.`);
  if (run(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`], root).ok) fail(`The tag ${tag} already exists.`);
  const changelogPath = join(root, "CHANGELOG.md");
  let changelog = "";
  try {
    changelog = promote(readFileSync(changelogPath, "utf8"), version, new Date().toISOString().slice(0, 10));
  } catch (e: any) {
    fail(e.message);
  }
  console.log(`${current} -> ${version} (tag ${tag})`);
  if (dry) {
    console.log("--dry-run: nothing written.");
    process.exit(0);
  }
  console.log("bun test …");
  if (!run(["bun", "test"], root, true).ok) fail("bun test is red: no release.");
  const bumped = pkgText.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
  if (bumped === pkgText) fail("Could not set the version in package.json.");
  writeFileSync(pkgPath, bumped);
  writeFileSync(changelogPath, changelog);
  const steps = [
    ["git", "add", "package.json", "CHANGELOG.md"],
    ["git", "commit", "-m", `Release ${version}`],
    ["git", "tag", "-a", tag, "-m", `Solipsist ${version}`],
  ];
  for (const s of steps) {
    const r = run(s, root);
    if (!r.ok) fail(`${s.join(" ")} failed:\n${r.err}`);
  }
  console.log(`\nReleased ${version} locally. To publish it (this starts the release workflow):\n  git push origin main ${tag}`);
}
