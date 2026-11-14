/**
 * Which Solipsist this is. The number is `package.json`'s (the bundler inlines the import, so a compiled binary never
 * reads the file). A release build also sets the commit and the build date as constants (`define` in the release
 * build: `SOLIPSIST_COMMIT`, `SOLIPSIST_BUILT`); a run from source has neither, and says so: `0.1.0-dev+<commit>`,
 * `.dirty` when the checkout has changes, plain `-dev` without git.
 *
 * `solipsist --version` prints `versionLine()`; the bug form asks for it, so its shape is pinned by `test/cli.test.ts`:
 *   release  `solipsist 0.1.0 (darwin-arm64, a1b2c3d, 2026-11-10)`
 *   source   `solipsist 0.1.0-dev+a1b2c3d.dirty (darwin-x64)`
 */
import { join } from "node:path";
import pkg from "../../package.json";

declare const SOLIPSIST_COMMIT: string | undefined;
declare const SOLIPSIST_BUILT: string | undefined;

/** The number alone, as in `package.json` and the tag. */
export const VERSION: string = pkg.version;

export type VersionInfo = {
  /** What this build calls itself: `0.1.0` for a release, `0.1.0-dev+a1b2c3d.dirty` from source. */
  version: string;
  /** The short commit, when known. */
  commit?: string;
  /** The build date (`YYYY-MM-DD`), releases only. */
  built?: string;
  /** `<os>-<arch>`, named as the release assets are: `darwin-arm64`, `linux-x64`, `windows-x64`. */
  target: string;
  dev: boolean;
};

export const targetOf = (platform: string, arch: string) => `${platform === "win32" ? "windows" : platform}-${arch}`;

/** The pure part: what a build with these facts calls itself. */
export function describe(o: { number: string; target: string; release?: { commit: string; built: string }; source?: { commit: string; dirty: boolean } | null }): VersionInfo {
  if (o.release) return { version: o.number, commit: o.release.commit, built: o.release.built, target: o.target, dev: false };
  const s = o.source;
  return { version: s ? `${o.number}-dev+${s.commit}${s.dirty ? ".dirty" : ""}` : `${o.number}-dev`, commit: s?.commit, target: o.target, dev: true };
}

export const lineOf = (v: VersionInfo) =>
  `solipsist ${v.version} (${[v.target, ...(v.dev ? [] : [v.commit, v.built])].filter(Boolean).join(", ")})`;

/** The checkout this source runs from: its commit and whether it has changes; null without git. */
export function sourceCommit(root: string): { commit: string; dirty: boolean } | null {
  const git = (...args: string[]) => {
    try {
      const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
      return r.exitCode === 0 ? r.stdout.toString().trim() : null;
    } catch {
      return null; // no git on the PATH
    }
  };
  const commit = git("rev-parse", "--short", "HEAD");
  if (!commit) return null;
  return { commit, dirty: (git("status", "--porcelain", "--untracked-files=no") ?? "") !== "" };
}

let cached: VersionInfo | undefined;

/** This build. A run from source asks git once. */
export function versionInfo(): VersionInfo {
  if (!cached) {
    const target = targetOf(process.platform, process.arch);
    const release = typeof SOLIPSIST_COMMIT === "string" && typeof SOLIPSIST_BUILT === "string" ? { commit: SOLIPSIST_COMMIT, built: SOLIPSIST_BUILT } : undefined;
    cached = describe({ number: VERSION, target, release, source: release ? undefined : sourceCommit(join(import.meta.dir, "..", "..")) });
  }
  return { ...cached }; // a copy: whoever gets it can't change what the next caller sees
}

export const versionLine = () => lineOf(versionInfo());
