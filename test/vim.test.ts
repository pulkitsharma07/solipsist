// Vim keys: motions, operators, visual mode and the mode switch, driven through a real editor.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Editor } from "@tiptap/core";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

async function make(html: string) {
  const { Editor } = await import("@tiptap/core");
  const { editorExtensions } = await import("../src/app/editor/behaviour");
  const { setVim, vimKey } = await import("../src/app/editor/vim");
  const editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions(), content: html });
  setVim(editor, true);
  const st = () => vimKey.getState(editor.state)!;
  const press = (keys: string, mods: { ctrlKey?: boolean } = {}) => {
    for (const k of keys === "Escape" ? [keys] : keys.split("")) {
      const e = new KeyboardEvent("keydown", { key: k, ...mods, cancelable: true });
      editor.view.someProp("handleKeyDown", (f) => f(editor.view, e));
    }
  };
  const text = () => editor.state.doc.textBetween(0, editor.state.doc.content.size, "|");
  const at = (n: number) => editor.commands.setTextSelection(n);
  return { editor, st, press, text, at };
}

test("turning vim on starts in normal mode; typing does not insert", async () => {
  const v = await make("<p>hello world</p>");
  expect(v.st().on).toBe(true);
  expect(v.st().mode).toBe("normal");
  v.press("z");
  expect(v.text()).toBe("hello world");
});

test("h l w b e 0 $ move the caret", async () => {
  const v = await make("<p>hello world</p>");
  v.at(1);
  v.press("w");
  expect(v.editor.state.selection.head).toBe(7);
  v.press("b");
  expect(v.editor.state.selection.head).toBe(1);
  v.press("e");
  expect(v.editor.state.selection.head).toBe(5);
  v.press("$");
  expect(v.editor.state.selection.head).toBe(11);
  v.press("0");
  expect(v.editor.state.selection.head).toBe(1);
  v.press("3l");
  expect(v.editor.state.selection.head).toBe(4);
});

test("x, dw, dd, yy p and u", async () => {
  const v = await make("<p>hello world</p><p>second</p>");
  v.at(1);
  v.press("x");
  expect(v.text()).toBe("ello world|second");
  v.press("dw");
  expect(v.text()).toBe("world|second");
  v.press("yy");
  v.press("p");
  expect(v.text()).toBe("world|world|second");
  v.press("dd");
  expect(v.text()).toBe("world|second");
});

test("u undoes the last change", async () => {
  const v = await make("<p>hello</p>");
  v.at(1);
  v.press("x");
  expect(v.text()).toBe("ello");
  v.press("u");
  expect(v.text()).toBe("hello");
  expect(v.st().mode).toBe("normal");
});

test("cw changes a word and leaves insert mode on Escape", async () => {
  const v = await make("<p>hello world</p>");
  v.at(1);
  v.press("cw");
  expect(v.st().mode).toBe("insert");
  expect(v.text()).toBe(" world");
  v.press("Escape");
  expect(v.st().mode).toBe("normal");
});

test("visual mode selects with motions and deletes", async () => {
  const v = await make("<p>hello world</p>");
  v.at(1);
  v.press("vee");
  expect(v.st().mode).toBe("visual");
  v.press("d");
  expect(v.text()).toBe("");
  expect(v.st().mode).toBe("normal");
});

test("V selects lines; o opens a line below in insert mode", async () => {
  const v = await make("<h1>title</h1><p>one</p><p>two</p>");
  v.at(9);
  v.press("Vd");
  expect(v.text()).toBe("title|two");
  v.press("o");
  expect(v.st().mode).toBe("insert");
  expect(v.text()).toBe("title|two|");
});

test("turning vim off lets the writer type again", async () => {
  const v = await make("<p>abc</p>");
  const { setVim } = await import("../src/app/editor/vim");
  setVim(v.editor, false);
  expect(v.st().on).toBe(false);
  v.press("z");
  expect(v.text()).toBe("abc");
});
