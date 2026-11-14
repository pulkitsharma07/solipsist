// The words: a task is the writer's request, a marker is its comment in the text, a task type is
// what a plugin defines. "Placeholder" was all three; it must not come back as a declared name. The dialect, which maps
// the on-disk format, may still use it.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

const DECLARES = /\b(?:type|interface|class|enum)\s+Placeholder\w*|\b(?:const|let|function)\s+\w*Placeholder\w*/;

test("no type, class or function is named Placeholder* outside the dialect", () => {
  // The repo, not the working directory: the tests run in a scratch project (`test/setup.ts`).
  const found = files(join(process.env.SOLIPSIST_TEST_REPO!, "src"))
    .filter((f) => !f.includes("/dialect/"))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => ({ f, n: i + 1, l })))
    .filter(({ l }) => DECLARES.test(l))
    .map(({ f, n, l }) => `${f}:${n}: ${l.trim()}`);
  expect(found).toEqual([]);
});
