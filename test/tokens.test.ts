import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The design system (design/index.html): every colour lives in src/app/tokens.css, components use var(--…) only.
const dir = join(import.meta.dir, "../src/app");
const sheets = readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "tokens.css");

test("no raw colour outside tokens.css", () => {
  const bad: string[] = [];
  for (const f of sheets) {
    readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line.replace(/\/\*.*?\*\//g, ""))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  expect(bad).toEqual([]);
});

test("the old aliases and the blue accent are gone", () => {
  for (const f of sheets) {
    const css = readFileSync(join(dir, f), "utf8");
    expect(css).not.toMatch(/var\(--(desk|sheet|panel|bar|bar-line|accent)\)/);
  }
});

test("light by default, dark following the system, either forced by data-theme", () => {
  const css = readFileSync(join(dir, "tokens.css"), "utf8");
  expect(css).toContain("prefers-color-scheme: dark");
  expect(css).toContain(':root[data-theme="dark"]');
  expect(css).toContain(':root:not([data-theme="light"])');
});
