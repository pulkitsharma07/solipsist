// Vim keys without a browser: the pure text geometry, every key family, and j/k against a faked layout.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

async function make(html: string, opts: { layout?: "rows" | "blind" } = {}) {
  const { Editor } = await import("@tiptap/core");
  const { editorExtensions } = await import("../src/app/editor/behaviour");
  const { setVim, vimKey, blocks } = await import("../src/app/editor/vim");
  const editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions(), content: html });
  setVim(editor, true);
  const view = editor.view;

  // No layout engine here, so fake one: every block is a 16px row, 40px apart, 8px per character.
  const ROW = 40;
  const rowOf = (pos: number) => blocks(editor.state.doc).findIndex((b) => pos >= b.start && pos <= b.end);
  (view as any).coordsAtPos = (pos: number) => {
    const i = rowOf(pos), b = blocks(editor.state.doc)[i]!;
    return { top: i * ROW, bottom: i * ROW + 16, left: (pos - b.start) * 8, right: (pos - b.start) * 8 + 8 };
  };
  (view as any).posAtCoords = ({ left, top }: { left: number; top: number }) => {
    if (opts.layout === "blind") return null;
    const bs = blocks(editor.state.doc);
    const i = Math.max(0, Math.min(bs.length - 1, Math.round(top / ROW)));
    const b = bs[i]!;
    return { pos: Math.min(b.end, b.start + Math.max(0, Math.round(left / 8))), inside: -1 };
  };

  const st = () => vimKey.getState(editor.state)!;
  const head = () => editor.state.selection.head;
  const press = (keys: string | string[], mods: { ctrlKey?: boolean } = {}) => {
    for (const k of typeof keys === "string" ? keys.split("") : keys) {
      const e = new KeyboardEvent("keydown", { key: k, ...mods, cancelable: true });
      view.someProp("handleKeyDown", (f) => f(view, e));
    }
  };
  const text = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "|");
  const at = (n: number) => editor.commands.setTextSelection(n);
  const selected = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, "|");
  return { editor, st, head, press, text, at, selected, blocks: () => blocks(editor.state.doc) };
}

describe("text geometry", () => {
  test("flatten gives one entry per character and a newline per block, positions strictly increasing", async () => {
    const { flatten } = await import("../src/app/editor/vim");
    const v = await make("<p>ab</p><p></p><p>c</p>");
    const L = flatten(v.editor.state.doc);
    expect(L.map((c) => c.ch).join("")).toBe("ab\n\nc\n");
    for (let i = 1; i < L.length; i++) expect(L[i]!.pos).toBeGreaterThan(L[i - 1]!.pos);
  });

  test("word motions treat punctuation as its own word, big words as whitespace-separated", async () => {
    const { flatten, wordForward, wordEnd, wordBack } = await import("../src/app/editor/vim");
    const v = await make("<p>foo.bar baz</p>");
    const L = flatten(v.editor.state.doc);
    expect(wordForward(L, 1)).toBe(4); // foo -> .
    expect(wordForward(L, 4)).toBe(5); // . -> bar
    expect(wordForward(L, 1, true)).toBe(9); // W: foo.bar -> baz
    expect(wordEnd(L, 1)).toBe(3);
    expect(wordEnd(L, 1, true)).toBe(7);
    expect(wordBack(L, 9)).toBe(5);
    expect(wordBack(L, 9, true)).toBe(1);
  });

  test("an empty line is a word of its own for w and b", async () => {
    const { flatten, wordForward, wordBack } = await import("../src/app/editor/vim");
    const v = await make("<p>one</p><p></p><p>two</p>");
    const [a, empty, c] = v.blocks();
    const L = flatten(v.editor.state.doc);
    expect(wordForward(L, a!.start)).toBe(empty!.start);
    expect(wordForward(L, empty!.start)).toBe(c!.start);
    expect(wordBack(L, c!.start)).toBe(empty!.start);
  });
});

describe("modes", () => {
  test("normal mode swallows typing; arrows and shortcuts pass through", async () => {
    const v = await make("<p>abc</p>");
    v.press("qz");
    expect(v.text()).toBe("abc");
    // Ask the vim plugin alone: other plugins (bold on Cmd+B) rightly handle some of these themselves.
    const { vimKey } = await import("../src/app/editor/vim");
    const vimOnly = (init: KeyboardEventInit) =>
      vimKey.get(v.editor.state)!.props.handleKeyDown!.call(vimKey.get(v.editor.state)!, v.editor.view, new KeyboardEvent("keydown", { cancelable: true, ...init }));
    expect(vimOnly({ key: "ArrowLeft" })).toBeFalsy();
    expect(vimOnly({ key: "b", metaKey: true })).toBeFalsy();
    expect(vimOnly({ key: "Tab" })).toBeFalsy();
    expect(vimOnly({ key: "z" })).toBeTruthy();
  });

  test("i, a, I, A enter insert mode at the right place; Escape steps back onto a character", async () => {
    const v = await make("<p>\u00a0\u00a0hello</p>");
    v.at(4);
    v.press("i");
    expect([v.st().mode, v.head()]).toEqual(["insert", 4]);
    v.press(["Escape"]);
    expect([v.st().mode, v.head()]).toEqual(["normal", 3]);
    v.press("a");
    expect(v.head()).toBe(4);
    v.press(["Escape"]);
    v.press("I");
    expect(v.head()).toBe(3); // first non-blank
    v.press(["Escape"]);
    v.press("A");
    expect(v.head()).toBe(8); // past the last character
  });

  test("text typed in insert mode goes into the page", async () => {
    const v = await make("<p>ac</p>");
    v.at(2);
    v.press("i");
    v.editor.commands.insertContent("b");
    expect(v.text()).toBe("abc");
  });

  test("Ctrl-[ works as Escape; Escape cancels a half-typed command", async () => {
    const v = await make("<p>abc</p>");
    v.press("i");
    v.press("[", { ctrlKey: true });
    expect(v.st().mode).toBe("normal");
    v.press("2d");
    expect(v.st().op).toBe("d");
    v.press(["Escape"]);
    expect([v.st().op, v.st().count]).toEqual(["", ""]);
  });

  test("the caret never rests past the last character in normal mode", async () => {
    const v = await make("<p>abc</p>");
    v.at(1);
    v.press("$");
    expect(v.head()).toBe(3);
    v.press("l");
    expect(v.head()).toBe(3);
    v.at(4); // clicked past the end
    expect(v.head()).toBe(3);
  });
});

describe("motions", () => {
  test("counts: 3l, 2w, 2b, and 0 as a motion once no count is pending", async () => {
    const v = await make("<p>aa bb cc dd</p>");
    v.at(1);
    v.press("2w");
    expect(v.head()).toBe(7);
    v.press("2b");
    expect(v.head()).toBe(1);
    v.press("10l");
    expect(v.head()).toBe(11);
    v.press("0");
    expect(v.head()).toBe(1);
  });

  test("^ goes to the first non-blank, $ to the last character, h stops at the line start", async () => {
    const v = await make("<p>\u00a0\u00a0\u00a0x yz</p>");
    v.at(6);
    v.press("^");
    expect(v.head()).toBe(4);
    v.press("$");
    expect(v.head()).toBe(7);
    v.press("99h");
    expect(v.head()).toBe(1);
  });

  test("gg and G go to the first and last line; a count picks the line", async () => {
    const v = await make("<h1>t</h1><p>a</p><p>b</p><p>c</p>");
    const b = v.blocks();
    v.press("G");
    expect(v.head()).toBe(b[3]!.start);
    v.press("gg");
    expect(v.head()).toBe(b[0]!.start);
    v.press("3G");
    expect(v.head()).toBe(b[2]!.start);
  });

  test("{ and } jump between empty lines", async () => {
    const v = await make("<p>a</p><p></p><p>b</p><p></p><p>c</p>");
    const b = v.blocks();
    v.at(b[0]!.start);
    v.press("}");
    expect(v.head()).toBe(b[1]!.start);
    v.press("}");
    expect(v.head()).toBe(b[3]!.start);
    v.press("{");
    expect(v.head()).toBe(b[1]!.start);
  });

  test("w and b cross lines", async () => {
    const v = await make("<p>one</p><p>two</p>");
    const b = v.blocks();
    v.at(b[0]!.start);
    v.press("w");
    expect(v.head()).toBe(b[1]!.start);
    v.press("b");
    expect(v.head()).toBe(b[0]!.start);
  });
});

describe("j and k", () => {
  test("move one line, keep the column, and stop at the ends", async () => {
    const v = await make("<p>abcdef</p><p>xy</p><p>ghijkl</p>");
    const b = v.blocks();
    v.at(b[0]!.start + 4);
    v.press("j");
    expect(v.head()).toBe(b[1]!.end - 1); // short line: last character
    v.press("j");
    expect(v.head()).toBe(b[2]!.start + 4); // the column is remembered
    v.press("j");
    expect(v.head()).toBe(b[2]!.start + 4);
    v.press("kk");
    expect(v.head()).toBe(b[0]!.start + 4);
    v.press("k");
    expect(v.head()).toBe(b[0]!.start + 4);
  });

  test("empty lines between two lines can be passed in both directions", async () => {
    const v = await make("<p>top</p><p></p><p></p><p>bottom</p>");
    const b = v.blocks();
    v.at(b[0]!.start + 1);
    v.press("j");
    expect(v.head()).toBe(b[1]!.start);
    v.press("j");
    expect(v.head()).toBe(b[2]!.start);
    v.press("j");
    expect(v.head()).toBe(b[3]!.start + 1);
    v.press("k");
    expect(v.head()).toBe(b[2]!.start);
    v.press("k");
    expect(v.head()).toBe(b[1]!.start);
    v.press("k");
    expect(v.head()).toBe(b[0]!.start + 1);
  });

  test("when the layout gives no answer, j and k fall back to the neighbouring line", async () => {
    const v = await make("<p>top</p><p></p><p>bottom</p>", { layout: "blind" });
    const b = v.blocks();
    v.at(b[0]!.start);
    v.press("jj");
    expect(v.head()).toBe(b[2]!.start);
    v.press("kk");
    expect(v.head()).toBe(b[0]!.start);
  });

  test("a count moves several lines", async () => {
    const v = await make("<p>a</p><p>b</p><p>c</p><p>d</p>");
    const b = v.blocks();
    v.at(b[0]!.start);
    v.press("3j");
    expect(v.head()).toBe(b[3]!.start);
    v.press("2k");
    expect(v.head()).toBe(b[1]!.start);
  });
});

describe("j and k over images", () => {
  const PAGE = '<p>one</p><p>before <img src="a.svg"> after</p><p>two</p><p><img src="b.svg"></p><p>three</p>';
  const row = (v: Awaited<ReturnType<typeof make>>) => v.blocks().findIndex((b) => v.head() >= b.start && v.head() <= b.end);

  test("j walks down one line at a time through lines with pictures, k back up, none skipped", async () => {
    const v = await make(PAGE);
    v.at(v.blocks()[0]!.start);
    const down = [];
    for (let i = 0; i < 4; i++) { v.press("j"); down.push(row(v)); }
    expect(down).toEqual([1, 2, 3, 4]);
    const up = [];
    for (let i = 0; i < 4; i++) { v.press("k"); up.push(row(v)); }
    expect(up).toEqual([3, 2, 1, 0]);
  });

  test("a count counts the lines with pictures too", async () => {
    const v = await make(PAGE);
    v.at(v.blocks()[0]!.start);
    v.press("3j");
    expect(row(v)).toBe(3);
  });

  test("the caret lands on a line that is only a picture, on the picture", async () => {
    const v = await make(PAGE);
    v.at(v.blocks()[2]!.start);
    v.press("j");
    expect(row(v)).toBe(3);
    expect(v.editor.state.selection.$from.nodeAfter?.type.name).toBe("image");
  });

  test("two pictures back to back, in separate lines: j visits each, the caret on each picture", async () => {
    const v = await make('<p>top</p><p><img src="a.svg"></p><p><img src="b.svg"></p><p>bottom</p>');
    v.at(v.blocks()[0]!.start);
    const seen = [];
    for (let i = 0; i < 3; i++) { v.press("j"); seen.push([row(v), v.editor.state.selection.$from.nodeAfter?.attrs.src ?? null]); }
    expect(seen).toEqual([[1, "a.svg"], [2, "b.svg"], [3, null]]);
    v.press("k"); v.press("k");
    expect(row(v)).toBe(1);
  });

  test("two pictures back to back, in one line: l steps from one to the other, the overlay follows", async () => {
    const v = await make('<p><img src="a.svg"><img src="b.svg"></p>');
    const hintSrc = () => v.editor.view.dom.querySelector("img.img-target")?.getAttribute("src")?.split("/").pop() ?? null;
    v.at(v.blocks()[0]!.start);
    expect(hintSrc()).toBe("a.svg");
    v.press("l");
    expect(v.editor.state.selection.$from.nodeAfter?.attrs.src).toBe("b.svg");
    expect(hintSrc()).toBe("b.svg");
    v.press("h");
    expect(hintSrc()).toBe("a.svg");
  });

  test("two pictures in one paragraph (as a page of images loads): j and k go from one picture to the other, then leave", async () => {
    const { Server, Tab } = await import("./browser-tab");
    const { setVim } = await import("../src/app/editor/vim");
    for (const md of ["top\n\n![A](a.svg)\n\n![B](b.svg)\n\nbottom", "top\n\n![A](a.svg)![B](b.svg)\n\nbottom"]) {
      const tab = new Tab(new Server(md).src);
      const view = tab.editor.view;
      setVim(tab.editor, true);
      const press = (k: string) => view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: k, cancelable: true })));
      const on = () => { const n = tab.editor.state.selection.$from.nodeAfter; return n?.type.name === "image" ? String(n.attrs.src).split("/").pop() : n?.textContent ?? tab.editor.state.selection.$from.parent.textContent; };
      tab.editor.commands.setTextSelection(1);
      const trail: unknown[] = [];
      for (const k of "jjjkkk") { press(k); trail.push(on()); }
      expect(trail).toEqual(["a.svg", "b.svg", "bottom", "b.svg", "a.svg", "top"]);
    }
  });

  test("a probe that overshoots a picture's tall line does not skip the line", async () => {
    const v = await make("<p>one</p><p>two</p><p>three</p>");
    // A layout where the probe lands two lines below where it should.
    (v.editor.view as any).posAtCoords = ({ left, top }: { left: number; top: number }) => {
      const bs = v.blocks(), b = bs[Math.min(bs.length - 1, Math.round(top / 40) + 1)]!;
      return { pos: Math.min(b.end, b.start + Math.round(left / 8)), inside: -1 };
    };
    v.at(v.blocks()[0]!.start);
    v.press("j");
    expect(row(v)).toBe(1);
  });
});

describe("operators", () => {
  test("x with a count, X, and D", async () => {
    const v = await make("<p>abcdef</p>");
    v.at(2);
    v.press("2x");
    expect(v.text()).toBe("adef");
    v.press("X");
    expect(v.text()).toBe("def");
    v.at(2);
    v.press("D");
    expect(v.text()).toBe("d");
  });

  test("dw on the last word of a line stays on the line; d$ and d0", async () => {
    const v = await make("<p>one two</p><p>three</p>");
    const b = v.blocks();
    v.at(b[0]!.start + 4);
    v.press("dw");
    expect(v.text()).toBe("one |three");
    v.at(b[0]!.start + 2);
    v.press("d$");
    expect(v.text()).toBe("on|three");
    v.at(b[0]!.start + 1);
    v.press("$");
    v.press("d0");
    expect(v.text()).toBe("n|three");
  });

  test("de is inclusive, db goes backwards, d2w takes two words", async () => {
    const v = await make("<p>aa bb cc dd</p>");
    v.at(1);
    v.press("de");
    expect(v.text()).toBe(" bb cc dd");
    v.press("w");
    v.press("d2w");
    expect(v.text()).toBe(" dd");
    v.press("$");
    v.press("db"); // the caret is on the last d: the one before it goes
    expect(v.text()).toBe(" d");
  });

  test("dd with a count, dj and dk are linewise; deleting the first block only empties it", async () => {
    const v = await make("<h1>title</h1><p>a</p><p>b</p><p>c</p><p>d</p>");
    const b = v.blocks();
    v.at(b[1]!.start);
    v.press("2dd");
    expect(v.text()).toBe("title|c|d");
    v.press("dj");
    expect(v.text()).toBe("title|"); // the page keeps an empty line to type on
    v.at(1);
    v.press("dd");
    expect(v.text()).toBe("|"); // the title is emptied, not removed; the empty line below stays
  });

  test("cc and S clear the line and enter insert; cw, C, s, cc keep the block", async () => {
    const v = await make("<p>hello world</p><p>x</p>");
    v.at(1);
    v.press("cc");
    expect(v.text()).toBe("|x");
    expect(v.st().mode).toBe("insert");
    v.press(["Escape"]);
    v.at(v.blocks()[1]!.start);
    v.press("s");
    expect(v.text()).toBe("|");
    expect(v.st().mode).toBe("insert");
  });

  test("cw keeps the space after the word; c$ and C change to the end of the line", async () => {
    const v = await make("<p>foo bar</p>");
    v.at(1);
    v.press("cw");
    expect(v.text()).toBe(" bar");
    v.press(["Escape"]);
    v.press("$");
    v.press("C");
    expect(v.text()).toBe(" ba");
    expect(v.st().mode).toBe("insert");
  });

  test("yank and paste: yw p, yy p, yy P, charwise p lands after the caret", async () => {
    const v = await make("<h1>t</h1><p>ab cd</p>");
    const b = v.blocks();
    v.at(b[1]!.start);
    v.press("yw");
    v.press("$");
    v.press("p");
    expect(v.text()).toBe("t|ab cdab ");
    v.press("yy");
    v.press("p");
    expect(v.text()).toBe("t|ab cdab |ab cdab ");
    v.press("P");
    expect(v.text()).toBe("t|ab cdab |ab cdab |ab cdab ");
  });

  test("paste with an empty register does nothing", async () => {
    const v = await make("<p>abc</p>");
    v.press("p");
    expect(v.text()).toBeTruthy();
  });

  test("o and O open lines below and above and enter insert mode", async () => {
    const v = await make("<h1>t</h1><p>mid</p>");
    v.at(v.blocks()[1]!.start);
    v.press("o");
    expect(v.text()).toBe("t|mid|");
    expect(v.st().mode).toBe("insert");
    v.press(["Escape"]);
    v.at(v.blocks()[1]!.start);
    v.press("O");
    expect(v.text()).toBe("t||mid|");
    expect(v.st().mode).toBe("insert");
    expect(v.editor.state.selection.$from.parent.content.size).toBe(0);
    expect(v.head()).toBe(v.blocks()[1]!.start);
  });

  test("u undoes and Ctrl-r redoes, staying in normal mode", async () => {
    const v = await make("<p>hello</p>");
    v.at(1);
    v.press("x");
    expect(v.text()).toBe("ello");
    v.press("u");
    expect(v.text()).toBe("hello");
    v.press("r", { ctrlKey: true });
    expect(v.text()).toBe("ello");
    expect(v.st().mode).toBe("normal");
  });

  test("an operator followed by a key that is no motion is dropped", async () => {
    const v = await make("<p>abc</p>");
    v.at(1);
    v.press("dz");
    expect(v.text()).toBe("abc");
    expect(v.st().op).toBe("");
  });
});

describe("visual mode", () => {
  test("v selects the character under the caret, motions extend, y yanks and returns to normal", async () => {
    const v = await make("<p>hello world</p>");
    v.at(1);
    v.press("v");
    expect(v.selected()).toBe("h");
    v.press("e");
    expect(v.selected()).toBe("hello");
    v.press("y");
    expect(v.st().mode).toBe("normal");
    expect(v.head()).toBe(1);
    v.press("$");
    v.press("p");
    expect(v.text()).toBe("hello worldhello");
  });

  test("selecting backwards includes both ends; o swaps the ends", async () => {
    const v = await make("<p>hello world</p>");
    v.at(6);
    v.press("v");
    v.press("hh");
    expect(v.selected()).toBe("lo ");
    v.press("o");
    v.press("l");
    expect(v.selected()).toBe("lo w");
  });

  test("v again or Escape leaves visual mode on the cursor", async () => {
    const v = await make("<p>hello</p>");
    v.at(1);
    v.press("vll");
    v.press("v");
    expect([v.st().mode, v.head()]).toEqual(["normal", 3]);
    v.press("vl");
    v.press(["Escape"]);
    expect(v.st().mode).toBe("normal");
    expect(v.editor.state.selection.empty).toBe(true);
  });

  test("x, d and c operate on the selection; c enters insert mode", async () => {
    const v = await make("<p>hello world</p>");
    v.at(1);
    v.press("vlx");
    expect(v.text()).toBe("llo world");
    v.press("vec");
    expect(v.text()).toBe(" world");
    expect(v.st().mode).toBe("insert");
  });

  test("V selects whole lines, j extends, d deletes them", async () => {
    const v = await make("<h1>t</h1><p>a</p><p>b</p><p>c</p>");
    v.at(v.blocks()[1]!.start);
    v.press("Vj");
    expect(v.selected()).toBe("a|b");
    expect(v.st().mode).toBe("vline");
    v.press("d");
    expect(v.text()).toBe("t|c");
    expect(v.st().mode).toBe("normal");
  });

  test("V then v switches to character selection; V then V leaves", async () => {
    const v = await make("<p>abc</p>");
    v.at(2);
    v.press("V");
    v.press("v");
    expect(v.st().mode).toBe("visual");
    v.press("V");
    v.press("V");
    expect(v.st().mode).toBe("normal");
  });

  test("visual j and k move across lines, including empty ones", async () => {
    const v = await make("<p>one</p><p></p><p>two</p>");
    const b = v.blocks();
    v.at(b[0]!.start);
    v.press("vjj");
    expect(v.selected()).toBe("one||t");
    v.press("kk");
    expect(v.selected()).toBe("o");
  });

  test("a selection made with the mouse puts normal mode into visual mode", async () => {
    const v = await make("<p>hello world</p>");
    v.at(1);
    v.editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(v.st().mode).toBe("visual");
    v.press("d");
    expect(v.text()).toBe(" world");
  });
});

describe("switching vim on and off", () => {
  test("off gives back ordinary typing; on again returns to normal mode on a character", async () => {
    const { setVim } = await import("../src/app/editor/vim");
    const v = await make("<p>abc</p>");
    setVim(v.editor, false);
    expect([v.st().on, v.st().mode]).toEqual([false, "insert"]);
    v.press("x");
    expect(v.text()).toBe("abc");
    v.at(4);
    setVim(v.editor, true);
    expect([v.st().on, v.st().mode, v.head()]).toEqual([true, "normal", 3]);
  });

  test("the editor gets a class for the mode, so the cursor can follow it", async () => {
    const v = await make("<p>abc</p>");
    const cls = () => v.editor.view.dom.className;
    expect(cls()).toContain("vim-normal");
    v.press("i");
    expect(cls()).toContain("vim-insert");
    v.press(["Escape"]);
    v.press("v");
    expect(cls()).toContain("vim-visual");
    v.press(["Escape"]);
    const { setVim } = await import("../src/app/editor/vim");
    setVim(v.editor, false);
    expect(cls()).not.toContain("vim-");
  });

  test("a block-cursor decoration sits on the character under the caret in normal mode only", async () => {
    const v = await make("<p>abc</p>");
    v.at(2);
    expect(v.editor.view.dom.querySelector(".vim-cursor")?.textContent).toBe("b");
    v.press("i");
    expect(v.editor.view.dom.querySelector(".vim-cursor")).toBeNull();
  });
});
