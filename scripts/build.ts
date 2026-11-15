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
 * name, holding a folder with `solipsist` (`solipsist.exe`), `LICENSE`, `NOTICE` and `README.md`.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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

function shell(cmd: string[], cwd: string) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${r.stderr.toString()}`);
}

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
};

export type BuildResult = { target: Target; archive: string; binary: string; bytes: number };

export async function buildTarget(t: Target, o: { out: string; commit: string; built: string }): Promise<BuildResult> {
  const exe = t.startsWith("windows") ? "solipsist.exe" : "solipsist";
  const stage = join(o.out, `stage-${t}`, `solipsist-${pkg.version}-${t}`);
  rmSync(join(o.out, `stage-${t}`), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    plugins: [tailwind],
    minify: true,
    define: { SOLIPSIST_COMMIT: JSON.stringify(o.commit), SOLIPSIST_BUILT: JSON.stringify(o.built), "process.env.NODE_ENV": '"production"' },
    compile: { target: bunTarget(t), outfile: join(stage, exe) },
  });
  if (!result.success) throw new Error(`Build for ${t} failed:\n${result.logs.map((l) => l.message).join("\n")}`);
  for (const f of ["LICENSE", "NOTICE", "README.md"]) cpSync(join(root, f), join(stage, f));
  const archive = join(o.out, archiveName(t));
  rmSync(archive, { force: true });
  const dir = basename(stage);
  if (t.startsWith("windows")) shell(["zip", "-qr", archive, dir], join(o.out, `stage-${t}`));
  else shell(["tar", "-czf", archive, dir], join(o.out, `stage-${t}`));
  const bytes = Bun.file(join(stage, exe)).size;
  return { target: t, archive, binary: join(stage, exe), bytes };
}

export const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

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
  const built = new Date().toISOString().slice(0, 10);
  if (git("status", "--porcelain", "--untracked-files=no")) console.warn("warning: the checkout has changes; the commit below doesn't describe this build.");
  mkdirSync(out, { recursive: true });
  const results: BuildResult[] = [];
  for (const t of targets) {
    const r = await buildTarget(t, { out, commit, built });
    console.log(`${t.padEnd(13)} ${(r.bytes / 1e6).toFixed(1)} MB  ${basename(r.archive)}`);
    results.push(r);
  }
  writeFileSync(join(out, "SHA256SUMS"), sumsText(results.map((r) => r.archive)));
  for (const r of results) rmSync(join(out, `stage-${r.target}`), { recursive: true, force: true });
  console.log(`\n${results.length} archive(s) and SHA256SUMS in ${out}`);
  if (!existsSync(join(out, "SHA256SUMS"))) process.exit(1);
}
