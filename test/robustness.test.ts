// Edge cases of typical markdown editing, played black-box against the engine: round trips of awkward markdown, and
// the real `DocSession` (`test/browser-tab.ts`) editing code, tables, headings, images and HTML comments while the
// server, a second tab or a hand edit change the same page.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { setBlockType, wrapIn } from "@tiptap/pm/commands";
import { addRowAfter } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
import { Slice } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { afterAll, beforeAll, describe as group, expect, test } from "bun:test";
import { docText, docToMarkdown, emptyBlock, markdownToDoc, parseFile, schema, serializeFile } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const textOf = (md: string) => docText(markdownToDoc(md)).text;
const once = (md: string) => docToMarkdown(markdownToDoc(md));
const blocksIn = (src: string) => src.match(/<!-- solip-comments/g)?.length ?? 0;

/** A small deterministic random number generator, so a failing run can be replayed from its seed. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- markdown that a writer or a hand edit typically produces ----
const FIXTURES: Record<string, string> = {
  "fenced code with a language": "Intro.\n\n```python\ndef f(x):\n    return x * 2\n```\n\nOutro.",
  "tilde fence": "Intro.\n\n~~~\nplain fenced\n~~~\n\nOutro.",
  "code holding backticks": "Intro.\n\n````md\n```js\nnested();\n```\n````\n\nOutro.",
  "code with blank lines inside": "```\nfirst\n\n\nafter two blanks\n```",
  "code holding a table, a heading and a list": "```\n| a | b |\n| - | - |\n# not a heading\n- not a list\n```",
  "code holding HTML comments": "```html\n<!-- a comment in code -->\n<!-- gen:abc -->\n<!-- solip-comments {} -->\n```",
  "empty code block": "Before.\n\n```\n```\n\nAfter.",
  "inline code with backticks": "Use `` a`b `` and `x` here.",
  "all heading levels": "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six",
  "heading with inline code and emphasis": "## The `deploy` step is *really* **important**",
  "setext headings": "Title\n=====\n\nSub\n---\n\nBody.",
  "table with alignment and empty cells": "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a |  | c |\n|  | b |  |",
  "table with formatting in cells": "| Name | Notes |\n| --- | --- |\n| **Bold** | `code` and *it* |\n| [link](https://x.y) | plain |",
  "table with an escaped pipe": "| Expr | Meaning |\n| --- | --- |\n| `a \\| b` | a or b |",
  "single-column table": "| Only |\n| --- |\n| one |\n| two |",
  "table with an image in a cell": "| Pic | Caption |\n| --- | --- |\n| ![logo](/img/logo.png) | The logo |",
  "image with a title": '![alt text](/a.png "A title")',
  "two images side by side": "![one](/1.png) ![two](/2.png)",
  "image inside a link": "[![badge](/badge.svg)](https://example.com)",
  "image in a list item": "- first\n- ![pic](/p.png)\n- third",
  "image between paragraphs": "Above.\n\n![solo](/solo.png)\n\nBelow.",
  "HTML comment between paragraphs": "Above.\n\n<!-- a note to self -->\n\nBelow.",
  "multi-line HTML comment": "Above.\n\n<!--\nline one\nline two\n-->\n\nBelow.",
  "HTML comment inline": "Some <!-- hidden --> words.",
  "a fake comments block in the middle": "Above.\n\n<!-- solip-comments\n{}\n-->\n\nBelow.",
  "a gen marker and near misses": "A <!-- gen:ab1 --> b <!-- gen:AB1 --> c <!-- gen:abcd --> d <!--gen:abc-->",
  "inline HTML tags": "Line<br>break and <kbd>Ctrl</kbd> and <sup>2</sup>.",
  "a details block": "<details>\n<summary>More</summary>\n\nHidden text.\n\n</details>",
  "nested lists": "- a\n  - b\n    - c\n- d\n\n1. one\n2. two\n   1. two-a",
  "blockquote with a list and code": "> Quote\n>\n> - item\n>\n> ```\n> code\n> ```",
  "horizontal rules": "Above.\n\n---\n\nMiddle.\n\n***\n\nBelow.",
  "hard breaks": "Two spaces  \nthen a backslash\\\nthen end.",
  "unicode and emoji": "Ünïcödé — “quotes” and 🎉 emoji, 中文, עברית.",
  "markdown characters as text": "1\\. not a list, \\*not em\\*, \\# not heading, a_b_c, 2 * 3 * 4",
  "CRLF line endings": "# Title\r\n\r\nFirst paragraph.\r\n\r\n- item\r\n",
  "trailing whitespace and many blank lines": "Para one.   \n\n\n\n\nPara two.\n\n\n",
  "a very long paragraph": `${"word ".repeat(2000).trim()}.`,
};

group("markdown round trips: awkward but typical pages", () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    test(`${name}: stable after the first save`, () => {
      const first = once(md);
      expect(once(first)).toBe(first);
    });
    test(`${name}: no text lost in the first save`, () => {
      // Blank lines at the very end are dropped, as the file drops them; they are no text.
      expect(textOf(once(md)).replace(/\n+$/, "")).toBe(textOf(md).replace(/\n+$/, ""));
    });
    test(`${name}: inside a file, the comments block still parses and the body comes back byte for byte`, () => {
      const body = once(md);
      const src = serializeFile(body, emptyBlock());
      const back = parseFile(src);
      expect(back.problem).toBeUndefined();
      expect(back.markdown).toBe(body);
      expect(blocksIn(src)).toBe(1 + blocksIn(body));
    });
  }

  test("code keeps its exact content, indentation and language", () => {
    const md = once(FIXTURES["fenced code with a language"]!);
    expect(md).toContain("```python\ndef f(x):\n    return x * 2\n```");
  });

  test("HTML comments in code stay verbatim, and a gen marker there is not a marker", () => {
    const md = once(FIXTURES["code holding HTML comments"]!);
    expect(md).toContain("<!-- a comment in code -->");
    expect(md).toContain("<!-- gen:abc -->");
    let markers = 0;
    markdownToDoc(md).descendants((n) => { if (n.type.name === "markerPoint") markers++; });
    expect(markers).toBe(0);
  });

  test("images keep src and alt, everywhere they can be", () => {
    for (const name of ["image with a title", "two images side by side", "image in a list item", "image between paragraphs", "table with an image in a cell"]) {
      const srcs: string[] = [];
      markdownToDoc(once(FIXTURES[name]!)).descendants((n) => { if (n.type.name === "image") srcs.push(`${n.attrs.alt}|${n.attrs.src}`); });
      const before: string[] = [];
      markdownToDoc(FIXTURES[name]!).descendants((n) => { if (n.type.name === "image") before.push(`${n.attrs.alt}|${n.attrs.src}`); });
      expect(srcs).toEqual(before);
      expect(srcs.length).toBeGreaterThan(0);
    }
  });

  test("an HTML comment's words are never dropped from the page", () => {
    for (const name of ["HTML comment between paragraphs", "multi-line HTML comment", "HTML comment inline"]) {
      const words = { "HTML comment between paragraphs": "a note to self", "multi-line HTML comment": "line two", "HTML comment inline": "hidden" }[name]!;
      expect(once(FIXTURES[name]!)).toContain(words);
    }
  });

  // Text the writer typed that looks like markdown syntax at the start of a line must come back as that same text.
  for (const typed of ["# not a heading", "###### six", "> not a quote", "- not a list", "+ plus", "1. not numbered", "2026) a year",
    "---", "===", "-", "   # indented hash", "#hashtag stays", "-5 degrees", "1.5 litres"]) {
    test(`typed at the start of a paragraph or after a line break: ${JSON.stringify(typed)}`, () => {
      for (const content of [
        [{ type: "text", text: typed }],
        [{ type: "text", text: "First line" }, { type: "hardBreak" }, { type: "text", text: typed }],
      ]) {
        const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content }] });
        const back = markdownToDoc(docToMarkdown(doc));
        expect(back.childCount).toBe(1);
        expect(back.firstChild!.type.name).toBe("paragraph");
        // Spaces at the start of a line are indentation, not text (CommonMark, and `trimLineIndents`): they may go.
        // Every other character must survive.
        const typedText = content.map((n) => n.text ?? "").join("");
        expect([typedText, content.map((n) => (n.text ?? "").replace(/^ +/, "")).join("")]).toContain(back.firstChild!.textContent);
      }
    });
  }

  test("an image's alt with brackets, a src with spaces and parentheses, and a title with quotes come back unchanged", () => {
    const attrs = { src: "/img/my file (1).png?v=2&x=ü", alt: "odd [alt] here", title: 'say "hi"' };
    const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "image", attrs }] }] });
    let got: Record<string, unknown> | null = null;
    markdownToDoc(docToMarkdown(doc)).descendants((n) => { if (n.type.name === "image") got = n.attrs; });
    expect(got).toMatchObject(attrs);
  });

  test("a table cell edit changes only its own row's line", () => {
    const md = once("| A | B |\n| --- | --- |\n| short | x |\n| y | z |");
    const edited = once(md.replace("short", "a much longer cell than before"));
    const changed = md.split("\n").filter((l, i) => l !== edited.split("\n")[i]);
    expect(changed).toEqual(["| short | x |"]);
  });

  test("a fake comments block in the body never becomes the file's block", () => {
    const body = once(FIXTURES["a fake comments block in the middle"]!);
    const src = serializeFile(body, emptyBlock());
    expect(parseFile(src).markdown).toBe(body);
    expect(parseFile(src).block).toEqual(emptyBlock());
  });

  test("a table keeps every row and cell", () => {
    const md = once(FIXTURES["table with alignment and empty cells"]!);
    const doc = markdownToDoc(md);
    let rows = 0, cells = 0;
    doc.descendants((n) => { if (n.type.name === "tableRow") rows++; if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells++; });
    expect(rows).toBe(3);
    expect(cells).toBe(9);
  });
});

// ---- the session: a page with every kind of block ----
const PAGE = `# Launch checklist for the spring release

The launch is planned for the second week of March.

## Code

\`\`\`ts
export function launch(date: string) {
  return schedule(date, "march");
}
\`\`\`

## Owners

| Area | Owner | Status |
| --- | --- | --- |
| Backend | Priya | waiting on the security review |
| Frontend | Sam | ready for the design sign-off |

![architecture diagram](/img/arch.png)

The diagram above shows the request path end to end.

## Notes

Marketing needs two weeks of lead time for the announcement.

Support wants the runbook finished before anything ships.`;

async function setup(page = PAGE) {
  const server = new Server(page);
  const tab = new Tab(server.src);
  await tab.save(server);
  const job = (...quotes: string[]) => server.job(server.markdown, quotes.map((quote) => ({ quote })));
  return { server, tab, job };
}

/** Everything the writer sees must be what the file says, and a fresh load must show the same highlights. */
async function settled(tab: Tab, server: Server) {
  await tab.save(server);
  expect(tab.markdown).toBe(server.markdown);
  expect(blocksIn(server.src)).toBe(1);
  expect(parseFile(server.src).problem).toBeUndefined();
  const fresh = new Tab(server.src);
  // Whitespace at the edge of a block can't be written to markdown either.
  const trimmed = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([id, t]) => [id, t.trim()]));
  expect(trimmed(fresh.highlights)).toEqual(trimmed(tab.highlights));
  for (const [id, text] of Object.entries(fresh.highlights)) if (!text.includes("[img:")) expect(server.comment(id).anchor.exact.trim()).toBe(text);
  return fresh;
}

/** The top-level blocks from the one holding `first` to the one holding `last`. */
function blockRange(tab: Tab, first: string, last = first) {
  const from = tab.doc.resolve(tab.find(first).from).before(1);
  const to = tab.doc.resolve(tab.find(last).to).after(1);
  return { from, to };
}
const pasteSlice = (tab: Tab, slice: Slice, doc: Tab["doc"]) =>
  tab.editor.view.someProp("transformPasted", (f) => f(slice, tab.editor.view, false)) ?? slice;
/** Copy (or cut) whole blocks and paste them after the block holding `target`, as a drag or Cmd+X/Cmd+V would. */
function moveBlocks(tab: Tab, first: string, last: string, target: string, cut = true) {
  const { from, to } = blockRange(tab, first, last);
  const slice = tab.doc.slice(from, to);
  if (cut) tab.dispatch(closeHistory(tab.state.tr.delete(from, to)));
  const at = tab.doc.resolve(tab.find(target).to).after(1);
  tab.dispatch(closeHistory(tab.state.tr.replace(at, at, pasteSlice(tab, slice, tab.doc))));
}
/** Paste a slice of markdown as the writer would paste it from elsewhere, at the end of the block holding `target`. */
function pasteMarkdown(tab: Tab, md: string, target: string) {
  const parsed = tab.editor.schema.nodeFromJSON(markdownToDoc(md).toJSON());
  const slice = new Slice(parsed.content, 0, 0);
  const at = tab.doc.resolve(tab.find(target).to).after(1);
  tab.dispatch(closeHistory(tab.state.tr.replace(at, at, pasteSlice(tab, slice, tab.doc))));
}

group("code blocks", () => {
  test("Enter and typing inside a commented code block: the comment follows, the file and a reload agree", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job('return schedule(date, "march");');
    tab.receive(server.src);
    tab.typeAfter("launch(date: string) {", "\n  log(date);");
    expect(tab.highlighted(id!)).toBe('return schedule(date, "march");');
    await settled(tab, server);
    expect(server.markdown).toContain('  log(date);\n  return schedule(date, "march");');
  });

  test("markdown typed into a code block stays code, and nothing outside it changes", async () => {
    const { server, tab } = await setup();
    tab.typeAfter('"march");', "\n  // # heading? | a | b | **bold** <!-- gen:xyz --> ![x](/y.png)");
    await settled(tab, server);
    expect(server.markdown).toContain("  // # heading? | a | b | **bold** <!-- gen:xyz --> ![x](/y.png)\n}");
    let markers = 0, images = 0;
    markdownToDoc(server.markdown).descendants((n) => { if (n.type.name === "markerPoint") markers++; if (n.type.name === "image") images++; });
    expect(markers).toBe(0);
    expect(images).toBe(1);
  });

  test("a code fence typed inside a code block can't end the block", async () => {
    const { server, tab } = await setup();
    tab.typeAfter('"march");', "\n```\nafter the fence");
    const fresh = await settled(tab, server);
    expect(fresh.markdown).toBe(tab.markdown);
    let code = "";
    fresh.doc.descendants((n) => { if (n.type.name === "codeBlock") code = n.textContent; });
    expect(code).toContain("```\nafter the fence");
  });

  test("a hand edit inside the code block while the writer types in a paragraph: merged", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("second week of March.", " Probably.");
    server.handEdit((md) => md.replace('return schedule(date, "march");', 'return schedule(date, "april");'));
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toContain('"april"');
    expect(tab.markdown).toContain("Probably.");
    await settled(tab, server);
  });

  test("the writer and a hand edit change the same code line: conflict, the writer's typing kept", async () => {
    const { server, tab } = await setup();
    tab.replace('"march"', '"may"');
    server.handEdit((md) => md.replace('"march"', '"june"'));
    tab.receive(server.src);
    expect(tab.conflict).toBe(true);
    expect(tab.markdown).toContain('"may"');
  });

  test("deleting the code block orphans a comment in it; Undo brings it back", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job('return schedule(date, "march");');
    tab.receive(server.src);
    tab.removeNodeAround("return schedule", "codeBlock");
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
    tab.undo();
    await settled(tab, server);
    expect(server.comment(id!).status).toBe("open");
  });
});

group("tables", () => {
  test("typing in a cell while a hand edit adds a row: merged, both kept", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("ready for the design sign-off", " (Friday)");
    server.handEdit((md) => md.replace(/^\| Frontend /m, "| Mobile | Lee | not started |\n| Frontend "));
    const outcome = tab.receive(server.src);
    expect(["merged"]).toContain(outcome);
    expect(tab.markdown).toContain("(Friday)");
    expect(tab.markdown).toMatch(/\| Mobile +\| Lee +\| not started +\|/);
    await settled(tab, server);
  });

  test("a hand edit to another cell of the row the writer types in: merged, both kept", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("waiting on the security review", " and legal");
    server.handEdit((md) => md.replace(/\| Priya +\|/, "| Ana   |"));
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toContain("| Ana | waiting on the security review and legal |");
  });

  test("a hand edit to the cell the writer types in: conflict, typing kept", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("waiting on the security review", " and legal");
    server.handEdit((md) => md.replace("waiting on the security review", "blocked"));
    tab.receive(server.src);
    expect(tab.conflict).toBe(true);
    expect(tab.markdown).toContain("and legal");
  });

  test("a row added under a commented row with the table command: comment stays, file and reload agree", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("waiting on the security review");
    tab.receive(server.src);
    tab.command("waiting on the security review", addRowAfter);
    tab.command("waiting on the security review", addRowAfter);
    expect(tab.highlighted(id!)).toBe("waiting on the security review");
    await settled(tab, server);
  });

  test("a comment in a header cell and one in a body cell; the table is moved below the notes", async () => {
    const { server, tab, job } = await setup();
    const { placed } = job("ready for the design sign-off", "waiting on the security review");
    tab.receive(server.src);
    moveBlocks(tab, "Area", "ready for the design sign-off", "anything ships.");
    expect(Object.values(tab.highlights).sort()).toEqual(["ready for the design sign-off", "waiting on the security review"]);
    await settled(tab, server);
    expect(placed.every((id) => server.comment(id).status === "open")).toBe(true);
    expect(server.markdown.trimEnd()).toMatch(/\| Frontend +\| Sam +\| ready for the design sign-off +\|$/);
  });

  test("a whole table pasted from elsewhere: valid markdown, cells kept, stable on reload", async () => {
    const { server, tab } = await setup();
    pasteMarkdown(tab, "| K | V |\n| --- | --- |\n| one | 1 |\n| two | 2 |", "anything ships.");
    const fresh = await settled(tab, server);
    expect(fresh.markdown).toBe(server.markdown);
    expect(server.markdown).toMatch(/\| two +\| 2 +\|/);
  });

  test("a pipe typed into a cell doesn't split the cell", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("Priya", " | Ana");
    const fresh = await settled(tab, server);
    let cells = 0;
    fresh.doc.descendants((n) => { if (n.type.name === "tableCell" || n.type.name === "tableHeader") cells++; });
    expect(cells).toBe(9);
    expect(fresh.find("Priya | Ana")).toBeDefined();
  });
});

group("headings", () => {
  test("a commented paragraph turned into a heading, and back: comment kept", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    tab.command("Marketing needs", setBlockType(tab.editor.schema.nodes.heading!, { level: 3 }));
    expect(tab.highlighted(id!)).toBe("two weeks of lead time");
    await settled(tab, server);
    expect(server.markdown).toContain("### Marketing needs two weeks");
    tab.command("Marketing needs", setBlockType(tab.editor.schema.nodes.paragraph!));
    await settled(tab, server);
    expect(server.comment(id!).status).toBe("open");
  });

  test("a comment on a heading's text survives a hand edit changing its level", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("Launch checklist for the spring release");
    tab.receive(server.src);
    server.handEdit((md) => md.replace("# Launch checklist", "## Launch checklist"));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(tab.highlighted(id!)).toBe("Launch checklist for the spring release");
  });

  test("a '#' typed at the start of a paragraph is text, not a heading, after a save and reload", async () => {
    const { server, tab } = await setup();
    tab.typeBefore("Support wants", "# ");
    const fresh = await settled(tab, server);
    let headings = 0;
    fresh.doc.descendants((n) => { if (n.type.name === "heading") headings++; });
    expect(headings).toBe(4);
    expect(docText(fresh.doc).text).toContain("# Support wants");
  });

  test("a section (heading and its paragraphs) wrapped in a blockquote keeps its comments", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("finished before anything ships");
    tab.receive(server.src);
    tab.command("Support wants", wrapIn(tab.editor.schema.nodes.blockquote!));
    expect(tab.highlighted(id!)).toBe("finished before anything ships");
    await settled(tab, server);
    expect(server.markdown).toContain("> Support wants");
  });
});

group("images", () => {
  test("a commented image moved to the end of the page takes its comment", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("![architecture diagram](/img/arch.png)");
    tab.receive(server.src);
    expect(tab.allMarked(id!)).toEqual(["[img:/img/arch.png]"]);
    const at = tab.imagePos("/img/arch.png");
    const { from, to } = { from: tab.doc.resolve(at).before(1), to: tab.doc.resolve(at).after(1) };
    const slice = tab.doc.slice(from, to);
    tab.dispatch(closeHistory(tab.state.tr.delete(from, to)));
    const end = tab.doc.content.size;
    tab.dispatch(closeHistory(tab.state.tr.replace(end, end, pasteSlice(tab, slice, tab.doc))));
    expect(tab.allMarked(id!)).toEqual(["[img:/img/arch.png]"]);
    await settled(tab, server);
    expect(server.markdown.trimEnd().endsWith("![architecture diagram](/img/arch.png)")).toBe(true);
  });

  test("a hand edit adds an image while the writer types elsewhere: merged, image kept", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("second week of March.", " Tentatively.");
    server.handEdit((md) => md.replace("## Notes", "![timeline](/img/timeline.png)\n\n## Notes"));
    expect(tab.receive(server.src)).toBe("merged");
    expect(() => tab.imagePos("/img/timeline.png")).not.toThrow();
    await settled(tab, server);
    expect(server.markdown).toContain("![timeline](/img/timeline.png)");
    expect(server.markdown).toContain("Tentatively.");
  });

  test("the same image pasted three times: the comment stays on the original only", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("![architecture diagram](/img/arch.png)");
    tab.receive(server.src);
    for (const target of ["second week of March.", "lead time for the announcement.", "anything ships."]) tab.pasteImage("/img/arch.png", target);
    expect(tab.allMarked(id!)).toEqual(["[img:/img/arch.png]"]);
    const fresh = await settled(tab, server);
    expect(fresh.allMarked(id!)).toEqual(["[img:/img/arch.png]"]);
  });

  test("an image with an awkward src (spaces, query, unicode) survives editing around it", async () => {
    const { server, tab } = await setup();
    tab.insertImage("anything ships.", "/img/my file (1).png?v=2&x=ü", "odd [alt]");
    tab.typeAfter("anything ships.", " Done.");
    const fresh = await settled(tab, server);
    expect(() => fresh.imagePos("/img/my file (1).png?v=2&x=ü")).not.toThrow();
  });
});

group("HTML comments in the body", () => {
  test("an HTML comment typed into the page stays visible text, and the comments block is untouched", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    tab.typeAfter("anything ships.", " <!-- hidden? --> and <!-- solip-comments {\"comments\":{}} -->");
    const fresh = await settled(tab, server);
    expect(docText(fresh.doc).text).toContain("<!-- hidden? --> and <!-- solip-comments");
    expect(server.comment(id!).status).toBe("open");
    expect(fresh.highlighted(id!)).toBe("two weeks of lead time");
  });

  test("a closing --> typed into the page can't end the file's block", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    tab.typeAfter("anything ships.", "\n\n-->\n\n<!--");
    await settled(tab, server);
    expect(parseFile(server.src).block.comments[id!]).toBeDefined();
  });

  test("a hand edit adds an HTML comment: no text lost, no second block, and the next save is stable", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    server.handEdit((md) => md.replace("## Notes", "<!-- TODO: ask legal -->\n\n## Notes"));
    tab.receive(server.src);
    expect(tab.markdown).toContain("<!-- TODO: ask legal -->\n\n## Notes");
    const fresh = await settled(tab, server);
    expect(fresh.highlighted(id!)).toBe("two weeks of lead time");
    await settled(fresh, server);
  });

  test("a gen marker inserted by a hand edit, next to a comment, doesn't shift the comment", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    server.handEdit((md) => md.replace("Marketing needs ", "Marketing <!-- gen:q7z --> needs "));
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("two weeks of lead time");
    await settled(tab, server);
    expect(server.markdown).toContain("<!-- gen:q7z -->");
  });
});

group("copy and paste", () => {
  test("a paragraph holding two comments, copied below: both stay on the original, also after reload", async () => {
    const { server, tab, job } = await setup();
    const { placed: [a, b] } = job("Marketing needs two weeks", "lead time for the announcement");
    tab.receive(server.src);
    moveBlocks(tab, "Marketing needs", "Marketing needs", "anything ships.", false);
    expect(tab.allMarked(a!)).toEqual(["Marketing needs two weeks"]);
    expect(tab.allMarked(b!)).toEqual(["lead time for the announcement"]);
    const fresh = await settled(tab, server);
    expect(fresh.find("Marketing needs", 0).from).toBe(fresh.find("Marketing needs").from);
    expect(fresh.allMarked(a!)).toEqual(["Marketing needs two weeks"]);
  });

  test("a multi-paragraph slice pasted into the middle of a highlight: the highlight is split, not lost or spread", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("Marketing needs two weeks of lead time");
    tab.receive(server.src);
    const { to } = tab.find("Marketing needs ");
    const slice = tab.doc.slice(tab.find("The launch is").from, tab.find("end to end.").to);
    tab.dispatch(closeHistory(tab.state.tr.replace(to, to, pasteSlice(tab, slice, tab.doc))));
    const marked = tab.allMarked(id!).join("");
    expect(marked.length).toBeGreaterThan(0);
    expect(marked).not.toContain("The launch is");
    expect(marked).not.toContain("end to end");
    await settled(tab, server);
  });

  test("pasting a code block, a table and an image at once: valid file, stable reload", async () => {
    const { server, tab } = await setup();
    pasteMarkdown(tab, "```sh\necho hi\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![pasted](/p.png)\n\nTrailing paragraph.", "second week of March.");
    const fresh = await settled(tab, server);
    expect(fresh.markdown).toBe(server.markdown);
    for (const s of ["```sh\necho hi\n```", "![pasted](/p.png)", "Trailing paragraph."]) expect(server.markdown).toContain(s);
    expect(server.markdown).toMatch(/\| 1 +\| 2 +\|/);
  });

  test("pasting the same paragraph many times, then deleting the original, orphans its comment", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("finished before anything ships");
    tab.receive(server.src);
    for (let i = 0; i < 5; i++) moveBlocks(tab, "Support wants", "Support wants", "second week of March.", false);
    // The last "Support wants" paragraph is the original (the pasted copies are above it).
    const { from, to } = blockRange(tab, "Support wants the runbook");
    const last = tab.doc.resolve(tab.find("Support wants the runbook", 5).from);
    expect(last.before(1)).toBeGreaterThan(from);
    tab.dispatch(closeHistory(tab.state.tr.delete(last.before(1), last.after(1))));
    expect(to).toBeGreaterThan(0);
    expect(tab.highlighted(id!)).toBeNull();
    await tab.save(server);
    expect(server.comment(id!).status).toBe("orphaned");
  });

  test("cut and paste back to the same spot: nothing changes, comment kept", async () => {
    const { server, tab, job } = await setup();
    const { placed: [id] } = job("two weeks of lead time");
    tab.receive(server.src);
    const before = tab.markdown;
    moveBlocks(tab, "Marketing needs", "Marketing needs", "Notes");
    expect(tab.markdown).toBe(before);
    expect(tab.highlighted(id!)).toBe("two weeks of lead time");
    await settled(tab, server);
  });
});

group("moving large blocks apart", () => {
  test("a whole section with a code block and comments moved to the end: comments travel, reload agrees", async () => {
    const { server, tab, job } = await setup();
    const { placed } = job('return schedule(date, "march");', "second week of March");
    tab.receive(server.src);
    moveBlocks(tab, "Code", "}", "anything ships.");
    expect(Object.values(tab.highlights).sort()).toEqual(['return schedule(date, "march");', "second week of March"].sort());
    await settled(tab, server);
    expect(placed.every((id) => server.comment(id).status === "open")).toBe(true);
    expect(server.markdown.indexOf("## Code")).toBeGreaterThan(server.markdown.indexOf("## Notes"));
  });

  test("two sections swapped, then Undo twice: back to the start, comments open", async () => {
    const { server, tab, job } = await setup();
    const { placed } = job("waiting on the security review", "two weeks of lead time");
    tab.receive(server.src);
    const original = tab.markdown;
    moveBlocks(tab, "Owners", "end to end.", "anything ships.");
    moveBlocks(tab, "Notes", "anything ships.", "second week of March.");
    await settled(tab, server);
    for (let i = 0; i < 4; i++) tab.undo(); // each move is a cut and a paste
    expect(tab.markdown).toBe(original);
    await settled(tab, server);
    expect(placed.every((id) => server.comment(id).status === "open")).toBe(true);
  });

  test("blocks between two comments moved away: each comment's context changes, both are still found on a fresh load", async () => {
    const { server, tab, job } = await setup();
    const { placed: [a, b] } = job("second week of March", "two weeks of lead time");
    tab.receive(server.src);
    moveBlocks(tab, "Code", "end to end.", "anything ships.");
    const fresh = await settled(tab, server);
    expect(fresh.highlighted(a!)).toBe("second week of March");
    expect(fresh.highlighted(b!)).toBe("two weeks of lead time");
  });

  test("a hand edit that reorders sections, tab clean: reloaded, comments re-found, none on the wrong text", async () => {
    const { server, tab, job } = await setup();
    const { placed } = job("waiting on the security review", "two weeks of lead time", "second week of March");
    tab.receive(server.src);
    server.handEdit((md) => {
      const [head, ...sections] = md.split("\n## ");
      return [head, ...sections.reverse()].join("\n## ");
    });
    expect(tab.receive(server.src)).toBe("reloaded");
    for (const id of placed) {
      const h = tab.highlighted(id);
      if (h !== null) expect(h).toBe(server.comment(id).anchor.exact);
    }
    await settled(tab, server);
  });

  test("a hand edit that moves a section while the writer types elsewhere: no text lost either way", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("second week of March.", " Typed meanwhile.");
    server.handEdit((md) => {
      const notes = md.slice(md.indexOf("## Notes"));
      return md.replace(notes, "").trimEnd().replace("## Code", `${notes}\n\n## Code`);
    });
    const outcome = tab.receive(server.src);
    expect(tab.markdown).toContain("Typed meanwhile.");
    if (outcome === "merged") {
      expect(tab.markdown.indexOf("## Notes")).toBeLessThan(tab.markdown.indexOf("## Code"));
      expect(tab.markdown.match(/Support wants/g)!.length).toBe(1);
      await settled(tab, server);
    } else {
      expect(tab.conflict).toBe(true);
    }
  });

  test("a big pasted block (200 paragraphs) above every comment: anchors and reload hold", async () => {
    const { server, tab, job } = await setup();
    job("waiting on the security review", "two weeks of lead time");
    tab.receive(server.src);
    pasteMarkdown(tab, Array.from({ length: 200 }, (_, i) => `Filler paragraph number ${i} with some words.`).join("\n\n"), "Launch checklist");
    await settled(tab, server);
  });
});

group("simultaneous editing", () => {
  test("two tabs edit different blocks: the second merges the first's file, then both saves are in the file", async () => {
    const { server, tab: a } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("second week of March.", " From A.");
    b.typeAfter("anything ships.", " From B.");
    await a.save(server);
    expect(b.receive(server.src)).toBe("merged");
    await b.save(server);
    expect(server.markdown).toContain("From A.");
    expect(server.markdown).toContain("From B.");
    expect(a.receive(server.src)).toBe("reloaded");
    expect(a.markdown).toBe(server.markdown);
  });

  test("two tabs edit different cells of the same row: merged, both in the file", async () => {
    const { server, tab: a } = await setup();
    const b = new Tab(server.src);
    a.typeAfter("Priya", " and Ana");
    b.typeAfter("waiting on the security review", " (week 2)");
    await a.save(server);
    expect(b.receive(server.src)).toBe("merged");
    await b.save(server);
    expect(server.markdown).toContain("| Priya and Ana | waiting on the security review (week 2) |");
  });

  test("a job comment, a hand edit and typing all at once: each lands, nothing lost", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("anything ships.", " Writer.");
    const read = server.markdown;
    server.handEdit((md) => md.replace("# Launch checklist", "# Launch checklist (v2)"));
    const { placed: [id] } = server.job(read, [{ quote: "two weeks of lead time" }]);
    expect(tab.receive(server.src)).toBe("merged");
    tab.pause();
    expect(tab.highlighted(id!)).toBe("two weeks of lead time");
    await settled(tab, server);
    expect(server.markdown).toContain("(v2)");
    expect(server.markdown).toContain("Writer.");
  });

  test("a save in flight while a hand edit lands: the save is refused, the merge keeps both", async () => {
    const { server, tab } = await setup();
    tab.typeAfter("anything ships.", " In flight.");
    const req = tab.makePut();
    server.handEdit((md) => md.replace("## Owners", "## Owners and dates"));
    const r = server.put(req);
    tab.onPutResult(r);
    if (!r.ok) {
      tab.receive(server.src);
      expect(tab.conflict).toBe(false);
    }
    await settled(tab, server);
    expect(server.markdown).toContain("In flight.");
    expect(server.markdown).toContain("## Owners and dates");
  });

  // Random interleavings of writer edits (typing, pasting, moving, table rows, headings) with hand edits to other
  // blocks, the job's comments and saves. Invariants: no text is lost, the file stays valid, a reload agrees.
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    test(`random editing across every block type, with outside edits (seed ${seed})`, async () => {
      const rand = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
      const { server, tab } = await setup();
      const mine: string[] = []; // sentences the writer added; must all be in the file at the end
      const theirs: string[] = []; // sentences the hand edits added at the end of the page
      let n = 0;

      for (let step = 0; step < 80; step++) {
        const r = rand();
        if (tab.conflict) { await tab.keepMine(server); theirs.length = 0; }
        if (r < 0.3) {
          const s = ` W${n++}.`;
          tab.typeAfter(pick(["second week of March.", "end to end.", "lead time for the announcement.", "Priya", '"march");']), s);
          mine.push(s.trim());
        } else if (r < 0.4) {
          tab.paragraphBefore(pick(["Marketing needs", "The diagram above", "The launch is"]), `P${n++} added by the writer.`);
          mine.push(`P${n - 1} added by the writer.`);
        } else if (r < 0.47) {
          moveBlocks(tab, "Marketing needs", "Marketing needs", pick(["second week of March.", "end to end.", "anything ships."]));
        } else if (r < 0.52) {
          tab.command("Priya", addRowAfter);
        } else if (r < 0.62) {
          await tab.save(server);
        } else if (r < 0.75) {
          const s = `Hand note ${n++}.`;
          server.handEdit((md) => `${md}\n\n${s}`);
          theirs.push(s);
          tab.receive(server.src);
        } else if (r < 0.85) {
          const q = pick(["security review", "design sign-off", "runbook finished", "request path end to end", "schedule(date"]);
          server.job(server.markdown, [{ quote: q }]);
          tab.receive(server.src);
          tab.pause();
        } else {
          tab.pause();
        }
        expect(blocksIn(server.src)).toBe(1);
        for (const [id, text] of Object.entries(tab.highlights)) expect(text.length).toBeGreaterThan(0), expect(id).toBeTruthy();
      }
      if (tab.conflict) { await tab.keepMine(server); theirs.length = 0; }
      await settled(tab, server);
      for (const s of mine) expect(server.markdown).toContain(s);
      for (const s of theirs) expect(server.markdown).toContain(s);
      for (const s of ["second week of March.", "end to end.", "anything ships.", "![architecture diagram](/img/arch.png)"]) expect(server.markdown).toContain(s);
      expect(server.markdown).toMatch(/\| Backend +\| Priya/);
      expect(server.markdown.match(/Marketing needs/g)!.length).toBe(1);
    });
  }
});

group("typing into an empty or tiny page", () => {
  test("a page that is only a code block: typing before and after it", async () => {
    const { server, tab } = await setup("```\ncode only\n```");
    tab.typeAfter("code only", "\nmore code");
    await settled(tab, server);
    expect(server.markdown).toContain("code only\nmore code");
  });

  test("a page that is only a table: a comment in a cell, and a reload", async () => {
    const { server, tab, job } = await setup("| A | B |\n| --- | --- |\n| some cell text here | other cell text |");
    const { placed: [id] } = job("some cell text here");
    tab.receive(server.src);
    expect(tab.highlighted(id!)).toBe("some cell text here");
    await settled(tab, server);
  });

  test("a page that is only an image: a comment on it, and a reload", async () => {
    const { server, tab, job } = await setup("![only](/only.png)");
    const { placed: [id] } = job("![only](/only.png)");
    tab.receive(server.src);
    expect(tab.allMarked(id!)).toEqual(["[img:/only.png]"]);
    await settled(tab, server);
  });

  test("a page that is only an HTML comment: loads, saves, loads again", async () => {
    const { server, tab } = await setup("<!-- just a note -->");
    tab.typeAtCaret("x"); // the caret starts in text, not on the comment, so typing can't replace it
    const fresh = await settled(tab, server);
    expect(server.markdown).toBe("<!-- just a note -->\n\nx");
    expect(fresh.markdown).toBe("<!-- just a note -->\n\nx");
  });
});

// A caret placed by the writer stays where it was through an outside change to a code block or a table.
test("the caret in a table cell stays put when a hand edit changes the code block", async () => {
  const { server, tab } = await setup();
  tab.typeAfter("Sam", "");
  tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find("Sam").to)));
  tab.typeAtCaret(" K.");
  server.handEdit((md) => md.replace('"march"', '"april"'));
  expect(tab.receive(server.src)).toBe("merged");
  tab.typeAtCaret("!");
  expect(tab.state.selection.$head.parent.textContent).toBe("Sam K.!");
});
