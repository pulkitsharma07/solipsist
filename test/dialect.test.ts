// The markdown dialect's contract (`src/shared/docfile/dialect/`): one test per way our markdown differs from stock
// Tiptap. Run it on every Tiptap upgrade; removing any one rule fails a test here.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MarkdownManager } from "@tiptap/markdown";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertDialectHooks } from "../src/shared/docfile/dialect";
import { commentFor, docToMarkdown, markdownToDoc, pageExtensions } from "../src/shared/docfile";

const once = (md: string) => docToMarkdown(markdownToDoc(md));
const types = (md: string) => { const out: string[] = []; markdownToDoc(md).forEach((n) => out.push(n.type.name)); return out; };

describe("Tiptap still has what the dialect hooks into", () => {
  test("MarkdownManager's private HTML methods exist", () => {
    expect(() => assertDialectHooks(new MarkdownManager({ extensions: pageExtensions() }))).not.toThrow();
  });
  test("without them, loading fails loudly and says what to update", () => {
    expect(() => assertDialectHooks({})).toThrow(/parseHTMLToken \/ htmlAsLiteralText \/ encodeTextForMarkdown.*dialect/);
  });
});

describe("raw HTML is literal text, in the browser too", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterAll(() => GlobalRegistrator.unregister());
  test("a block of HTML and inline HTML stay as written", () => {
    const doc = markdownToDoc("<details>x</details>\n\nA <b>bold</b> word.");
    expect(doc.textContent).toContain("<details>x</details>");
    expect(doc.textContent).toContain("<b>bold</b>");
  });
});

describe("ampersands", () => {
  test("a bare & is written as typed, in a paragraph and in a table cell", () => {
    for (const md of ["Tea & coffee, R&D, a && b, &lt without a semicolon.", "| A | B |\n| --- | --- |\n| Tea & coffee | R&D |"]) expect(once(md)).toBe(md);
  });
  test("an & that would read as an entity stays escaped, so typed entities stay text", () => {
    const md = "Typed: &amp;amp; &amp;lt;b&amp;gt; &amp;#45; and 5 &lt; 6.";
    expect(once(md)).toBe(md);
    expect(markdownToDoc(md).textContent).toBe("Typed: &amp; &lt;b&gt; &#45; and 5 < 6.");
  });
});

describe("paragraphs", () => {
  test("text that would start a block is escaped, so it stays a paragraph", () => {
    for (const text of ["# not a heading", "> not a quote", "- not a list", "1. not a list", "---"]) {
      const doc = markdownToDoc("x");
      const json = doc.toJSON();
      json.content[0].content = [{ type: "text", text }];
      const md = docToMarkdown(doc.type.schema.nodeFromJSON(json));
      expect(types(md)).toEqual(["paragraph"]);
      expect(markdownToDoc(md).textContent).toBe(text);
    }
  });
});

describe("code blocks", () => {
  test("the fence is longer than any backtick run inside, so the code can't end the block", () => {
    const md = "````\nsome ``` inside\n````";
    expect(once(md)).toBe(md);
    expect(types(md)).toEqual(["codeBlock"]);
  });
});

describe("images", () => {
  test("a source with spaces or parentheses, brackets in the alt and quotes in the title round trip", () => {
    const md = '![a \\[b\\]](<my pic (1).png> "say \\"hi\\"")';
    expect(once(md)).toBe(md);
    const img = markdownToDoc(md).firstChild!.firstChild!;
    expect(img.attrs).toMatchObject({ src: "my pic (1).png", alt: "a [b]", title: 'say "hi"' });
  });
  test("an image on its own line in a list item loads (wrapped in a paragraph) and round trips", () => {
    expect(once("- ![a](b.png)")).toBe("- ![a](b.png)");
  });
});

describe("tables", () => {
  const md = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |";
  test("are written without column padding, so changing one cell changes one line", () => {
    expect(once(md)).toBe(md);
    const edited = once(md.replace("two", "a much longer cell"));
    expect(edited.split("\n").filter((l, i) => l !== md.split("\n")[i])).toEqual(["| one | a much longer cell |"]);
  });
  test("two in a row read back as two, with nothing between them", () => {
    const two = `${md}\n\n${md}`;
    expect(once(two)).toBe(two);
    expect(types(two)).toEqual(["table", "table"]);
  });
});

describe("lists", () => {
  test("two bullet lists in a row stay two (the second is written with *)", () => {
    const md = "- a\n- b\n\n* c";
    expect(types(md)).toEqual(["bulletList", "bulletList"]);
    expect(once(md)).toBe(md);
  });
  test("an ordered item's indented content keeps its indent (the extension-list patch: it was one column short)", () => {
    for (const md of ["1. a\n\n   b", "10. a\n\n    b"]) {
      expect(markdownToDoc(md).firstChild!.firstChild!.childCount).toBe(2);
      expect(once(md)).toBe(md);
    }
    // A code block in an item: its lines keep no extra leading space. (The blank line before it goes on the first save.)
    const md = "1. Code:\n\n   ```js\n   const x = 1;\n   ```";
    expect(markdownToDoc(md).firstChild!.firstChild!.lastChild!.textContent).toBe("const x = 1;");
    expect(once(once(md))).toBe(once(md));
  });
  test("a task item's text may wrap onto the next lines, indented or not, like any list item's", () => {
    // Stock Tiptap kept only the first line: the rest became a second paragraph, and `**b` / `c**` lost its bold.
    for (const md of ["- [ ] a **b\n  c**", "- [ ] a **b\nc**", "- [x] a  \n  b", "- [ ] a\\\n  b"]) {
      const item = markdownToDoc(md).firstChild!.firstChild!;
      expect(item.childCount).toBe(1);
      expect(once(once(md))).toBe(once(md));
    }
    expect(markdownToDoc("- [ ] a **b\n  c**").firstChild!.firstChild!.firstChild!.child(1).marks.map((m) => m.type.name)).toEqual(["bold"]);
    // A blank line still starts a second paragraph; a nested task list and a block after the list stay what they are.
    expect(markdownToDoc("- [ ] a\n\n  b").firstChild!.firstChild!.childCount).toBe(2);
    expect(once("- [ ] a\n  - [x] b\n- [ ] c")).toBe("- [ ] a\n  - [x] b\n- [ ] c");
    expect(types("- [ ] a\n# h")).toEqual(["taskList", "heading"]);
    // A list right after the wrapped text is a list, as after a bullet item's text (even one that starts at 8).
    for (const md of ["- [ ] T  \nplan\n  8. A", "- T  \nplan\n  8. A"]) {
      const lists: string[] = [];
      markdownToDoc(md).descendants((n) => { if (n.type.name.endsWith("List")) lists.push(n.type.name); });
      expect(lists[1]).toBe("orderedList");
      expect(once(md)).toBe(md);
    }
    // In a bullet item too, where the lexer hands over text blocks as plain text: the image is an image.
    for (const md of ["- a\n  - [x] b  \n    c ![i](/i.png)", "- a\n  - [x] b\n\n    c ![i](/i.png)"]) {
      expect(once(once(md))).toBe(once(md));
      let images = 0;
      markdownToDoc(md).descendants((n) => { if (n.type.name === "image") images++; });
      expect(images).toBe(1);
    }
  });
  test("an ordered item indented differently from the first one keeps its text (the extension-list patch, again)", () => {
    // Stock Tiptap skipped such an item, with its text, while nesting the list by indent.
    for (const [md, text] of [["   1. a\n2. b", "ab"], ["- x\n     1. a\n  9. b", "xab"], ["1. a\n   1. b\n  2. c", "abc"]] as const) {
      expect(markdownToDoc(md).textContent).toBe(text);
      expect(once(once(md))).toBe(once(md));
    }
  });
  test("an empty item, and one that starts with a nested list, load", () => {
    expect(once("1. a\n2. ")).toBe("1. a\n2. ");
    expect(types("1. \n   - nested")).toEqual(["orderedList"]);
  });
});

describe("lines of text", () => {
  test("the spaces that indent the line after a hard break are not text, so an indented list reads back the same", () => {
    for (const md of ["   - a  \n   b", "- a  \n   b", "1. a  \n      b"]) {
      expect(once(once(md))).toBe(once(md));
      expect(markdownToDoc(md).textContent).toBe("ab");
    }
  });
  test("nor are those of a line the text wraps onto: a wrapped `    - b` stays text", () => {
    for (const md of ["- [x] a  \nc\n      - b", "a\n    - b", "- a\n  c\n      - b"]) {
      expect(once(once(md))).toBe(once(md));
      expect(markdownToDoc(md).textContent).toContain("- b");
    }
  });
  test("in code they are code", () => {
    expect(once("```\na\n    b\n```")).toBe("```\na\n    b\n```");
  });
});

describe("comment highlights", () => {
  test("write nothing, and don't split the formatting they start or end inside", () => {
    // A highlight ending inside "**budget owner**" split the bold in two, and the second half was written as
    // <strong>owner</strong>: literal text on the next load.
    const doc = markdownToDoc("A **budget owner** here, and *one two* `x`.");
    const json = doc.toJSON();
    const para = json.content[0];
    const comment = { type: "comment", attrs: { id: "c1" } };
    para.content = para.content.flatMap((n: { text?: string; marks?: object[] }) => {
      if (n.text === "A ") return [{ ...n, marks: [comment] }]; // the highlight starts before the bold
      if (n.text === "budget owner") return [{ ...n, text: "budget", marks: [...n.marks!, comment] }, { ...n, text: " owner" }];
      if (n.text === "one two") return [{ ...n, text: "one ", marks: [...n.marks!, comment] }, { ...n, text: "two" }];
      return [n];
    });
    expect(docToMarkdown(doc.type.schema.nodeFromJSON(json))).toBe("A **budget owner** here, and *one two* `x`.");
  });
});

describe("marks", () => {
  test("bold around code loads: the marks code can't carry together are reduced", () => {
    expect(markdownToDoc("**`x`**").textContent).toBe("x");
  });
});

describe("hand-written HTML comments", () => {
  test("are kept byte for byte, as a block or inline, and in code stay code", () => {
    for (const md of ["Above.\n\n<!--\n# not a heading\n-->\n\nBelow.", "Some <!-- *hidden* --> words.", "`<!-- x -->`"]) expect(once(md)).toBe(md);
    expect(types("<!-- a -->\n\nText.")).toEqual(["htmlComment", "paragraph"]);
  });
});

describe("placeholders", () => {
  test("travel through the parser as comments of their kind, and in code stay code", () => {
    expect(once("a <!-- gen:abc --> b")).toBe("a <!-- gen:abc --> b");
    expect(once("`<!-- gen:abc -->`")).toBe("`<!-- gen:abc -->`");
  });
  const instructionOf = (md: string) => {
    const found: string[] = [];
    markdownToDoc(md).descendants((n) => { for (const m of n.marks) if (m.type.name === "markerRange") found.push(m.attrs.instruction); });
    return found;
  };
  test("an instruction on the opening comment travels with the range, every escaped character intact", () => {
    const said = `say "hi" & <b>bold</b> -- and --> then\nnext line`;
    const md = `a ${commentFor("s", "sel", "abc", "ack", said)}text *with* markup${commentFor("e", "sel", "abc", "ack")} b`;
    expect(md).toContain(`<!-- sel:abc:ack "say &quot;hi&quot; &amp; &lt;b&gt;bold&lt;/b&gt; -&#45; and -&#45;&gt; then next line" -->`);
    expect(once(md)).toBe(md);
    expect(instructionOf(md)).toEqual(Array(3).fill(`say "hi" & <b>bold</b> -- and --> then next line`)); // one per text node of the range
    // Markdown in the instruction is not read as markdown: it is not text of the page at all.
    expect(once(`x <!-- sel:abc "make *this* \`code\` [a](b) _y_ \\\\ x-&#45;y" -->t<!-- /sel:abc -->`)).toBe(`x <!-- sel:abc "make *this* \`code\` [a](b) _y_ \\\\ x-&#45;y" -->t<!-- /sel:abc -->`);
  });
  test("a range over several blocks writes its instruction on the first opening comment only, and every piece has it", () => {
    const md = `<!-- sel:abc "join these" -->One.<!-- /sel:abc -->\n\n<!-- sel:abc -->Two.<!-- /sel:abc -->`;
    expect(once(md)).toBe(md);
    expect(instructionOf(md)).toEqual(["join these", "join these"]);
    // The first piece removed: the next one writes it.
    const doc = markdownToDoc(md);
    expect(docToMarkdown(doc.copy(doc.content.cut(doc.firstChild!.nodeSize)))).toBe(`<!-- sel:abc "join these" -->Two.<!-- /sel:abc -->`);
  });
  test("a range around something that isn't text keeps its comments: an image, or a point marker inside it", () => {
    // Tiptap writes a mark's markdown around text only, so these are written by the dialect (`nodeRangesToText`).
    const image = `<!-- img:abc "make the bars blue" -->![A chart](images/p1/chart.svg)<!-- /img:abc -->`;
    expect(once(image)).toBe(image);
    const ids = (md: string) => { const out: string[] = []; markdownToDoc(md).descendants((n) => { for (const m of n.marks) if (m.type.name === "markerRange") out.push(`${m.attrs.taskType}:${m.attrs.id}`); }); return out; };
    expect(ids(image)).toEqual(["img:abc"]); // the mark is on the image itself
    // One pair around the whole run, not one around each piece of text.
    for (const md of [
      `see <!-- sel:abc "x" -->this ![A chart](images/p1/chart.svg) here<!-- /sel:abc -->.`,
      `a <!-- sel:abe -->![A](i/a.svg)![B](i/b.svg)<!-- /sel:abe --> b`,
      `a <!-- sel:abc -->one <!-- gen:bcd --> two<!-- /sel:abc --> b`,
    ]) expect(once(md)).toBe(md);
  });

  test("a payload on a kind without instructions, or on a closing comment, is not a placeholder: it stays a comment", () => {
    for (const md of [`a <!-- gen:abc "no" --> b`, `a <!-- sel:abc -->t<!-- /sel:abc "no" --> b`]) {
      expect(once(md)).toBe(md);
      expect(instructionOf(md)).toEqual([]);
    }
    let points = 0;
    markdownToDoc(`a <!-- gen:abc "no" --> b`).descendants((n) => { if (n.type.name === "markerPoint") points++; });
    expect(points).toBe(0);
  });
});
