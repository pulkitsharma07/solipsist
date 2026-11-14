// Marker plugins: the registry's rules, and a contract every plugin passes, the built-in ones and three registered
// here for the test (one with a server half of its own). A new plugin is covered by adding it to `src/plugins/index.ts`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "@tiptap/pm/transform";
import { resetAcks } from "../src/server/put";
import { ackTask, finishRun } from "../src/server/suggest";
import { promptFor } from "../src/server/agent/page";
import { BUILTIN_SERVERS } from "../src/plugins/server";
import { registerTaskTypeServer, taskTypeServer, unregisterTaskTypeServer, type TaskTypeServer } from "../src/server/taskTypes";
import { decide, diffBodies, docToMarkdown, emptyBlock, markdownToDoc, parseFile, markersIn, serializeFile, type Decision } from "../src/shared/docfile";
import { plugins, registerPlugin, targetOf, unregisterPlugin, type TaskTypePlugin } from "../src/shared/plugin";
import { BUILTIN_PLUGINS } from "../src/plugins";
import { Server, Tab } from "./browser-tab";
import { projectDir } from "./project-dir";
import { keyLabel } from "../src/app/keys";

const EXTRA: TaskTypePlugin[] = [
  { taskType: "cite", shape: "range", title: "Citation", keys: ["Mod-j"], phases: { ack: { label: "Finding a source…", indicator: "blink" } } },
  { taskType: "sum-up", shape: "point", title: "Summary", keys: ["Mod-j"], reviewText: "[summary]" },
  { taskType: "quote", shape: "range", title: "Quote", keys: ["Mod-;"] },
];
/**
 * A task type from outside `src/plugins`, with a server half of its own: its own prompt, only `suggest` and `decline`,
 * its suggestion only `after` the text, a check (no "TODO") and a field of its own in the record (`note`).
 */
const QUOTE: TaskTypeServer = {
  taskType: "quote",
  prompt: (ctx) => `Find a quotation that fits the text. (Asked for ${ctx.target.id}; the editable text was ${ctx.text === "" ? "empty" : "set"}.)`,
  tools: ["suggest", "decline"],
  modes: ["after"],
  check: (c) => (c.suggestion?.includes("TODO") ? "A quotation, not a TODO." : null),
  finish: (c) => ({ ...c, note: `Quoted. ${c.note ?? ""}`.trim() }),
};

// Registered before the tests are collected, so `describe.each` below covers them too.
EXTRA.forEach(registerPlugin);
registerTaskTypeServer(QUOTE);
beforeAll(() => GlobalRegistrator.register());
afterAll(() => {
  EXTRA.forEach((p) => unregisterPlugin(p.taskType));
  unregisterTaskTypeServer(QUOTE.taskType);
  GlobalRegistrator.unregister();
});

describe("the registry", () => {
  test("gen, sel and img are built in: a point, a range over text and a range over an image, all on Cmd+.", () => {
    expect(BUILTIN_PLUGINS.map((p) => [p.taskType, targetOf(p), p.keys])).toEqual([["gen", "point", ["Mod-."]], ["sel", "text", ["Mod-."]], ["img", "image", ["Mod-."]]]);
    expect(new Set(BUILTIN_PLUGINS.map((p) => p.taskType)).size).toBe(BUILTIN_PLUGINS.length);
  });

  test("each built-in has a server half: where its suggestion goes, every reply tool, its prompt.md as its kind.* prompt", () => {
    expect(BUILTIN_SERVERS.map((s) => [s.taskType, s.modes, s.tools, !!s.instructions])).toEqual([["gen", ["at"], undefined, true], ["sel", ["replace", "after"], undefined, true], ["img", ["replace"], undefined, true]]);
    // A task type with a browser half only gets the default: a point `at`, a range `after`.
    expect(taskTypeServer("cite")?.modes).toEqual(["after"]);
    expect(taskTypeServer("sum-up")?.modes).toEqual(["at"]);
    expect(taskTypeServer("nope")).toBeUndefined();
  });

  test("a kind must be a short lower-case name", () => {
    for (const kind of ["", "Gen", "1st", "a b", "x".repeat(17), "do:it"]) {
      expect(() => registerPlugin({ taskType: kind, shape: "point", title: "X" })).toThrow();
    }
  });

  test("two plugins that act on the same thing can't share a key; a point, a text range and an image range can", () => {
    expect(() => registerPlugin({ taskType: "clash", shape: "point", title: "X", keys: ["Mod-."] })).toThrow(/gen/);
    expect(plugins().some((p) => p.taskType === "clash")).toBe(false);
    registerPlugin({ taskType: "fine", shape: "point", title: "X", keys: ["Mod-Alt-9"] });
    unregisterPlugin("fine");
  });

  test("a comment of a kind nobody registered is not a placeholder: it stays as written", () => {
    const md = "Text <!-- nope:abc --> and <!-- /cite:abc -->.";
    expect(markersIn(markdownToDoc(md))).toEqual([]);
    expect(docToMarkdown(markdownToDoc(md))).toBe(md); // ordinary HTML comments, kept byte for byte
  });
});

// Read before the fake DOM replaces `navigator`, as ProseMirror's keymap read it when it loaded.
const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
/** Presses a key as written in Tiptap's notation (`Mod-.`), the way the browser would send it: Cmd on a Mac, Ctrl elsewhere. */
function press(tab: Tab, key: string) {
  const parts = key.split("-");
  const mods = new Set(parts.slice(0, -1));
  tab.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: parts.at(-1), metaKey: mods.has("Mod") && mac, ctrlKey: mods.has("Mod") && !mac, bubbles: true, cancelable: true }));
}

test("a range only pairs with a closing comment of its own kind", () => {
  const md = "a <!-- sel:abc -->b<!-- /cite:abc --> c";
  expect(markersIn(markdownToDoc(md))).toEqual([]);
  expect(docToMarkdown(markdownToDoc(md))).toBe(md); // two ordinary comments, as any unpaired one
});

/** What a range of `p` goes around: text, or one image for an image task type (`subject: "image"`). */
const subject = (p: TaskTypePlugin) => (p.subject === "image" ? "![A chart](images/doc/chart.svg)" : "the text");
const forms = (p: TaskTypePlugin, id: string, suffix = "") =>
  p.shape === "point" ? `Before <!-- ${p.taskType}:${id}${suffix} --> after.` : `Before <!-- ${p.taskType}:${id}${suffix} -->${subject(p)}<!-- /${p.taskType}:${id}${suffix} --> after.`;
/** Where the first image of the page is, as a range around it (an image task type's key acts on a selection of one). */
function imageAt(tab: Tab) {
  let at: { from: number; to: number } | null = null;
  tab.doc.descendants((n, pos) => { if (!at && n.type.name === "image") at = { from: pos, to: pos + n.nodeSize }; });
  if (!at) throw new Error("no image in the page");
  return at as { from: number; to: number };
}

describe.each(plugins().map((p) => [p.taskType, p] as const))("the %s plugin", (_kind, p) => {
  test("its comments parse to a placeholder of its kind and write back byte for byte, in every state", () => {
    for (const suffix of ["", ":ack", ":sug", ":done"]) {
      const md = forms(p, "abc", suffix);
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
      expect(markersIn(markdownToDoc(md))).toEqual([{ taskType: p.taskType, id: "abc", state: (suffix.slice(1) || "pending") as never }]);
      // With an instruction: kept, if the task type takes one; otherwise the comment is not a marker.
      const said = md.replace(`${p.taskType}:abc${suffix} -->`, `${p.taskType}:abc${suffix} "say &quot;this&quot;" -->`);
      expect(docToMarkdown(markdownToDoc(said))).toBe(said);
      const takes = (p.instruction ?? "none") !== "none";
      expect(markersIn(markdownToDoc(said))).toEqual(takes ? [{ taskType: p.taskType, id: "abc", state: (suffix.slice(1) || "pending") as never, instruction: 'say "this"' }] : []);
    }
  });

  test("in code it is code text", () => {
    const md = `\`\`\`\n${forms(p, "abc")}\n\`\`\``;
    expect(markersIn(markdownToDoc(md))).toEqual([]);
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });

  test("its key makes one: at a caret for a point, on a selection for a range", () => {
    const server = new Server(`Before ${p.shape === "range" ? subject(p) : "the text"} after.`);
    const tab = new Tab(server.src);
    const at = p.subject === "image" ? imageAt(tab) : tab.find("the text");
    tab.editor.commands.setTextSelection(p.shape === "point" ? at.from : at);
    // A range task type that takes an instruction asks for it first.
    const takes = p.shape === "range" && (p.instruction ?? "none") !== "none";
    for (const key of p.keys ?? []) {
      press(tab, key);
      const field = document.querySelector<HTMLTextAreaElement>(".task-ask textarea");
      expect(!!field).toBe(takes);
      if (field) { field.value = "say this"; field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }
    }
    const found = markersIn(tab.doc);
    expect(found.map((x) => x.taskType)).toEqual(p.keys?.length ? [p.taskType] : []);
    if (!p.keys?.length) return;
    const id = found[0]!.id;
    expect(tab.markdown).toBe(p.shape === "point" ? `Before <!-- ${p.taskType}:${id} -->the text after.` : `Before <!-- ${p.taskType}:${id}${takes ? ' "say this"' : ""} -->${subject(p)}<!-- /${p.taskType}:${id} --> after.`);
  });

  test("a save records it as the writer's; the page follows ack and a reset in place, with its own labels", async () => {
    const server = new Server(forms(p, "abc"));
    const tab = new Tab(server.src);
    await tab.save(server);
    expect(server.block.tasks?.abc).toMatchObject({ type: p.taskType, created_by: "writer", status: "pending" });
    const loader = () => tab.editor.view.dom.querySelector<HTMLElement>(`.task-loader[data-id="abc"]`)!;
    expect(loader().dataset.taskType).toBe(p.taskType);
    expect(loader().title).toBe(p.phases?.pending?.label ?? "Waiting to be picked up");
    server.handEdit((md) => md.replaceAll(`${p.taskType}:abc -->`, `${p.taskType}:abc:ack -->`));
    expect(tab.receive(server.src)).toBe("reloaded");
    expect(loader().dataset.state).toBe("ack");
    expect(loader().title).toBe(p.phases?.ack?.label ?? "Being worked on");
    server.src = resetAcks(server.src)!.file;
    tab.receive(server.src);
    expect(loader().dataset.state).toBe("pending");
    expect(tab.session.getSnapshot().save).toBe("saved");
  });

  test("the agent finishing it (removing it and adding text) merges into the page", async () => {
    const server = new Server(`${forms(p, "abc")}\n\nAnother paragraph.`);
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("Another paragraph.", " Typed.");
    server.handEdit((md) => md.replace(/<!-- \/?[a-z-]+:abc -->/g, "").replace("after.", "after. Done by the agent."));
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toBe(`${p.shape === "point" ? "Before  after." : `Before ${subject(p)} after.`} Done by the agent.\n\nAnother paragraph. Typed.`);
    expect(markersIn(tab.doc)).toEqual([]);
  });

  test("its run's result is a suggestion: acknowledged, then sug with the result in the record; then the writer decides", () => {
    const acked = ackTask(serializeFile(forms(p, "abc"), emptyBlock()), "abc")!;
    expect(acked.taskType).toBe(p.taskType);
    const page = parseFile(acked.file).markdown;
    expect(page).toBe(forms(p, "abc", ":ack"));
    const mode = taskTypeServer(p.taskType)!.modes[0]!;
    const f = finishRun(acked.file, { id: "abc", taskType: p.taskType }, page, { reply: `<suggestion mode="${mode}" place="inline">Result.</suggestion>` });
    expect(f.outcome).toEqual({ done: "suggested" });
    const { markdown, block } = parseFile(f.file!);
    expect(markdown).toBe(forms(p, "abc", ":sug"));
    const record = block.tasks!.abc!;
    expect(record).toMatchObject({ type: p.taskType, status: "suggested", mode, place: "inline", suggestion: "Result." });
    const after = (decision: Decision) => {
      const tr = new Transform(markdownToDoc(markdown));
      expect(decide(tr, "abc", decision, record)).toBe(true);
      return docToMarkdown(tr.doc);
    };
    const accepted = { at: "Before Result. after.", after: `Before ${subject(p)} Result. after.`, replace: "Before Result. after." }[mode];
    expect(after("accepted")).toBe(accepted);
    expect(after("rejected")).toBe(p.shape === "point" ? "Before after." : `Before ${subject(p)} after.`);
    expect(after("asked_again")).toBe(forms(p, "abc"));
  });

  test("the review pane shows it", () => {
    const base = "Before after.";
    const [change] = diffBodies(base, forms(p, "abc"));
    const text = change!.kind === "edited" ? change!.lines.map((l) => ("words" in l ? l.words.map((w) => w.text).join("") : "")).join("\n") : "";
    // The review pane reads the page as text, where an image is `[image <alt>]`.
    expect(text).toContain(p.shape === "point" ? (p.reviewText ?? `[${p.taskType}]`) : p.subject === "image" ? "⟦[image A chart]⟧" : "⟦the text⟧");
  });

  test("the file keeps its record of it", () => {
    const src = serializeFile(forms(p, "abc"), { ...emptyBlock(), tasks: { abc: { type: p.taskType, created_by: "agent", created: "t", status: "pending" } } });
    expect(parseFile(src).block.tasks?.abc?.type).toBe(p.taskType);
  });
});

test("a range and a point plugin on the same key: the caret picks the point, a selection the range", () => {
  const server = new Server("One two three.");
  const tab = new Tab(server.src);
  tab.editor.commands.setTextSelection(tab.find("two"));
  press(tab, "Mod-j");
  tab.editor.commands.setTextSelection(tab.find("three").to);
  press(tab, "Mod-j");
  expect(markersIn(tab.doc).map((x) => x.taskType)).toEqual(["cite", "sum-up"]);
});

// An image request (`img`): the one task type whose key acts on an image rather than on text.
describe("asking about an image", () => {
  const PAGE = "Before ![A chart](images/doc/chart.svg) after.";
  /** A tab on `md` with `at` selected. */
  const on = (md: string, at: (tab: Tab) => { from: number; to: number }) => {
    const tab = new Tab(new Server(md).src);
    tab.editor.commands.setTextSelection(at(tab));
    return tab;
  };
  const say = (text: string) => {
    const field = document.querySelector<HTMLTextAreaElement>(".task-ask textarea")!;
    field.value = text;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  };
  const hint = (tab: Tab) => tab.editor.view.dom.querySelector(".img-hint")?.textContent ?? null;
  const ring = (tab: Tab) => !!tab.editor.view.dom.querySelector("img.img-target");

  test("the page says over a selected image that the key is there; not over text, and not over two images", () => {
    const image = on(PAGE, imageAt);
    expect(hint(image)).toBe(`Change this image${keyLabel("Mod-.")}`);
    expect(ring(image)).toBe(true);
    const text = on(PAGE, (tab) => tab.find("Before"));
    expect(hint(text)).toBe(null);
    const both = on("![A](a.svg)![B](b.svg)", (tab) => ({ from: 0, to: tab.doc.content.size }));
    expect(hint(both)).toBe(null);
  });

  test("in vim's normal mode the caret on an image is enough: the overlay shows and ⌘. asks", async () => {
    const { setVim } = await import("../src/app/editor/vim");
    const tab = on(PAGE, (tab) => ({ from: imageAt(tab).from, to: imageAt(tab).from }));
    setVim(tab.editor, true);
    tab.editor.commands.setTextSelection(imageAt(tab).from);
    expect(hint(tab)).toBe(`Change this image${keyLabel("Mod-.")}`);
    press(tab, "Mod-.");
    say("make it bigger");
    expect(markersIn(tab.doc).map((x) => x.taskType)).toEqual(["img"]);
    setVim(tab.editor, false);
  });

  test("⌘. on it asks what to change and makes an img range around the image alone", () => {
    const tab = on(PAGE, imageAt);
    press(tab, "Mod-.");
    say("make the bars horizontal");
    expect(tab.markdown).toBe(`Before <!-- img:${markersIn(tab.doc)[0]!.id} "make the bars horizontal" -->![A chart](images/doc/chart.svg)<!-- /img:${markersIn(tab.doc)[0]!.id} --> after.`);
    expect(markersIn(tab.doc).map((x) => x.taskType)).toEqual(["img"]);
  });

  test("an instruction is required: Enter with nothing typed makes nothing", () => {
    const tab = on(PAGE, imageAt);
    press(tab, "Mod-.");
    say("");
    expect(markersIn(tab.doc)).toEqual([]);
    expect(document.querySelector(".task-ask")).not.toBe(null); // still open, after the shake
    document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  });

  test("a selection of text that happens to hold an image is still a request about the text", () => {
    const tab = on(PAGE, (tab) => ({ from: tab.find("Before").from, to: tab.find(" after.").to }));
    press(tab, "Mod-.");
    say("tighten this");
    // One range, listed once per piece it covers (the text, the image, the text).
    expect([...new Set(markersIn(tab.doc).map((x) => x.taskType))]).toEqual(["sel"]);
    expect(tab.markdown).toContain("-->Before ![A chart](images/doc/chart.svg) after.<!--");
  });

  test("an image already being asked about says so instead of being asked about twice", () => {
    const tab = on(`Before <!-- img:abc "redraw it" -->![A chart](images/doc/chart.svg)<!-- /img:abc --> after.`, imageAt);
    expect(hint(tab)).toBe(null);
    press(tab, "Mod-.");
    expect(document.querySelector(".task-refusal")?.textContent).toContain("already being asked about");
    expect(markersIn(tab.doc).map((x) => x.id)).toEqual(["abc"]);
    document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  });
});

// A task type added from outside `src/plugins`, both halves, through the whole cycle: the writer's key, a save, the
// run's prompt, its reply checked by the task type's own rules, the record it writes, and the writer's decision.
describe("a task type registered from outside with its own server half", () => {
  test("its key, its prompt, its rules on the reply and its record, then the writer accepts", async () => {
    const server = new Server("Before the text after.");
    const tab = new Tab(server.src);
    tab.editor.commands.setTextSelection(tab.find("the text"));
    press(tab, "Mod-;");
    const [made] = markersIn(tab.doc);
    expect(made?.taskType).toBe("quote");
    const id = made!.id;
    await tab.save(server);
    expect(server.block.tasks?.[id]).toMatchObject({ type: "quote", created_by: "writer", status: "pending" });

    // The run's prompt carries the task type's own words, from its `prompt`.
    const P = projectDir("quote-");
    const dir = P.docs;
    P.enter();
    try {
      writeFileSync(join(dir, "pg.md"), server.src);
      expect(promptFor("pg", { id, taskType: "quote" })).toContain(`<task-type name="quote" shape="range">\nFind a quotation that fits the text. (Asked for ${id}; the editable text was empty.)\n</task-type>`);
    } finally {
      P.done();
    }

    const acked = ackTask(server.src, id)!;
    const page = parseFile(acked.file).markdown;
    const run = (reply: string) => finishRun(acked.file, { id, taskType: "quote" }, page, { reply });
    // Its rules: no answer, nothing but `after`, and its own check; each fails the run as any bad reply does.
    expect(run("<answer>It means this.</answer>").outcome).toMatchObject({ done: "failed", error: expect.stringContaining("takes no answer") });
    expect(run('<suggestion mode="replace" place="inline">x</suggestion>').outcome).toMatchObject({ done: "failed", error: expect.stringContaining('mode="after"') });
    expect(run('<suggestion mode="after" place="inline">TODO</suggestion>').outcome).toMatchObject({ done: "failed", error: "A quotation, not a TODO." });
    expect(run("<decline>None fits.</decline>").outcome).toEqual({ done: "declined" });

    const f = run('<suggestion mode="after" place="inline">"Brevity is the soul of wit."</suggestion><note>Shakespeare.</note>');
    expect(f.outcome).toEqual({ done: "suggested" });
    const { markdown, block } = parseFile(f.file!);
    const record = block.tasks![id]!;
    expect(record).toMatchObject({ type: "quote", status: "suggested", mode: "after", place: "inline", suggestion: '"Brevity is the soul of wit."', note: "Quoted. Shakespeare." });
    const tr = new Transform(markdownToDoc(markdown));
    expect(decide(tr, id, "accepted", record)).toBe(true);
    expect(docToMarkdown(tr.doc)).toBe('Before the text "Brevity is the soul of wit." after.');
  });
});
