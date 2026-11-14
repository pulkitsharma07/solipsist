// FEATURES.html lists every part of the interface: the catalog (scripts/features/catalog.tsx) must name every component
// the app has, every picture must render, and every file it points at must exist. `bun run features` rewrites the page.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncovered } from "../scripts/features/build";
import { GROUPS } from "../scripts/features/types";

const ROOT = join(import.meta.dir, "..");

test("no component of src/app/pages or src/app/editor is missing from the catalog", async () => {
  // A new component needs an entry in scripts/features/catalog.tsx (or, if it is wiring and not a part of the interface, a line in `SKIP` in build.tsx).
  expect(await uncovered()).toEqual([]);
});

test("every entry renders, in a group that exists, with files that exist", async () => {
  const { catalog } = await import("../scripts/features/catalog");
  // Built by the script in a process of its own: other tests mock modules (`browser-tab.ts` mocks the client) for the whole run.
  const dir = mkdtempSync(join(tmpdir(), "solip-features-"));
  try {
    const out = join(dir, "FEATURES.html");
    const run = Bun.spawn(["bun", "scripts/features/index.tsx"], { cwd: ROOT, env: { ...process.env, FEATURES_OUT: out }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = [await run.exited, await new Response(run.stderr).text()];
    expect(err).not.toContain("Error");
    expect(code).toBe(0);
    const html = readFileSync(out, "utf8");
    const ids = new Set<string>();
    for (const e of catalog) {
      expect(ids.has(e.id)).toBe(false); // an id once: it is the anchor
      ids.add(e.id);
      expect(GROUPS.some((g) => g.id === e.group)).toBe(true);
      expect(e.specimens.length).toBeGreaterThan(0);
      expect(e.use.length).toBeGreaterThan(0);
      for (const f of e.source) expect(existsSync(join(ROOT, f))).toBe(true);
      expect(html).toContain(`id="${e.id}"`);
    }
    for (const g of GROUPS) expect(html).toContain(`id="g-${g.id}"`);
    // Nothing rendered as a failure: no object printed as text, no undefined, no empty picture.
    expect(html).not.toContain("[object Object]");
    expect(html).not.toMatch(/>undefined</);
    expect(html.match(/<div class="f-stage fx-[a-z]+"><\/div>/g) ?? []).toEqual([]);
    // The pictures are the app's own: spot-check that real parts are in them.
    for (const part of ["task-loader", "sug-preview", "sug-card", "agent-note", "ni-done", "chat-modal", "statusbar", "review-badge", "html-comment-chip", "pi-logo"]) expect(html).toContain(part);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
