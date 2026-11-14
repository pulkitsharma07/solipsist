// Hand-written HTML comments in the markdown are kept as real comments, byte for byte, and shown as chips.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TextSelection } from "@tiptap/pm/state";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { commentPreview, diffBodies, docText, docToMarkdown, markdownToDoc, markersIn } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const once = (md: string) => docToMarkdown(markdownToDoc(md));
const comments = (md: string) => {
  const out: { type: string; raw: string }[] = [];
  markdownToDoc(md).descendants((n) => { if (n.type.name.startsWith("htmlComment")) out.push({ type: n.type.name, raw: n.attrs.raw }); });
  return out;
};

describe("the markdown", () => {
  const PAGES = {
    "between paragraphs": "Above.\n\n<!-- a note to self -->\n\nBelow.",
    "multi-line": "Above.\n\n<!--\nline one\n# not a heading\nline two\n-->\n\nBelow.",
    "inline": "Some <!-- hidden --> words, and <!-- two --> of them.",
    "only a comment": "<!-- just a note -->",
    "a fake comments block in the middle": "Above.\n\n<!-- solip-comments\n{}\n-->\n\nBelow.",
    "in a list item and a quote": "- an item <!-- why -->\n- <!-- only this -->\n\n> quoted <!-- aside -->",
    "in a table cell": "| A | B |\n| --- | --- |\n| x <!-- c --> | y |",
    "with markdown inside": "Text <!-- **not bold** and `not code` and <b>tags</b> -->.",
  };
  for (const [name, md] of Object.entries(PAGES)) {
    test(`comes back byte for byte: ${name}`, () => {
      expect(once(md)).toBe(md);
      expect(comments(md).length).toBeGreaterThan(0);
    });
  }

  test("one on its own line(s) at the top of the page is a block; anywhere else it is inline", () => {
    expect(comments(PAGES["between paragraphs"]).map((c) => c.type)).toEqual(["htmlComment"]);
    expect(comments(PAGES["in a list item and a quote"]).map((c) => c.type)).toEqual(["htmlCommentInline", "htmlCommentInline", "htmlCommentInline"]);
  });

  test("in code it is code text", () => {
    for (const md of ["```\n<!-- in code -->\n```", "Use `<!-- x -->` here."]) {
      expect(comments(md)).toEqual([]);
      expect(once(md)).toBe(md);
    }
  });

  test("a comment next to a sel range, or inside it, leaves the range paired", () => {
    for (const md of ["A <!-- note --><!-- sel:abc -->task<!-- /sel:abc --> b", "A <!-- sel:abc -->the <!-- note --> task<!-- /sel:abc --> b"]) {
      expect(new Set(markersIn(markdownToDoc(md)).map((p) => `${p.taskType}:${p.id}`))).toEqual(new Set(["sel:abc"]));
      expect(once(md)).toBe(md);
    }
  });

  test("in the page text it is one space: the model never quotes it, and anchors around it line up", () => {
    expect(docText(markdownToDoc("Hello <!-- x --> world")).text).toBe("Hello   world");
    expect(docText(markdownToDoc("Above.\n\n<!-- x -->\n\nBelow.")).text).toBe("Above.\nBelow.");
  });

  test("the review pane shows its raw text", () => {
    const [change] = diffBodies("Above.", "Above.\n\n<!-- TODO: ask legal -->");
    expect(change).toMatchObject({ kind: "added" });
    const [edit] = diffBodies("A <!-- old --> b", "A <!-- new --> b");
    expect(JSON.stringify(edit)).toContain("<!--");
    expect(JSON.stringify(edit)).toContain("new");
  });

  test("what the chip shows: the first words", () => {
    expect(commentPreview("<!-- a note to self -->")).toBe("a note to self");
    expect(commentPreview("<!--\n  one two three four five six seven\n-->")).toBe("one two three four five six…");
    expect(commentPreview("<!---->")).toBe("comment");
  });
});

describe("the page", () => {
  const PAGE = "# Plan\n\nThe launch slipped to the end of Q3 again.\n\nSecond paragraph.";

  test("a hand edit adds a comment; the writer types elsewhere and saves: the comment is in the file, unchanged", async () => {
    const server = new Server(PAGE);
    const tab = new Tab(server.src);
    await tab.save(server);
    server.handEdit((md) => md.replace("Second", "<!-- keep me -->\n\nSecond").replace("again.", "again <!-- inline, too -->."));
    tab.receive(server.src);
    tab.typeAfter("Second paragraph.", " Typed.");
    await tab.save(server);
    expect(server.markdown).toBe("# Plan\n\nThe launch slipped to the end of Q3 again <!-- inline, too -->.\n\n<!-- keep me -->\n\nSecond paragraph. Typed.");
  });

  test("comments around a highlight don't move it, and a fresh load shows the same highlight", async () => {
    const server = new Server("The launch <!-- a --> slipped to the end of Q3 <!-- b --> again.");
    const tab = new Tab(server.src);
    await tab.save(server);
    const { placed: [id] } = server.job(server.markdown, [{ quote: "slipped to the end of Q3" }]);
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("slipped to the end of Q3");
    expect(new Tab(server.src).highlighted(id!)).toBe("slipped to the end of Q3");
  });

  test("shown as a chip with its first words, and the whole comment as the tooltip", () => {
    const tab = new Tab(new Server("Text <!-- a note to self --> here.\n\n<!-- a block note -->\n\nEnd.").src);
    const chips = [...tab.editor.view.dom.querySelectorAll<HTMLElement>(".html-comment")];
    expect(chips.map((c) => c.textContent)).toEqual(["a note to self", "a block note"]);
    expect(chips.map((c) => c.title)).toEqual(["<!-- a note to self -->", "<!-- a block note -->"]);
    expect(chips.every((c) => c.contentEditable === "false")).toBe(true);
  });

  test("a page that starts with a comment: the caret starts in text, so the first key can't replace it", async () => {
    const server = new Server("<!-- draft, do not share -->\n\nFirst line.");
    const tab = new Tab(server.src);
    tab.typeAtCaret("x");
    await tab.save(server);
    expect(server.markdown).toBe("<!-- draft, do not share -->\n\nxFirst line.");
  });

  test("Backspace after a block comment removes it, and Undo brings it back", async () => {
    const server = new Server("Above.\n\n<!-- note -->\n\nBelow.");
    const tab = new Tab(server.src);
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find("Below.").from)));
    tab.editor.commands.joinBackward();
    expect(tab.markdown).toBe("Above.\n\nBelow.");
    tab.undo();
    expect(tab.markdown).toBe("Above.\n\n<!-- note -->\n\nBelow.");
  });

  test("an inline comment cut and pasted keeps its raw text; a copy makes a second identical one", () => {
    const tab = new Tab(new Server("One <!-- n --> two.\n\nThree.").src);
    tab.copyPaste("One   two.", "Three.");
    expect(tab.markdown).toBe("One <!-- n --> two.\n\nThree.One <!-- n --> two.");
    const cut = new Tab(new Server("One <!-- n --> two.\n\nThree.").src);
    cut.cutPaste("One   two.", "Three.");
    expect(cut.markdown).toBe("\n\nThree.One <!-- n --> two."); // the emptied first paragraph stays, as after any cut
  });

  test("typed as text it is text, after a save and a reload too", async () => {
    const server = new Server("Plain.");
    const tab = new Tab(server.src);
    tab.typeAfter("Plain.", " <!-- typed -->");
    await tab.save(server);
    expect(comments(server.markdown)).toEqual([]);
    expect(docText(new Tab(server.src).doc).text).toContain("<!-- typed -->");
  });
});
