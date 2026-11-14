// Solipsist ships with one real engine, Pi, and nothing of Claude's: the Claude engine and its SDK were taken out
// before the repo went public (the SDK is proprietary). This fails on a new mention in what is published.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.env.SOLIPSIST_TEST_REPO!;
const DIRS = ["src", "scripts", "test", "site", "design", "blogs", ".github"];
const FILES = ["README.md", "AGENTS.md", "NOTICE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "CONFIGURATION.md",
  "package.json", ".env.example", ".gitignore", "solipsist.example.yaml", "FEATURES.html"];
const TEXT = /\.(tsx?|css|html|md|ya?ml|json|sh)$/;
/** Real pages kept as fixtures, what a writer wrote, not ours; and the blog, which may name the tools its writer uses. */
const SKIP = ["test/fixtures/", "test/no-claude.test.ts", "blogs/"];

/** The mentions that are not Claude's engine. */
const ALLOWED: [file: RegExp, line: RegExp][] = [
  // Models on OpenRouter, which Pi runs like any other.
  [/./, /openrouter\/anthropic\/claude-[a-z0-9.-]+|"Anthropic: /],
];

const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : TEXT.test(n) ? [p] : [];
  });

test("nothing published names Claude or Anthropic, but for models Pi runs on OpenRouter", () => {
  const files = [...DIRS.flatMap((d) => walk(join(REPO, d))), ...FILES.map((f) => join(REPO, f)).filter(existsSync)]
    .map((f) => relative(REPO, f))
    .filter((f) => !SKIP.some((s) => f.startsWith(s)));
  const found = files.flatMap((f) => readFileSync(join(REPO, f), "utf8").split("\n").flatMap((l, i) => {
    if (!/claude|anthropic/i.test(l)) return [];
    const rest = ALLOWED.filter(([file]) => file.test(f)).reduce((s, [, line]) => s.replace(new RegExp(line, "g"), ""), l);
    return /claude|anthropic/i.test(rest) ? [`${f}:${i + 1}: ${l.trim().slice(0, 160)}`] : [];
  }));
  expect(found).toEqual([]);
});
