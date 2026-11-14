// The page format (`FORMAT`, src/shared/docfile/file.ts): every write says which it is, every build keeps the keys it
// doesn't know, and a page from a newer build is shown but never written — by a save, the agents, the settings or Sync.
// `test/fixtures/format-<n>/` holds pages of every format there has been: each must open and round-trip forever.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { apiRoutes } from "../src/server/routes";
import { readSettings, writeSettings } from "../src/server/agent/settings";
import { NewerPageError } from "../src/server/files";
import { docToMarkdown, FORMAT, formatOf, markdownToDoc, parseFile, serializeFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-format-");
beforeAll(() => { P.enter(); GlobalRegistrator.register(); });
afterAll(() => { GlobalRegistrator.unregister(); P.done(); });

const fixtures = join(import.meta.dir, "fixtures");
const formats = readdirSync(fixtures).filter((d) => /^format-\d+$/.test(d)).map((d) => Number(d.slice(7))).sort((a, b) => a - b);

/** A page in a format no build knows yet, with a key and a marker of its own. */
const FUTURE = `# From later

Some text <!-- gen:abc --> and a marker of a kind this build has never seen: <!-- zap:q1 -->.

<!-- solip-comments
"format": 99
"meta":
  "rev": 3
  "body_rev": 3
  "body_by": "server"
"comments": {}
"lenses":
  "q1": "a key this build doesn't know"
-->
`;

describe("which format a file is", () => {
  test("every write says it, first in the block", () => {
    const out = serializeFile("# Hi", { meta: { rev: 1, body_rev: 1, body_by: null }, comments: {} });
    expect(out).toContain(`<!-- solip-comments\n"format": ${FORMAT}\n"meta":`);
    expect(parseFile(out).format).toBe(FORMAT);
    expect(formatOf(out)).toBe(FORMAT);
  });

  test("a file from before the number is format 1; one that says nothing readable is newer than any", () => {
    for (const [src, n] of [
      ["# No block at all", 1],
      ["# Old\n\n<!-- solip-comments\n\"meta\":\n  \"rev\": 1\n\"comments\": {}\n-->\n", 1],
      [FUTURE, 99],
      ["# X\n\n<!-- solip-comments\n\"format\": \"two\"\n\"comments\": {}\n-->\n", Number.POSITIVE_INFINITY],
      ["# X\n\n<!-- solip-comments\n\"format\": 1.5\n\"comments\": {}\n-->\n", Number.POSITIVE_INFINITY],
      // Only the block's own top level counts, not a record's field of the same name.
      ["# X\n\n<!-- solip-comments\n\"meta\":\n  \"format\": 7\n\"comments\": {}\n-->\n", 1],
    ] as const) {
      expect([src, parseFile(src).format]).toEqual([src, n]);
      expect([src, formatOf(src)]).toEqual([src, n]);
    }
  });
});

describe("keys this build doesn't know are kept", () => {
  test("at the top, in the agent settings, on a comment and on a task record, through a read and a write", () => {
    const src = `# Page <!-- gen:abc:sug -->

<!-- solip-comments
"format": 1
"lenses":
  "q1": "kept"
"meta":
  "rev": 2
  "body_rev": 2
  "body_by": "server"
"agent":
  "model": "pi:x/y"
  "tone": "kept too"
"comments":
  "c1":
    "id": "c1"
    "status": "open"
    "thinker": "review"
    "title": "T"
    "anchor":
      "quote": "Page"
    "created": "2026-11-11T00:00:00.000Z"
    "created_rev": 1
    "colour": "kept"
"tasks":
  "abc":
    "type": "gen"
    "created_by": "writer"
    "created": "2026-11-11T00:00:00.000Z"
    "status": "suggested"
    "suggestion": "x"
    "confidence": 0.8
-->
`;
    const f = parseFile(src);
    expect(f.block.extra).toEqual({ lenses: { q1: "kept" } });
    const again = parseFile(serializeFile(f.markdown, f.block));
    expect(again.block.extra).toEqual({ lenses: { q1: "kept" } });
    expect((again.block.agent as Record<string, unknown>).tone).toBe("kept too");
    expect((again.block.comments.c1 as unknown as Record<string, unknown>).colour).toBe("kept");
    expect((again.block.tasks!.abc as unknown as Record<string, unknown>).confidence).toBe(0.8);
  });

  test("through a save from the page and a change of the agent settings", async () => {
    const id = "kept";
    writeFileSync(join(P.docs, `${id}.md`), serializeFile("# Kept", { meta: { rev: 1, body_rev: 1, body_by: "server" }, comments: {}, agent: { model: "pi:x/y", ...({ tone: "t" } as object) }, extra: { lenses: { a: 1 } } }));
    const { rev } = await (await route("/api/pages/:id", "GET", id)).json();
    const put = await route("/api/pages/:id", "PUT", id, { client_id: "a", base_rev: rev, markdown: "# Kept, and changed", comments: {} });
    expect(put.status).toBe(200);
    await writeSettings(id, { on: false });
    const f = parseFile(readFileSync(join(P.docs, `${id}.md`), "utf8"));
    expect(f.markdown).toBe("# Kept, and changed");
    expect(f.block.extra).toEqual({ lenses: { a: 1 } });
    expect(f.block.agent).toEqual({ model: "pi:x/y", tone: "t", on: false } as object);
  });
});

/** One route of the real server, as the browser calls it (the routes are where a refused write becomes a 423). */
async function route(path: string, method: string, id: string, body?: unknown): Promise<Response> {
  const handler = (apiRoutes() as unknown as Record<string, Record<string, (req: unknown, srv: unknown) => Promise<Response>>>)[path]![method]!;
  const req = Object.assign(new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id } });
  return handler(req, { timeout() {} });
}

describe("a page from a newer Solipsist", () => {
  const id = "future";
  const file = () => join(P.docs, `${id}.md`);
  beforeAll(() => writeFileSync(file(), FUTURE));

  test("is read as it is", async () => {
    const r = await route("/api/pages/:id", "GET", id);
    expect(r.status).toBe(200);
    expect((await r.json()).file).toBe(FUTURE);
  });

  test("is never written: a save, the agent settings and Sync are refused, and the file is untouched", async () => {
    const put = await route("/api/pages/:id", "PUT", id, { client_id: "a", base_rev: 3, markdown: "# Mine now", comments: {} });
    expect(put.status).toBe(423);
    expect(await put.json()).toMatchObject({ error: { code: "newer_format", message: expect.stringContaining("saved by a newer Solipsist (page format 99; this one knows up to 1)") }, format: 99 });
    expect((await route("/api/pages/:id/agent", "POST", id, { on: false })).status).toBe(423);
    expect((await route("/api/pages/:id/sync", "POST", id, {})).status).toBe(423);
    await expect(writeSettings(id, { model: "pi:a/b" })).rejects.toBeInstanceOf(NewerPageError);
    expect(readFileSync(file(), "utf8")).toBe(FUTURE);
  });

  test("has its agents off, whatever it says, so nothing starts on it", () => {
    expect(readSettings(id).on).toBe(false);
  });

  test("the page shows it read-only, and says why", async () => {
    const { NewerPage, newerFormat } = await import("../src/app/pages/NewerPage");
    expect(newerFormat(FUTURE)).toBe(99);
    expect(newerFormat(serializeFile("# Now", { meta: { rev: 1, body_rev: 1, body_by: null }, comments: {} }))).toBeNull();
    const html = renderToStaticMarkup(<MemoryRouter><NewerPage title="future.md" file={FUTURE} format={99} /></MemoryRouter>);
    expect(html).toContain("Read-only");
    expect(html).toContain("This page was saved by a newer Solipsist (page format 99; this one knows up to 1). Update Solipsist to edit it");
  });
});

describe("every format there has been opens and round-trips", () => {
  test("the current format has its fixtures", () => expect(formats).toContain(FORMAT));
  for (const n of formats) {
    for (const name of readdirSync(join(fixtures, `format-${n}`)).filter((f) => f.endsWith(".md"))) {
      test(`format-${n}/${name}`, () => {
        const src = readFileSync(join(fixtures, `format-${n}`, name), "utf8");
        const f = parseFile(src);
        expect(f.problem).toBeUndefined();
        expect(f.format).toBe(n);
        // Opened and written again, unchanged (an older format is written as the current one, its meaning the same).
        if (n === FORMAT) expect(serializeFile(f.markdown, f.block)).toBe(src);
        else expect(parseFile(serializeFile(f.markdown, f.block)).block).toEqual(f.block);
        // Its body reads as a document and writes back as itself.
        expect(docToMarkdown(markdownToDoc(f.markdown))).toBe(f.markdown);
      });
    }
  }
});
