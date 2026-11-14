import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { blockSizes, emptyBlock, parseFile, serializeFile, type CommentsBlock } from "../src/shared/docfile";

const block = (): CommentsBlock => ({
  ...emptyBlock(),
  agent: { model: "fake:small", chat: { engine: "pi", model: "m", session: "s1" }, solo: { engine: "fake", model: "small", session: "s2" } },
  tasks: {
    abc: { type: "gen", created_by: "writer", created: "2026-01-01T00:00:00.000Z", status: "suggested", suggestion: "Some <b>suggested</b> text", edits: [{ before: "a", after: "b" }] },
    def: { type: "sel", created_by: "writer", created: "2026-01-01T00:00:00.000Z", status: "pending" },
  },
});

test("the sizes add up for a page with records", () => {
  const body = readFileSync(`${import.meta.dir}/fixtures/everything.md`, "utf8");
  const file = serializeFile(body, block());
  const s = blockSizes(file);
  expect(s.total).toBe(Buffer.byteLength(file));
  expect(s.body + s.hidden).toBe(s.total);
  expect(s.body).toBe(Buffer.byteLength(parseFile(file).markdown) + 2);
  for (const k of ["records", "proposals", "chat", "solo"] as const) expect(s[k]).toBeGreaterThan(0);
  expect(s.proposals).toBeLessThan(s.records);
  // Parts are lines of the block: together under it, and the block is the rest (meta, agent keys, comments).
  expect(s.comments + s.records + s.chat + s.solo).toBeLessThan(s.hidden);
});

test("a page with no block is all body", () => {
  const s = blockSizes("# Hi\n");
  expect(s).toMatchObject({ total: 5, body: 5, hidden: 0, records: 0 });
});
