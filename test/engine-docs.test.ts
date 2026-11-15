// The Engines page says what each engine declares about itself, so it can't drift from the code (src/server/agent/engines).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { engines } from "../src/server/agent/engines";

const page = readFileSync(join(import.meta.dir, "..", "site/src/content/docs/docs/engines/overview.mdx"), "utf8");
const row = (label: string) => page.split("\n").find((l) => l.startsWith(`| ${label} |`)) ?? "";

test("the overview's table agrees with the engines' own flags", () => {
  const list = engines();
  expect(list.map((e) => e.name)).toEqual(["pi"]); // a new engine needs a column here, and its own page
  const pi = list[0]!;
  expect(row("Reports cost")).toContain(pi.reportsCost ? "Yes" : "No");
  expect(row("Confined")).toContain(pi.confined ? "Yes" : "No");
  expect(row("Chat")).toContain(pi.chats ? "Yes" : "No");
});
