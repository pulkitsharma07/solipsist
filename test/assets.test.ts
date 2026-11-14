// Images that sit next to a page (`![x](images/a.svg)`): the markdown keeps the path, the page loads it from the server.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetPath, assetUrl, docToMarkdown, markdownToDoc, pageExtensions } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

describe("paths and urls", () => {
  test("a relative path is served from /api/assets; web, data and rooted addresses stay as they are", () => {
    expect(assetUrl("images/a.svg")).toBe("/api/assets/images/a.svg");
    expect(assetUrl("./images/a.svg")).toBe("/api/assets/images/a.svg");
    for (const u of ["https://x.test/a.png", "http://x.test/a.png", "data:image/png;base64,AA", "/public/a.png", "//cdn.test/a.png"]) expect(assetUrl(u)).toBe(u);
  });

  test("the path is recovered from the url", () => {
    expect(assetPath("/api/assets/images/a.svg")).toBe("images/a.svg");
    expect(assetPath("https://x.test/a.png")).toBe("https://x.test/a.png");
    expect(assetPath(null)).toBeNull();
  });
});

describe("in the page", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());

  test("the image element loads from the server, and the markdown keeps the path as written", async () => {
    const { Editor } = await import("@tiptap/core");
    const md = "# T\n\n![A chart](images/chart.svg)\n\n![Out there](https://x.test/b.png)";
    const editor = new Editor({ element: document.createElement("div"), extensions: pageExtensions(), content: markdownToDoc(md).toJSON() });
    const srcs = [...editor.view.dom.querySelectorAll("img:not(.ProseMirror-separator)")].map((i) => i.getAttribute("src")).filter(Boolean);
    expect(srcs).toEqual(["/api/assets/images/chart.svg", "https://x.test/b.png"]);
    const out = docToMarkdown(editor.state.doc);
    expect(out).toContain("![A chart](images/chart.svg)");
    expect(out).toContain("![Out there](https://x.test/b.png)");
    expect(out).not.toContain("/api/assets");
  });

  test("an image pasted back in as html gets its path, not the url", async () => {
    const { Editor } = await import("@tiptap/core");
    const editor = new Editor({ element: document.createElement("div"), extensions: pageExtensions(), content: '<p><img src="/api/assets/images/chart.svg" alt="A chart"></p>' });
    expect(docToMarkdown(editor.state.doc)).toContain("![A chart](images/chart.svg)");
  });
});

describe("the endpoint", () => {
  const P = projectDir("solip-assets-");
  const root = P.root;
  // Assets are resolved against the project, which is where the pages' own images sit beside them.
  mkdirSync(join(root, "images"), { recursive: true });
  writeFileSync(join(root, "images", "a.svg"), "<svg/>");
  writeFileSync(join(P.docs, "page.md"), "# secret");
  writeFileSync(join(root, "..", "outside.txt"), "no");
  P.enter();
afterAll(() => P.done()); // put the project back: the files of a run share the environment
  const get = async (path: string) => (await import("../src/server/api")).assetFile(new Request(`http://localhost/api/assets/${path}`));

  test("serves a file of the project, beside the page that links it", async () => {
    const r = await get("images/a.svg");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<svg/>");
  });

  test("refuses pages, paths out of the folder and files that are not there", async () => {
    expect((await get("page.md")).status).toBe(400);
    expect((await get("%2e%2e/outside.txt")).status).toBe(400);
    expect((await get("..%2Foutside.txt")).status).toBe(400);
    expect((await get("images/missing.svg")).status).toBe(404);
  });
});
