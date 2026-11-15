/**
 * The release build: one self-contained binary per target, cross-compiled on whatever machine runs this (the release
 * workflow uses one Linux runner), then an archive per target and `SHA256SUMS`.
 *
 *   bun scripts/build.ts                       every target
 *   bun scripts/build.ts --target darwin-arm64 one target (`--target host` is this machine's)
 *   bun scripts/build.ts --out dist/release    where the files go (default `dist/release`)
 *
 * Needs `Bun.build` and not `bun build --compile`: the CLI doesn't load the Tailwind plugin from `bunfig.toml`, so the
 * page's CSS would come out wrong. The commit and the date are baked in as constants (`src/server/version.ts`); the
 * number is `package.json`'s, inlined by the bundler.
 *
 * Files, named as the install scripts expect: `solipsist-<os>-<arch>.tar.gz` (`.zip` for windows), no version in the
 * name, holding a folder with `solipsist` (`solipsist.exe`), `LICENSE`, `NOTICE` and `README.md`. Beside them the
 * install scripts themselves (`INSTALLERS`), so the install command can fetch the released one, and `SHA256SUMS` of all.
 *
 * Reproducible: the same commit builds the same archives on the same kind of machine. The time in them (file times and
 * the `--version` date) is the commit's, or `SOURCE_DATE_EPOCH`; files go in sorted, owned by 0, with fixed modes, and
 * the gzip carries no time or name (`archive`).
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import tailwind from "bun-plugin-tailwind";
import pkg from "../package.json";
import { targetOf } from "../src/server/version";

const root = resolve(import.meta.dir, "..");

/** The release assets' names for what Bun calls its targets: `<os>-<arch>`, as `--version` prints them. */
export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
export type Target = (typeof TARGETS)[number];

const bunTarget = (t: Target) => `bun-${t}` as Bun.Build.CompileTarget;

/** No version in the name, so `releases/latest/download/<asset>` is a stable URL; the version is in the release and in `--version`. */
export const archiveName = (t: Target) => `solipsist-${t}.${t.startsWith("windows") ? "zip" : "tar.gz"}`;

/** `--target` words -> the targets to build; throws on one we don't ship. */
export function pickTargets(arg: string | undefined, host = targetOf(process.platform, process.arch)): Target[] {
  if (!arg) return [...TARGETS];
  const names = arg.split(",").map((s) => (s === "host" ? host : s));
  for (const n of names) if (!TARGETS.includes(n as Target)) throw new Error(`Unknown target "${n}". Targets: ${TARGETS.join(", ")}.`);
  return names as Target[];
}

function shell(cmd: string[], cwd: string, env?: Record<string, string>) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env && { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr.toString()}`);
  return r.stdout.toString();
}

const EXECUTABLES = new Set(["solipsist", "solipsist.exe"]);

/** `dir` and everything under it, relative to its parent, folders before their contents, sorted by name. */
function listTree(parent: string, dir: string): string[] {
  const out = [dir];
  for (const name of readdirSync(join(parent, dir)).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(parent, rel)).isDirectory()) out.push(...listTree(parent, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Packs `parent/dir` into `out` (`.zip`, else `.tar.gz`) so the same files make the same bytes: every entry's time is
 * `mtime` (seconds), the modes fixed (0755 for the binary and folders, 0644 for the rest), entries sorted, owner 0, no
 * macOS metadata, and the gzip written here with no time or name in its header.
 */
export function archive(o: { parent: string; dir: string; out: string; mtime: number }) {
  const entries = listTree(o.parent, o.dir);
  for (const rel of [...entries].reverse()) {
    const path = join(o.parent, rel);
    const folder = statSync(path).isDirectory();
    chmodSync(path, folder || EXECUTABLES.has(basename(rel)) ? 0o755 : 0o644);
    utimesSync(path, o.mtime, o.mtime);
  }
  rmSync(o.out, { force: true });
  if (o.out.endsWith(".zip")) {
    // -X: no uid/gid or extra time fields. A zip's times are local: UTC, so the zone of the machine doesn't show.
    shell(["zip", "-X", "-q", "-D", o.out, ...entries.filter((e) => e !== o.dir)], o.parent, { TZ: "UTC" });
    return;
  }
  const tarFile = `${o.out}.tar-tmp`;
  const gnu = shell(["tar", "--version"], o.parent).includes("GNU");
  const owner = gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--uname", "", "--gname", "", "--no-xattrs", "--no-mac-metadata"];
  shell(["tar", "--format=ustar", ...owner, gnu ? "--no-recursion" : "-n", "-cf", tarFile, ...entries], o.parent, { COPYFILE_DISABLE: "1" });
  writeFileSync(o.out, gzipSync(readFileSync(tarFile), { level: 9 }));
  rmSync(tarFile, { force: true });
}

/** The time a build carries: `SOURCE_DATE_EPOCH`, else the commit's, else now (seconds). */
export function buildTime(env: Record<string, string | undefined>, commitTime: string): number {
  const fixed = Number(env.SOURCE_DATE_EPOCH || commitTime);
  return Number.isInteger(fixed) && fixed > 0 ? fixed : Math.floor(Date.now() / 1000);
}

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};

export type BuildResult = { target: Target; archive: string; binary: string; bytes: number };

/**
 * How the binary is compiled. It runs in the writer's folder, which may be anyone's: it reads no `bunfig.toml` from it
 * (a `preload` there would run that folder's code), nor its `tsconfig.json` or `package.json`.
 */
export const compileOptions = (t: Target, outfile: string) => ({
  target: bunTarget(t),
  outfile,
  autoloadBunfig: false,
  autoloadTsconfig: false,
  autoloadPackageJson: false,
});

export async function buildTarget(t: Target, o: { out: string; commit: string; built: string; mtime: number }): Promise<BuildResult> {
  const exe = t.startsWith("windows") ? "solipsist.exe" : "solipsist";
  const stage = join(o.out, `stage-${t}`, `solipsist-${pkg.version}-${t}`);
  rmSync(join(o.out, `stage-${t}`), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    plugins: [tailwind],
    minify: true,
    define: { SOLIPSIST_COMMIT: JSON.stringify(o.commit), SOLIPSIST_BUILT: JSON.stringify(o.built), "process.env.NODE_ENV": '"production"' },
    compile: compileOptions(t, join(stage, exe)),
  });
  if (!result.success) throw new Error(`Build for ${t} failed:\n${result.logs.map((l) => l.message).join("\n")}`);
  for (const f of ["LICENSE", "NOTICE", "README.md"]) cpSync(join(root, f), join(stage, f));
  const file = join(o.out, archiveName(t));
  archive({ parent: join(o.out, `stage-${t}`), dir: basename(stage), out: file, mtime: o.mtime });
  const bytes = Bun.file(join(stage, exe)).size;
  return { target: t, archive: file, binary: join(stage, exe), bytes };
}

export const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The install scripts, released beside the archives: `releases/latest/download/install.sh` is the released one. */
export const INSTALLERS = ["install.sh", "install.ps1"] as const;

/** Copies the install scripts into `out`; returns their paths there. */
export function copyInstallers(out: string): string[] {
  return INSTALLERS.map((f) => {
    const to = join(out, f);
    cpSync(join(root, "scripts", f), to);
    return to;
  });
}

/** `SHA256SUMS` in the format `shasum -a 256 -c` reads. */
export const sumsText = (archives: string[]) => archives.map((a) => `${sha256(a)}  ${basename(a)}\n`).join("");

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = resolve(root, opt("out") ?? "dist/release");
  const targets = pickTargets(opt("target"));
  const commit = git("rev-parse", "--short", "HEAD") || "unknown";
  const mtime = buildTime(process.env, git("log", "-1", "--format=%ct"));
  const built = new Date(mtime * 1000).toISOString().slice(0, 10);
  if (git("status", "--porcelain", "--untracked-files=no")) console.warn("warning: the checkout has changes; the commit below doesn't describe this build.");
  mkdirSync(out, { recursive: true });
  const results: BuildResult[] = [];
  for (const t of targets) {
    const r = await buildTarget(t, { out, commit, built, mtime });
    console.log(`${t.padEnd(13)} ${(r.bytes / 1e6).toFixed(1)} MB  ${basename(r.archive)}`);
    results.push(r);
  }
  writeFileSync(join(out, "SHA256SUMS"), sumsText([...results.map((r) => r.archive), ...copyInstallers(out)]));
  for (const r of results) rmSync(join(out, `stage-${r.target}`), { recursive: true, force: true });
  console.log(`\n${results.length} archive(s), ${INSTALLERS.join(", ")} and SHA256SUMS in ${out}`);
  if (!existsSync(join(out, "SHA256SUMS"))) process.exit(1);
}
