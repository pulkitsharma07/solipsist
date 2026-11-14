// The instruction of a `sel` range (`src/app/editor/instructionInput.ts`): Cmd+. on a selection opens a one-line input,
// Enter makes the range with what was typed, Escape gives the selection back; a waiting range's loader opens it to
// change, an acknowledged one's to read; Ask again on its suggestion opens it with the old instruction.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { TextSelection } from "@tiptap/pm/state";
import { Server, Tab } from "./browser-tab";

// Read before the fake DOM replaces `navigator`, as ProseMirror's keymap read it when it loaded.
const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  document.body.innerHTML = "";
});

const { instructionBox, MAX_INSTRUCTION } = await import("../src/app/editor/instructionInput");

function open(body: string) {
  const server = new Server(body);
  const tab = new Tab(server.src);
  document.body.append(tab.editor.view.dom);
  return { server, tab };
}
const dom = (tab: Tab) => tab.editor.view.dom;
const select = (tab: Tab, text: string) => tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find(text).from, tab.find(text).to)));
const cmdDot = (tab: Tab) => !dom(tab).dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
const field = () => document.querySelector<HTMLTextAreaElement>(".task-ask textarea");
/** What the note under a refused selection says. */
const refusal = () => document.querySelector(".task-popup .task-refusal")?.textContent ?? null;
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const type = (text: string) => { field()!.value = text; field()!.dispatchEvent(new Event("input")); };
const enter = () => key(field()!, "Enter");
const asking = (tab: Tab) => [...dom(tab).querySelectorAll(".task-asking")].map((el) => el.textContent).join("");

describe("the input", () => {
  test("one line that grows: Enter gives the trimmed text, a line break becomes a space, and it has a length limit", () => {
    const said: string[] = [];
    const { el, field } = instructionBox({ label: "Ask or tell the agent…", onSubmit: (t) => said.push(t) });
    expect(field.tagName).toBe("TEXTAREA");
    expect(Number(field.rows)).toBe(1); // the fake DOM keeps it as a string
    expect(field.placeholder).toBe("Ask or tell the agent…");
    expect(field.getAttribute("aria-label")).toBe("Ask or tell the agent…");
    expect(field.maxLength).toBe(MAX_INSTRUCTION);
    field.value = "  make it\nshorter ";
    field.dispatchEvent(new Event("input"));
    expect(field.value).toBe("  make it shorter ");
    key(field, "Enter");
    expect(said).toEqual(["make it shorter"]);
    expect(el.classList.contains("read-only")).toBe(false);
  });
  test("when one is required, Enter with nothing typed shakes and gives nothing; read only, it gives nothing at all", () => {
    const said: string[] = [];
    const need = instructionBox({ label: "x", required: true, onSubmit: (t) => said.push(t) });
    key(need.field, "Enter");
    expect(need.el.classList.contains("task-refused")).toBe(true);
    const shown = instructionBox({ label: "x", initial: "check it", readOnly: true, onSubmit: (t) => said.push(t) });
    expect(shown.field.readOnly).toBe(true);
    expect(shown.el.classList.contains("read-only")).toBe(true);
    key(shown.field, "Enter");
    expect(said).toEqual([]);
  });
});

describe("Cmd+. on a selection", () => {
  test("opens the input under it, keeps the text highlighted, and Enter makes the range with the instruction", () => {
    const { tab } = open("The rollout went well overall.");
    select(tab, "went well overall");
    expect(cmdDot(tab)).toBe(true);
    expect(field()).not.toBeNull();
    expect(document.activeElement).toBe(field());
    expect(asking(tab)).toBe("went well overall");
    expect(tab.markdown).toBe("The rollout went well overall."); // nothing yet
    type(`make it "punchier" -- now`);
    enter();
    expect(field()).toBeNull();
    expect(asking(tab)).toBe("");
    expect(tab.markdown).toMatch(/^The rollout <!-- sel:([a-z0-9]{3,6}) "make it &quot;punchier&quot; -&#45; now" -->went well overall<!-- \/sel:\1 -->\.$/);
    expect(tab.state.selection.empty).toBe(true);
  });

  test("Enter with nothing typed makes the range without one: the text is the task", () => {
    const { tab } = open("List three risks.");
    select(tab, "List three risks");
    cmdDot(tab);
    enter();
    expect(tab.markdown).toMatch(/^<!-- sel:([a-z0-9]{3,6}) -->List three risks<!-- \/sel:\1 -->\.$/);
  });

  test("Escape, or a click elsewhere, makes nothing and gives the selection back", () => {
    const { tab } = open("The rollout went well overall.");
    for (const away of [() => key(field()!, "Escape"), () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))]) {
      select(tab, "went well");
      cmdDot(tab);
      away();
      expect(field()).toBeNull();
      expect(asking(tab)).toBe("");
      expect(tab.markdown).toBe("The rollout went well overall.");
      const { from, to } = tab.state.selection;
      expect(tab.doc.textBetween(from, to)).toBe("went well");
    }
  });

  test("text typed before Enter, elsewhere in the page, doesn't move the range off its text", () => {
    const { tab } = open("First.\n\nThe rollout went well overall.");
    select(tab, "went well");
    cmdDot(tab);
    tab.dispatch(tab.state.tr.insertText("Very ", 1)); // an incoming change above it
    type("shorter");
    enter();
    expect(tab.markdown).toMatch(/^Very First\.\n\nThe rollout <!-- sel:([a-z0-9]{3,6}) "shorter" -->went well<!-- \/sel:\1 --> overall\.$/);
  });

  test("in code, or over text already in a range, it opens nothing and says why under the selection", () => {
    const { tab } = open("Intro <!-- sel:abc -->in a range<!-- /sel:abc --> and `some code`.\n\n```\nconst a = 1;\n```");
    const before = tab.markdown;
    for (const [text, why] of [["const a", "code block"], ["in a range", "already being asked about"], ["some code", "inline code alone"]] as const) {
      select(tab, text);
      expect(cmdDot(tab)).toBe(true);
      expect(field()).toBeNull();
      expect(refusal()).toContain(why);
    }
    expect(tab.markdown).toBe(before);
  });

  test("over text with code spans in it, across list items, it works: the comments go around the code, and stay there once read back", () => {
    const { tab } = open("6. Gives back the chat (`giveBack`) and records `chat_dismissed`.\n7. Tests for `takeAgent` and `pruneFile`.");
    const from = tab.find("Gives").from, to = tab.find("pruneFile").to + 1;
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, from, to)));
    cmdDot(tab);
    type("tighten");
    enter();
    const out = tab.markdown;
    expect(out).toMatch(/^6\. <!-- sel:([a-z0-9]{3,6}) "tighten" -->Gives back .*`chat_dismissed`\.<!-- \/sel:\1 -->\n7\. <!-- sel:\1 -->Tests for `takeAgent` and `pruneFile`\.<!-- \/sel:\1 -->$/);
    // Read back, written again: the same.
    expect(new Tab(new Server(out).src).markdown).toBe(out);
  });

  test("a selection that would put its comments inside inline code says why: one that splits a code span, or code with only spaces around it", () => {
    const { tab } = open("Gives `giveBack` back, then `stop` here.");
    const before = tab.markdown;
    const refused = (from: number, to: number, why: string) => {
      tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, from, to)));
      expect(cmdDot(tab)).toBe(true);
      expect(field()).toBeNull();
      expect(refusal()).toContain(why);
    };
    const code = tab.find("giveBack");
    refused(code.from + 2, tab.find("then").to, "inside inline code"); // starts inside it
    refused(1, code.from + 3, "inside inline code"); // ends inside it
    refused(code.from - 1, code.to + 1, "inline code alone"); // the code and the spaces around it
    expect(tab.markdown).toBe(before);
  });

  test("works from vim's visual mode", async () => {
    const { setVim, vimKey } = await import("../src/app/editor/vim");
    const { tab } = open("hello world");
    setVim(tab.editor, true);
    const press = (k: string) => tab.editor.view.someProp("handleKeyDown", (f) => f(tab.editor.view, new KeyboardEvent("keydown", { key: k, cancelable: true })));
    for (const k of "vllll") press(k);
    expect(vimKey.getState(tab.state)!.mode).toBe("visual");
    cmdDot(tab);
    type("capitalise");
    enter();
    expect(tab.markdown).toMatch(/^<!-- sel:([a-z0-9]{3,6}) "capitalise" -->hello<!-- \/sel:\1 --> world$/);
    setVim(tab.editor, false);
  });
});

describe("a range's instruction, later", () => {
  const loader = (tab: Tab, id: string) => dom(tab).querySelector<HTMLElement>(`.task-range-loader[data-id="${id}"] .task-loader`)!;

  test("waiting: a click on its loader opens it to change, on every piece of the range; emptied, it goes", () => {
    const { tab } = open(`<!-- sel:abc "join these" -->One.<!-- /sel:abc -->\n\n<!-- sel:abc -->Two.<!-- /sel:abc -->`);
    loader(tab, "abc").click();
    expect(field()!.value).toBe("join these");
    expect(field()!.readOnly).toBe(false);
    type("merge these two");
    enter();
    expect(tab.markdown).toBe(`<!-- sel:abc "merge these two" -->One.<!-- /sel:abc -->\n\n<!-- sel:abc -->Two.<!-- /sel:abc -->`);
    const doc = tab.doc;
    tab.dispatch(tab.state.tr.delete(0, doc.firstChild!.nodeSize)); // the first piece goes: the second carries it
    expect(tab.markdown).toBe(`<!-- sel:abc "merge these two" -->Two.<!-- /sel:abc -->`);
    loader(tab, "abc").click();
    type("");
    enter();
    expect(tab.markdown).toBe(`<!-- sel:abc -->Two.<!-- /sel:abc -->`);
  });

  test("being worked on: the instruction shows, read only; without one, the click does nothing", () => {
    const { tab } = open(`A <!-- sel:abc:ack "check it" -->claim<!-- /sel:abc:ack --> and <!-- sel:def:ack -->task<!-- /sel:def:ack -->.`);
    loader(tab, "abc").click();
    expect(field()!.value).toBe("check it");
    expect(field()!.readOnly).toBe(true);
    key(field()!, "Escape");
    loader(tab, "def").click();
    expect(field()).toBeNull();
  });
});

describe("Ask again on a sel suggestion", () => {
  async function suggested(body: string) {
    const { server, tab } = open(body);
    await tab.save(server);
    server.agentRun("abc", `<suggestion mode="replace" place="inline">\nshorter\n</suggestion>`);
    tab.receive(server.src);
    dom(tab).querySelector<HTMLElement>('.sug-preview[data-sug="abc"]')!.click();
    document.querySelector<HTMLButtonElement>('.sug-card [data-decision="asked_again"]')!.click();
    return { server, tab };
  }

  test("opens the input with the old instruction; Enter sends it back to waiting with the new one", async () => {
    const { server, tab } = await suggested(`The <!-- sel:abc "shorten" -->long sentence here<!-- /sel:abc -->.`);
    expect(document.querySelector(".sug-card")).toBeNull();
    expect(field()!.value).toBe("shorten");
    type("shorten, and keep the tone");
    enter();
    expect(tab.markdown).toBe(`The <!-- sel:abc "shorten, and keep the tone" -->long sentence here<!-- /sel:abc -->.`);
    await tab.save(server);
    expect(server.block.tasks?.abc).toMatchObject({ status: "pending", asked_again: 1 });
  });

  test("Escape leaves the suggestion as it was", async () => {
    const { tab } = await suggested(`The <!-- sel:abc "shorten" -->long sentence here<!-- /sel:abc -->.`);
    key(field()!, "Escape");
    expect(tab.markdown).toBe(`The <!-- sel:abc:sug "shorten" -->long sentence here<!-- /sel:abc:sug -->.`);
  });
});
