// One definition of "the body as the file stores it" (`canonicalBody`), used wherever a body is stored, sent or compared.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPut } from "../src/server/put";
import { canonicalBody, docToMarkdown, emptyBlock, markdownToDoc, parseFile, serializeFile } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const items = (tab: Tab) => {
  let n = 0;
  tab.doc.descendants((node) => { if (node.type.name === "listItem" || node.type.name === "taskItem") n++; });
  return n;
};

for (const [name, md] of [["ordered", "1. a\n2. "], ["bullet", "- a\n- "]] as const) {
  test(`an empty last ${name} list item survives a save, a reload and a hand edit elsewhere`, async () => {
    const server = new Server(md);
    const tab = new Tab(server.src);
    expect(items(tab)).toBe(2);
    expect((await tab.save(server)).ok).toBe(true);
    expect(server.markdown).toBe(md);
    expect(items(new Tab(server.src))).toBe(2);
    server.handEdit((m) => `Above.\n\n${m}`);
    tab.receive(server.src);
    expect(items(tab)).toBe(2);
    expect((await tab.save(server)).ok).toBe(true);
    expect(server.markdown).toBe(`Above.\n\n${md}`);
  });
}

test("canonicalBody: blank is empty; trailing blank lines go; the last line's spaces stay", () => {
  expect(canonicalBody("")).toBe("");
  expect(canonicalBody(" \n\n \t\n")).toBe("");
  expect(canonicalBody("a\n\n  \n")).toBe("a");
  expect(canonicalBody("1. a\n2. ")).toBe("1. a\n2. ");
  expect(canonicalBody("1. a\n2. \n\n")).toBe("1. a\n2. ");
  expect(canonicalBody("a\r\n\r\n")).toBe("a");
});

test("a save and a file read agree on the body, whatever trailing whitespace the client or a hand edit left", () => {
  const src = serializeFile("# T", emptyBlock());
  const r = applyPut(src, { client_id: "a", base_rev: 0, markdown: "# T\n\nBody\n\n\n", comments: {} });
  expect(r.ok && parseFile(r.file).markdown).toBe("# T\n\nBody");
  expect(parseFile("# T\n\nBody\n\n  \n\n<!-- solip-comments\n{}\n-->\n").markdown).toBe("# T\n\nBody");
});

test("bodies ending in a gen marker, a sel range or trailing spaces round trip", () => {
  for (const md of ["Some text. <!-- gen:abc -->", "<!-- sel:abc -->Plan it<!-- /sel:abc -->", "- a\n- <!-- gen:abc -->"]) {
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    expect(parseFile(serializeFile(md, emptyBlock())).markdown).toBe(md);
  }
});

test("canonicalBody is idempotent, and docToMarkdown output is already canonical, over every fixture", () => {
  const dir = join(import.meta.dir, "fixtures");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
    const src = parseFile(readFileSync(join(dir, name), "utf8")).markdown;
    for (const x of [src, `${src}\n\n  \n`, docToMarkdown(markdownToDoc(src))]) {
      expect(canonicalBody(canonicalBody(x))).toBe(canonicalBody(x));
    }
    const out = docToMarkdown(markdownToDoc(src));
    expect(canonicalBody(out)).toBe(out);
  }
});
