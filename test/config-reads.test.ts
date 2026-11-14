import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENV_ONLY, TABLE } from "../src/server/config";

// Settings are read through config(), never process.env: a new setting is a row in the table (src/server/config.ts).
const src = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

test("every process.env name in src/ is in the settings table or the env-only list", () => {
  const known = new Set([...TABLE.map((s) => s.env), ...ENV_ONLY.map((e) => e.name)]);
  const unknown: string[] = [];
  for (const f of files(src)) {
    if (f.endsWith("server/config.ts")) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (!known.has(m[1]!)) unknown.push(`${f.slice(src.length + 1)}: ${m[1]}`);
    for (const m of text.matchAll(/process\.env\[(?!")/g)) unknown.push(`${f.slice(src.length + 1)}: a computed process.env[…] (${m.index})`);
  }
  expect(unknown).toEqual([]);
});

test("a setting in the table is not read from process.env by name outside config.ts", () => {
  const settings = new Set(TABLE.map((s) => s.env));
  const direct: string[] = [];
  for (const f of files(src)) {
    if (f.endsWith("server/config.ts")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (settings.has(m[1]!)) direct.push(`${f.slice(src.length + 1)}: ${m[1]}`);
  }
  expect(direct).toEqual([]);
});
