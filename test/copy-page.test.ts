// Copy page: the page as the writer's own text, in markdown (for GitHub) and HTML (for Google Docs), without markers,
// margin comments or hand-written HTML comments, and with its images inlined in the HTML.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyBlock, markdownToDoc, parseFile, serializeFile, type CommentsBlock } from "../src/shared/docfile";
import { browserCopyIO, cleanPage, copyNote, copyPage, inlineImages, INLINE_LIMIT_BYTES, loadImage, pageHtml, pageImages, pageMarkdown, type CopyIO } from "../src/app/doc/copyPage";
import "../src/plugins";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const BODY = [
  "# Title",
  "",
  "Before <!-- gen:abc --> after.",
  "",
  "<!-- gen:def -->",
  "",
  'Some <!-- sel:xyz "make it shorter" -->chosen text<!-- /sel:xyz --> here, and <!-- sel:sss:sug -->suggested<!-- /sel:sss:sug --> too. A note <!-- private note --> inline.',
  "",
  "<!-- a block note -->",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | Tea & coffee |",
  "",
  "![a diagram](images/p1/d.svg)",
  "",
  "- one",
  "- two",
].join("\n");

const EXPECTED_MD = [
  "# Title",
  "",
  "Before after.",
  "",
  "Some chosen text here, and suggested too. A note inline.",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | Tea & coffee |",
  "",
  "![a diagram](images/p1/d.svg)",
  "",
  "- one",
  "- two",
].join("\n");

/** The page as a file on disk, with a record for its `:sug` marker and a margin comment. */
function pageDoc() {
  const block: CommentsBlock = {
    ...emptyBlock(),
    tasks: { sss: { type: "sel", created_by: "writer", created: "2026-01-01T00:00:00Z", status: "suggested", mode: "replace", place: "inline", suggestion: "PROPOSED WORDS" } },
  };
  const file = parseFile(serializeFile(BODY, block));
  return markdownToDoc(file.markdown).toJSON();
}

describe("the markdown", () => {
  test("has no markers or HTML comments, and keeps the range's text, the table and the image", () => {
    const md = pageMarkdown(cleanPage(pageDoc()));
    expect(md).toBe(EXPECTED_MD);
    expect(md).not.toContain("<!--");
    expect(md).not.toContain("PROPOSED");
  });

  test("a page that is only markers still copies as an empty page", () => {
    expect(pageMarkdown(cleanPage(markdownToDoc("<!-- gen:abc -->").toJSON()))).toBe("");
  });

  test("lists each image once, as written", () => {
    expect(pageImages(cleanPage(markdownToDoc("![a](x.png) ![b](x.png)\n\n![c](https://e.com/y.svg)").toJSON()))).toEqual(["x.png", "https://e.com/y.svg"]);
  });
});

describe("the HTML", () => {
  const ORIGIN = "http://localhost:9999";

  test("keeps the table, list, heading and image, and has no markers or comments", () => {
    const html = pageHtml(cleanPage(pageDoc()), document).innerHTML;
    for (const s of ["<h1>Title</h1>", "<table", "<td", "Tea &amp; coffee", "<ul", "<li", 'src="/api/assets/images/p1/d.svg"', "chosen text"]) expect(html).toContain(s);
    for (const s of ["<!--", "data-ph", "task-range", "html-comment", "PROPOSED"]) expect(html).not.toContain(s);
  });

  test("every image becomes a data: URI", async () => {
    const asked: string[] = [];
    const root = pageHtml(cleanPage(pageDoc()), document);
    const result = await inlineImages(root, ORIGIN, async (url) => { asked.push(url); return "data:image/png;base64,AAAA"; });
    expect(asked).toEqual([`${ORIGIN}/api/assets/images/p1/d.svg`]);
    expect(root.innerHTML).toContain('<img src="data:image/png;base64,AAAA"');
    expect(result).toEqual({ linked: 0, overLimit: false });
    expect(copyNote(1, result)).toBe("Copied");
  });

  test("past the size limit the rest stay absolute URLs, and the note says so", async () => {
    const root = pageHtml(cleanPage(markdownToDoc("![a](a.png)\n\n![b](b.png)\n\n![c](c.png)").toJSON()), document);
    const big = "data:image/png;base64," + "A".repeat(INLINE_LIMIT_BYTES / 2);
    const result = await inlineImages(root, ORIGIN, async () => big);
    const srcs = [...root.querySelectorAll("img")].map((i) => i.getAttribute("src")!.slice(0, 40));
    expect(srcs).toEqual([big.slice(0, 40), `${ORIGIN}/api/assets/b.png`, `${ORIGIN}/api/assets/c.png`]);
    expect(result).toEqual({ linked: 2, overLimit: true });
    expect(copyNote(3, result)).toBe("Copied (2 of 3 images linked, not embedded: over 8 MB of images)");
  });

  test("an image that fails to load keeps its URL", async () => {
    const root = pageHtml(cleanPage(markdownToDoc("![a](a.png)").toJSON()), document);
    const result = await inlineImages(root, ORIGIN, async () => { throw new Error("404"); });
    expect(root.querySelector("img")!.getAttribute("src")).toBe(`${ORIGIN}/api/assets/a.png`);
    expect(copyNote(1, result)).toBe("Copied (1 of 1 image linked, not embedded: couldn't load)");
  });
});

describe("the copy", () => {
  const io = (over: Partial<CopyIO> = {}) => {
    const written: Record<string, string> = {};
    const base: CopyIO = {
      document,
      origin: "http://localhost:9999",
      load: async () => "data:image/png;base64,AAAA",
      write: async (items) => { for (const [k, v] of Object.entries(items)) written[k] = await (await v).text(); },
      writeText: async (t) => { written["writeText"] = t; },
      ...over,
    };
    return { io: base, written };
  };

  test("writes both formats in one write", async () => {
    const { io: x, written } = io();
    const r = await copyPage(pageDoc(), x);
    expect(r.note).toBe("Copied");
    expect(written["text/plain"]).toBe(EXPECTED_MD);
    expect(written["text/html"]).toContain('<img src="data:image/png;base64,AAAA"');
    expect(written["text/html"]).toContain("<table");
    expect(written["text/html"]).not.toContain("<!--");
  });

  test("falls back to the markdown alone where the browser can't write HTML", async () => {
    const { io: x, written } = io({ write: null });
    expect((await copyPage(pageDoc(), x)).note).toBe("Copied (as markdown only)");
    expect(written).toEqual({ writeText: EXPECTED_MD });
  });

  test("a refused write fails the copy", async () => {
    const { io: x } = io({ write: async () => { throw new Error("NotAllowedError"); } });
    await expect(copyPage(pageDoc(), x)).rejects.toThrow("NotAllowedError");
  });
});

// The two places `copyPage` meets the browser. Drawing an image on a canvas (`toPng`, for the formats Google Docs
// drops) needs a real one and is left to `bun run test:ui`; what is checked here is what the code decides, not what
// the browser then does with it.
describe("what it takes from the browser", () => {
  const stub = <T,>(on: any, key: string, value: T) => {
    const had = key in on, old = on[key];
    Object.defineProperty(on, key, { value, configurable: true, writable: true });
    return () => { if (had) Object.defineProperty(on, key, { value: old, configurable: true, writable: true }); else delete on[key]; };
  };

  test("a browser that can write both formats at once is used for that", () => {
    const wrote: unknown[] = [];
    const undoClip = stub(globalThis.navigator, "clipboard", { write: async (i: unknown) => void wrote.push(i), writeText: async () => {} });
    const undoItem = stub(globalThis, "ClipboardItem", class { constructor(public items: unknown) {} });
    try {
      const io = browserCopyIO();
      expect(io.write).not.toBeNull();
      expect(io.document).toBe(document);
    } finally { undoItem(); undoClip(); }
  });

  test("a browser that can't write HTML gets no `write`, so the markdown goes as plain text instead", () => {
    // `copyPage` reads `write === null` as "text only"; the tests above cover what it then does.
    const undoClip = stub(globalThis.navigator, "clipboard", { writeText: async () => {} });
    const undoItem = stub(globalThis, "ClipboardItem", undefined);
    try {
      expect(browserCopyIO().write).toBeNull();
    } finally { undoItem(); undoClip(); }
  });

  test("an image the server won't give back is skipped rather than failing the copy", async () => {
    const undo = stub(globalThis, "fetch", async () => new Response("nope", { status: 404 }));
    try {
      expect(await loadImage("/api/assets/images/pg/gone.png")).toBeNull();
    } finally { undo(); }
  });

  test("an image of a kind Google Docs keeps is passed through as it is, not redrawn", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const undo = stub(globalThis, "fetch", async () => new Response(png, { status: 200, headers: { "Content-Type": "image/png" } }));
    try {
      const got = await loadImage("/api/assets/images/pg/a.png");
      // A `data:` URI of the bytes themselves: no canvas, so nothing about the image is changed.
      expect(got).toMatch(/^data:image\/png;base64,/);
    } finally { undo(); }
  });
});
