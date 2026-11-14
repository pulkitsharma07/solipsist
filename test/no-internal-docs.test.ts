// The plans, reviews and notes live in `internal/`, which git ignores: nothing published may point at one, since a
// reader of the public repo can't follow it. Say what the code does in the comment instead.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.env.SOLIPSIST_TEST_REPO!;
const DIRS = ["src", "scripts", "test", "site", "design", "blogs", ".github"];
const FILES = ["README.md", "AGENTS.md", "NOTICE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "CONFIGURATION.md",
  "package.json", ".env.example", "solipsist.example.yaml", "FEATURES.html"];
const TEXT = /\.(tsx?|css|html|mdx?|astro|mjs|ya?ml|json|sh)$/;
const INTERNAL = /\b(ARCHITECTURE_REVIEW|BLOG_POST_IDEAS|HANDOFF|LANDING_PAGE|MONETISATION|ONBOARDING_REVIEW|PRODUCT|REFACTORING_PLAN_\d|landing_page_thinking)(\.md)?\b|\bproject-[a-z-]+-(plan|checklist)\b|\bdocs-archive\/|\binternal\//;
/** Real pages kept as fixtures, and this file. */
const SKIP = ["test/fixtures/", "test/no-internal-docs.test.ts"];

/** Installed or built, not written here (the website's own `node_modules`, `dist` and `.astro`). */
const SKIP_DIRS = ["node_modules", "dist", ".astro"];

const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir).filter((n) => !SKIP_DIRS.includes(n)).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : TEXT.test(n) ? [p] : [];
  });

test("nothing published names an internal doc", () => {
  const files = [...DIRS.flatMap((d) => walk(join(REPO, d))), ...FILES.map((f) => join(REPO, f)).filter(existsSync)]
    .map((f) => relative(REPO, f))
    .filter((f) => !SKIP.some((s) => f.startsWith(s)));
  const found = files.flatMap((f) => readFileSync(join(REPO, f), "utf8").split("\n").flatMap((l, i) =>
    INTERNAL.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 160)}`] : []));
  expect(found).toEqual([]);
});
