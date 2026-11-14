// Ctrl-d / Ctrl-u: half a screen, caret and page together. Same faked layout as vim-motions.test.ts.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const ROW = 40;
async function make() {
  const { Editor } = await import("@tiptap/core");
  const { editorExtensions } = await import("../src/app/editor/behaviour");
  const { setVim, vimKey, blocks } = await import("../src/app/editor/vim");
  const editor = new Editor({ element: document.createElement("div"), extensions: editorExtensions(), content: "<p>row</p>".repeat(40) });
  setVim(editor, true);
  const view = editor.view;
  const rowOf = (pos: number) => blocks(editor.state.doc).findIndex((b) => pos >= b.start && pos <= b.end);
  (view as any).coordsAtPos = (pos: number) => {
    const i = rowOf(pos), b = blocks(editor.state.doc)[i]!;
    return { top: i * ROW, bottom: i * ROW + 16, left: (pos - b.start) * 8, right: (pos - b.start) * 8 + 8 };
  };
  (view as any).posAtCoords = ({ left, top }: { left: number; top: number }) => {
    const bs = blocks(editor.state.doc);
    const b = bs[Math.max(0, Math.min(bs.length - 1, Math.round(top / ROW)))]!;
    return { pos: Math.min(b.end, b.start + Math.max(0, Math.round(left / 8))), inside: -1 };
  };
  const key = (k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, ctrlKey: k === "d" || k === "u", cancelable: true });
    const used = !!view.someProp("handleKeyDown", (f) => f(view, e));
    return { used, prevented: e.defaultPrevented };
  };
  return { editor, key, st: () => vimKey.getState(editor.state)!, bs: () => blocks(editor.state.doc), head: () => editor.state.selection.head };
}
const half = () => Math.round(window.innerHeight / 2 / ROW);

describe("Ctrl-d / Ctrl-u", () => {
  test("normal mode: the caret goes half a screen down and back up, and the key is swallowed", async () => {
    const v = await make();
    v.editor.commands.setTextSelection(v.bs()[2]!.start);
    expect(v.key("d")).toEqual({ used: true, prevented: true });
    expect(v.head()).toBe(v.bs()[2 + half()]!.start);
    v.key("u");
    // The fake's rows are probed at their middle and rounded, so it may land one row off.
    expect(v.head()).toBeGreaterThanOrEqual(v.bs()[2]!.start);
    expect(v.head()).toBeLessThanOrEqual(v.bs()[3]!.start);
  });

  test("it stops on the last and first line", async () => {
    const v = await make();
    v.editor.commands.setTextSelection(v.bs()[38]!.start);
    v.key("d");
    expect(v.head()).toBe(v.bs()[39]!.start);
    v.editor.commands.setTextSelection(v.bs()[0]!.start + 1);
    v.key("u");
    expect(v.head()).toBe(v.bs()[0]!.start + 1);
  });

  test("visual mode extends the selection the same way", async () => {
    const v = await make();
    const from = v.bs()[1]!.start;
    v.editor.commands.setTextSelection(from);
    v.key("v");
    v.key("d");
    expect(v.st().mode).toBe("visual");
    expect(v.st().anchor).toBe(from);
    expect(v.st().cursor).toBe(v.bs()[1 + half()]!.start);
  });

  test("insert mode is left alone", async () => {
    const v = await make();
    v.key("i");
    expect(v.key("d")).toEqual({ used: false, prevented: false });
    expect(v.st().mode).toBe("insert");
  });
});
