/**
 * Cut a release: `bun scripts/release.ts <patch|minor|major|x.y.z[-beta.N]> [--dry-run]`.
 *
 * Refuses a checkout that isn't clean, isn't on `main`, is behind `origin/main` (fetched first), whose tag exists, whose
 * `## [Unreleased]` has no entries, or whose `bun test` is red. Then it renames `## [Unreleased]` to `## [x.y.z] — YYYY-MM-DD` (a new empty one above it),
 * sets `package.json`'s version, commits "Release x.y.z" and makes the annotated tag `vx.y.z`. It never pushes: it
 * prints the command, so the tag (which starts the release workflow) is the maintainer's own push. That command is
 * `git push --atomic`: the tag can't land without main, which the workflow would refuse as "not on main", leaving a
 * public tag that may not be moved.
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

export type CutOptions = {
  /** The checkout. */
  root: string;
  /** `patch`, `minor`, `major` or `x.y.z[-beta.N]`. */
  arg: string;
  /** Check and say what it would do; write nothing. */
  dry?: boolean;
  /** The full suite; true when green. */
  runTests?: (root: string) => boolean;
  /** The changelog's date for the version, `YYYY-MM-DD`. */
  date?: string;
  log?: (line: string) => void;
};

/** Cuts the release in `root` (see the top of this file); throws, having written nothing, when it refuses. */
export function cut(o: CutOptions): { version: string; tag: string; push: string } {
  const log = o.log ?? (() => {});
  const git = (...args: string[]) => run(["git", ...args], o.root);
  const pkgPath = join(o.root, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const current = JSON.parse(pkgText).version as string;
  const version = nextVersion(current, o.arg);
  const tag = `v${version}`;
  if (git("status", "--porcelain").out) throw new Error("The working tree has changes: commit or move them first.");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").out;
  if (branch !== "main") throw new Error(`A release is cut from main, not ${branch}.`);
  if (git("rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) throw new Error(`The tag ${tag} already exists.`);
  // The push must be a fast-forward of origin's main, or main is refused and the tag goes alone.
  const fetched = git("fetch", "--quiet", "origin", "main");
  if (!fetched.ok) throw new Error(`Could not fetch origin's main, to check this main is not behind it:\n${fetched.err}`);
  if (!git("merge-base", "--is-ancestor", "origin/main", "HEAD").ok) throw new Error("main is behind origin/main (or has diverged from it): pull first.");
  const changelogPath = join(o.root, "CHANGELOG.md");
  const changelogText = readFileSync(changelogPath, "utf8");
  const changelog = promote(changelogText, version, o.date ?? new Date().toISOString().slice(0, 10));
  const push = `git push --atomic origin main ${tag}`;
  log(`${current} -> ${version} (tag ${tag})`);
  if (o.dry) return { version, tag, push };
  log("bun test …");
  if (!(o.runTests ?? ((root) => run(["bun", "test"], root, true).ok))(o.root)) throw new Error("bun test is red: no release.");
  const bumped = pkgText.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`);
  if (bumped === pkgText) throw new Error("Could not set the version in package.json.");
  writeFileSync(pkgPath, bumped);
  writeFileSync(changelogPath, changelog);
  const steps = [
    ["add", "package.json", "CHANGELOG.md"],
    ["commit", "-m", `Release ${version}`],
    ["tag", "-a", tag, "-m", `Solipsist ${version}`],
  ];
  for (const s of steps) {
    const r = git(...s);
    if (!r.ok) throw new Error(`git ${s.join(" ")} failed:\n${r.err}`);
  }
  return { version, tag, push };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) {
    console.error("Usage: bun scripts/release.ts <patch|minor|major|x.y.z[-beta.N]> [--dry-run]");
    process.exit(1);
  }
  try {
    const r = cut({ root: resolve(import.meta.dir, ".."), arg, dry: args.includes("--dry-run"), log: (l) => console.log(l) });
    if (args.includes("--dry-run")) console.log(`--dry-run: nothing written. Then: ${r.push}`);
    else console.log(`\nReleased ${r.version} locally. To publish it (this starts the release workflow):\n  ${r.push}`);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
}
