// Accept as a Button: the marker stays around the result at `:btn`, a press sends it
// back to pending, and a re-run's result goes straight into the page.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { Transform } from "@tiptap/pm/transform";
import { commentFor, decide, docToMarkdown, markdownToDoc, markerComments, markerSpots, markersIn, parseFile, pressButton, removeButton, schema, serializeFile, taskStates, whyNoButton, emptyBlock, type TaskRecord } from "../src/shared/docfile";
import { applyPut, pruneFile } from "../src/server/put";
import { ackTask, checkRunReply, finishRun, suggestFromTaskChat } from "../src/server/suggest";

const act = (md: string, f: (tr: Transform) => unknown) => {
  const tr = new Transform(markdownToDoc(md));
  f(tr);
  tr.doc.check();
  const out = docToMarkdown(tr.doc);
  expect(docToMarkdown(markdownToDoc(out))).toBe(out); // reads back as itself
  return out;
};
const accept = (md: string, record: Pick<TaskRecord, "mode" | "place" | "suggestion">) => act(md, (tr) => expect(decide(tr, "rrr", "button", record)).toBe(true));
const sug = (text: string, instruction = "") => `<!-- sel:rrr:sug${instruction && ` "${instruction}"`} -->${text}<!-- /sel:rrr:sug -->`;
const btn = (text: string, instruction = "") => `<!-- sel:rrr:btn${instruction && ` "${instruction}"`} -->${text}<!-- /sel:rrr:btn -->`;
const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";
const BUTTON = { at: "2026-11-10T00:00:00.000Z" };

describe("the comment", () => {
  test("`:btn` is a state, with or without an instruction, and reads back byte for byte", () => {
    for (const md of [btn("kept"), btn("kept", "shorter")]) expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    expect(taskStates(btn("kept")).get("rrr")).toBe("btn");
    expect(markersIn(markdownToDoc(btn("kept", "shorter")))).toEqual([{ taskType: "sel", id: "rrr", state: "btn", instruction: "shorter" }]);
  });
  test("a `:btn` is not waiting for an agent", () => {
    expect(markerComments(btn("kept")).every((c) => c.state === "btn")).toBe(true);
    expect(commentFor("s", "sel", "rrr", "btn", "x")).toBe('<!-- sel:rrr:btn "x" -->');
  });
});

describe("accepting as a button", () => {
  const CASES: [string, string, Pick<TaskRecord, "mode" | "place" | "suggestion">, string][] = [
    ["replace, inline: the marker is on the new text, the instruction kept", `Intro. ${sug("Old.", "x")} Next.`, { mode: "replace", place: "inline", suggestion: "New **bold** end." }, `Intro. ${btn("New **bold** end.", "x")} Next.`],
    ["after, inline: the marker moves to the result, the space is outside it", `Check ${sug("end")} here.`, { mode: "after", place: "inline", suggestion: "(30 Sept)" }, `Check end ${btn("(30 Sept)")} here.`],
    ["after, inline, at the end of the page", sug("The time is"), { mode: "after", place: "inline", suggestion: "half past three" }, `The time is ${btn("half past three")}`],
    ["after, blocks: each item holds a piece, the request is plain", `${sug("List")}\n\nNext.`, { mode: "after", place: "blocks", suggestion: "- a\n- b" }, `List\n\n- ${btn("a")}\n- ${btn("b")}\n\nNext.`],
    ["replace, a whole paragraph by two", `A\n\n${sug("Whole.")}\n\nZ`, { mode: "replace", place: "blocks", suggestion: "One.\n\nTwo." }, `A\n\n${btn("One.")}\n\n${btn("Two.")}\n\nZ`],
    ["replace, list items stay in their list", `1. ${sug("one")}\n2. ${sug("two")}\n3. three`, { mode: "replace", place: "blocks", suggestion: "1. x\n2. y" }, `1. ${btn("x")}\n2. ${btn("y")}\n3. three`],
  ];
  test.each(CASES)("%s", (_what, page, record, want) => expect(accept(page, record)).toBe(want));

  test("a re-run replaces everything the button holds", () => {
    const AGAIN = { button: BUTTON };
    expect(act(`List\n\n- ${btn("a")}\n- ${btn("b")}\n\nNext.`, (tr) => decide(tr, "rrr", "accepted", { ...AGAIN, mode: "replace", place: "blocks", suggestion: "- c" }))).toBe(`List\n\n- ${btn("c")}\n\nNext.`);
    expect(act(`${btn("One.")}\n\n\`\`\`\ncode\n\`\`\`\n\n${btn("Two.")}\n\nZ`, (tr) => decide(tr, "rrr", "accepted", { ...AGAIN, mode: "replace", place: "inline", suggestion: "Fresh." }))).toBe(`${btn("Fresh.")}\n\nZ`);
  });
  test("a re-run over a table takes the whole table's place", () => {
    const table = accept(`${sug("T")}\n\nNext.`, { mode: "after", place: "blocks", suggestion: TABLE });
    expect(act(table, (tr) => decide(tr, "rrr", "accepted", { button: BUTTON, mode: "replace", place: "blocks", suggestion: "| x |\n| --- |\n| 9 |" }))).toBe(`T\n\n| ${btn("x")} |\n| --- |\n| ${btn("9")} |\n\nNext.`);
    expect(act(table, (tr) => decide(tr, "rrr", "accepted", { button: BUTTON, mode: "replace", place: "inline", suggestion: "Fresh." }))).toBe(`T\n\n${btn("Fresh.")}\n\nNext.`);
  });
  test("with a button, turning a result down keeps the text and the button", () => {
    expect(act(sug("Kept."), (tr) => decide(tr, "rrr", "rejected", { button: BUTTON, mode: "replace", place: "inline", suggestion: "No." }))).toBe(btn("Kept."));
    expect(act(sug("Kept."), (tr) => decide(tr, "rrr", "accepted", { button: BUTTON }))).toBe(btn("Kept."));
  });
  test("a press goes back to pending, with a new instruction if given; removing it leaves the text", () => {
    expect(act(btn("T", "x"), (tr) => pressButton(tr, "rrr"))).toBe('<!-- sel:rrr "x" -->T<!-- /sel:rrr -->');
    expect(act(btn("T", "x"), (tr) => pressButton(tr, "rrr", "y"))).toBe('<!-- sel:rrr "y" -->T<!-- /sel:rrr -->');
    expect(act(btn("T", "x"), (tr) => pressButton(tr, "rrr", null))).toBe("<!-- sel:rrr -->T<!-- /sel:rrr -->");
    expect(act(`A ${btn("T")} B`, (tr) => removeButton(tr, "rrr"))).toBe("A T B");
  });
});

describe("what can be kept as a button", () => {
  const no = (suggestion: string | undefined, edits?: TaskRecord["edits"]) => whyNoButton(schema, { suggestion, edits });
  test.each(["Text.", "**Bold** text.", "`code` first and `last`", "- a\n- b", TABLE, "One.\n\n```\ncode\n```\n\nTwo."])("%j can", (p) => expect(no(p)).toBeNull());
  test.each(["", "```\ncode\n```", "Text.\n\n```\ncode\n```", "```\ncode\n```\n\nText.", "Text.\n\n---", "<!-- gen:abc --> and text"])("%j can't", (p) => expect(no(p)).toEqual(expect.any(String)));
  test("nor one that changes other blocks", () => expect(no("Text.", [{ before: "A", after: "B" }])).toEqual(expect.any(String)));
});

describe("the record", () => {
  const AT = new Date("2026-11-10T10:00:00.000Z");
  const LATER = new Date("2026-11-10T10:00:05.000Z");
  const record: TaskRecord = { type: "sel", created_by: "writer", created: "2026-11-10T09:00:00.000Z", status: "suggested", mode: "replace", place: "inline", suggestion: "New.", saw: "Old.", agent: { engine: "pi", model: "m", session: "s" } };
  const file = (body: string, r: TaskRecord) => serializeFile(body, { ...emptyBlock(), tasks: { rrr: r } });
  const put = (src: string, markdown: string, decisions: Record<string, any>, now = AT) => {
    const r = applyPut(src, { client_id: "tab", base_rev: parseFile(src).block.meta.rev, markdown, comments: {}, decisions }, now);
    if (!r.ok) throw new Error("refused");
    return r.file;
  };
  const rec = (src: string) => parseFile(src).block.tasks!.rrr!;

  test("Accept as a Button: status, the button, and the agent kept", () => {
    expect(rec(put(file(sug("Old."), record), btn("New."), { rrr: "button" }))).toMatchObject({ status: "button", button: { at: AT.toISOString() }, reviewed: AT.toISOString(), agent: record.agent });
  });
  test("an Undo of that decision: waiting again, and no button", () => {
    const made = put(file(sug("Old."), record), btn("New."), { rrr: "button" });
    const back = rec(put(made, sug("Old."), {}, LATER));
    expect(back).toMatchObject({ status: "suggested", suggestion: "New." });
    expect(back.button).toBeUndefined();
  });
  test("a press: pending, counted, and the accepted text not offered as turned down", () => {
    const made = put(file(sug("Old."), record), btn("New."), { rrr: "button" });
    const pressed = rec(put(made, "<!-- sel:rrr -->New.<!-- /sel:rrr -->", { rrr: "asked_again" }, LATER));
    expect(pressed).toMatchObject({ status: "pending", asked_again: 1, button: { at: AT.toISOString() } });
    expect(pressed.suggestion).toBeUndefined();
  });
  test("an Undo of a press: the button is back", () => {
    const pressed = file("<!-- sel:rrr -->New.<!-- /sel:rrr -->", { ...record, status: "pending", button: BUTTON });
    expect(rec(put(pressed, btn("New."), {}, LATER)).status).toBe("button");
  });
  test("the button removed, or its text deleted: accepted; and an Undo brings it back", () => {
    const made = put(file(sug("Old."), record), btn("New."), { rrr: "button" });
    const gone = put(made, "New.", {}, LATER);
    expect(rec(gone).status).toBe("accepted");
    expect(rec(put(gone, btn("New."), {}, new Date(LATER.getTime() + 1))).status).toBe("button");
  });
  test("cleaning up drops the old proposal and keeps the button", () => {
    const made = put(file(sug("Old."), record), btn("New."), { rrr: "button" });
    const pruned = pruneFile(made, new Date(AT.getTime() + 60_000), 30_000)!;
    expect(rec(pruned.file).suggestion).toBeUndefined();
    expect(rec(pruned.file).button).toEqual({ at: AT.toISOString() });
  });

  // ---- a re-run
  const pending = (body: string, extra: Partial<TaskRecord> = {}) => {
    const { mode: _m, place: _p, suggestion: _x, saw: _s, ...r } = record;
    const a = ackTask(file(body, { ...r, status: "pending", button: BUTTON, ...extra }), "rrr", AT)!;
    return { src: a.file, page: parseFile(a.file).markdown };
  };
  const body = (src: string) => parseFile(src).markdown;
  const replace = (text: string) => `<suggestion mode="replace" place="inline">\n${text}\n</suggestion>\n<note>Done.</note>`;
  const target = { id: "rrr", taskType: "sel" };

  test("its result goes straight into the page, and the button comes back", () => {
    const { src, page } = pending("Time: <!-- sel:rrr \"now\" -->three<!-- /sel:rrr -->.");
    const r = finishRun(src, target, page, { reply: replace("four"), agent: { engine: "pi", model: "m", session: "s2" } }, LATER);
    expect(r.outcome).toEqual({ done: "applied" });
    expect(body(r.file!)).toBe(`Time: ${btn("four", "now")}.`);
    const after = rec(r.file!);
    expect(after).toMatchObject({ status: "button", note: "Done.", finished: LATER.toISOString(), agent: { session: "s2" } });
    expect(after.suggestion).toBeUndefined();
    expect(parseFile(r.file!).block.meta.body_by).toBe("server");
  });
  test("what is around it, including other tasks' states, stays as it was", () => {
    const rest = "# Head\n\n- [ ] a task\n\n<!-- gen:ppp:sug -->\n\n| a |\n| --- |\n| 1 |";
    const { src, page } = pending(`Before.\n\n<!-- sel:rrr -->three<!-- /sel:rrr -->\n\n${rest}`);
    expect(body(finishRun(src, target, page, { reply: replace("four") }, LATER).file!)).toBe(`Before.\n\n${btn("four")}\n\n${rest}`);
  });
  test("every fixture stays byte for byte around it, or waits for the writer", () => {
    for (const name of readdirSync("test/fixtures").filter((f) => f.endsWith(".md"))) {
      const md = parseFile(readFileSync(`test/fixtures/${name}`, "utf8")).markdown;
      const canonical = docToMarkdown(markdownToDoc(md));
      const { src, page } = pending(`${canonical}\n\n<!-- sel:rrr -->three<!-- /sel:rrr -->`);
      const out = body(finishRun(src, target, page, { reply: replace("four") }, LATER).file!);
      expect(out).toBe(`${canonical}\n\n${btn("four")}`);
    }
  });
  test("a page not as the page would write it waits for the writer, rather than being rewritten", () => {
    const { src, page } = pending("* star list\n\n<!-- sel:rrr -->three<!-- /sel:rrr -->");
    const r = finishRun(src, target, page, { reply: replace("four") }, LATER);
    expect(r.outcome).toEqual({ done: "suggested" });
    expect(body(r.file!)).toContain("* star list");
  });
  test("text the writer changed during the run is not overwritten: it waits as a diff", () => {
    const { src, page } = pending("<!-- sel:rrr -->three<!-- /sel:rrr -->");
    const typed = src.replace("three", "three and a bit");
    const r = finishRun(typed, target, page, { reply: replace("four") }, LATER);
    expect(r.outcome).toEqual({ done: "suggested" });
    expect(body(r.file!)).toBe("<!-- sel:rrr:sug -->three and a bit<!-- /sel:rrr:sug -->");
    expect(rec(r.file!)).toMatchObject({ status: "suggested", suggestion: "four", button: BUTTON });
  });
  test("a decline or an answer waits on its card, the button remembered", () => {
    for (const [reply, status] of [["<decline>Nothing to do.</decline>", "declined"], ["<answer>It is four.</answer>", "suggested"]] as const) {
      const { src, page } = pending("<!-- sel:rrr -->three<!-- /sel:rrr -->");
      const r = finishRun(src, target, page, { reply }, LATER);
      expect(body(r.file!)).toBe(sug("three"));
      expect(rec(r.file!)).toMatchObject({ status, button: BUTTON });
    }
  });
  test.each([
    ["after", { kind: "suggestion", mode: "after", place: "inline", suggestion: "x" }],
    ["empty", { kind: "suggestion", mode: "replace", place: "inline", suggestion: "" }],
    ["edits", { kind: "suggestion", mode: "replace", place: "inline", suggestion: "x", edits: [{ before: "Other.", after: "Changed." }] }],
    ["code at the end", { kind: "suggestion", mode: "replace", place: "blocks", suggestion: "x\n\n```\ncode\n```" }],
  ] as const)("a reply it can't apply unseen is an error the agent can fix: %s", (_what, reply) => {
    const { src, page } = pending("<!-- sel:rrr -->three<!-- /sel:rrr -->\n\nOther.");
    expect(checkRunReply(src, target, page, reply as any)).toEqual(expect.any(String));
  });
  test("asked again as a button: a reply that changes other blocks, or goes nowhere, goes back to the agent; one in place passes", () => {
    const a = ackTask(file("<!-- sel:rrr -->three<!-- /sel:rrr -->\n\nOther.", { ...record, status: "pending", wants_button: true }), "rrr", AT)!;
    const page = parseFile(a.file).markdown;
    expect(checkRunReply(a.file, target, page, { kind: "suggestion", edits: [{ before: "Other.", after: "Changed." }] })).toContain("asked for a result they can keep as a button");
    expect(checkRunReply(a.file, target, page, { kind: "suggestion", mode: "replace", place: "inline", suggestion: "x", edits: [{ before: "Other.", after: "Changed." }] })).toContain("other parts of the page");
    expect(checkRunReply(a.file, target, page, { kind: "suggestion", mode: "after", place: "inline", suggestion: "four" })).toBeNull();
    expect(checkRunReply(a.file, target, page, { kind: "answer", answer: "It is four." })).toBeNull();
    // It ends as a suggestion for the writer, as any run of a task without a button yet.
    expect(finishRun(a.file, target, page, { reply: replace("four") }, LATER).outcome).toEqual({ done: "suggested" });
  });

  test("a task without a button still ends as a suggestion", () => {
    const a = ackTask(file("<!-- sel:rrr -->three<!-- /sel:rrr -->", { ...record, status: "pending" }), "rrr", AT)!;
    expect(finishRun(a.file, target, parseFile(a.file).markdown, { reply: replace("four") }, LATER).outcome).toEqual({ done: "suggested" });
  });
  test("markerSpots finds a button's pieces", () => {
    expect(markerSpots(markdownToDoc(`${btn("a")}\n\n${btn("b")}`), "rrr")!.pieces).toHaveLength(2);
  });
});

describe("a chat about a request already decided", () => {
  const rec: TaskRecord = { type: "sel", created_by: "writer", created: "2026-11-10T09:00:00.000Z", status: "accepted", agent: { engine: "pi", model: "m", session: "s" } };
  const target = { id: "rrr", taskType: "sel" };
  const page = "Three openings:\n\n| Role |\n| --- |\n| UX |\n\nFive more:\n\n| Role |\n| --- |\n| UI |";
  const src = serializeFile(page, { ...emptyBlock(), tasks: { rrr: rec } });
  const merge = { kind: "suggestion" as const, edits: [{ before: "Three openings:\n\n| Role |\n| --- |\n| UX |\n\nFive more:\n\n| Role |\n| --- |\n| UI |", after: "Eight openings:\n\n| Role |\n| --- |\n| UX |\n| UI |" }] };

  test("its marker gone (accepted): changes to other blocks become a new suggestion on the page, not nothing", () => {
    const r = suggestFromTaskChat(src, target, merge, new Date("2026-11-10T10:00:00.000Z"), () => 0.5);
    expect(r.error).toBeUndefined();
    expect(r.created).toBe(true);
    const out = parseFile(r.file!);
    const made = [...taskStates(out.markdown)].find(([id]) => id !== "rrr")!;
    expect(made[1]).toBe("sug");
    expect(out.block.tasks![made[0]]!.edits).toHaveLength(1);
    expect(out.block.tasks!.rrr).toEqual(rec); // the decided one stays as it was
  });
  test("a result for its range can't go anywhere: an error the agent can act on in the same turn", () => {
    const r = suggestFromTaskChat(src, target, { kind: "suggestion", mode: "replace", place: "inline", suggestion: "x" });
    expect(r.error).toContain("no longer waiting");
    expect(r.file).toBeUndefined();
  });
  test("an answer is conversation: nothing changes", () => {
    expect(suggestFromTaskChat(src, target, { kind: "answer", answer: "Sure." })).toEqual({});
  });
  test("while its suggestion waits, a reply still replaces the card's", () => {
    const waiting = serializeFile(`A ${sug("old")} B`, { ...emptyBlock(), tasks: { rrr: { ...rec, status: "suggested", mode: "replace", place: "inline", suggestion: "new" } } });
    const r = suggestFromTaskChat(waiting, target, { kind: "suggestion", mode: "replace", place: "inline", suggestion: "newer" });
    expect(r.created).toBeUndefined();
    expect(parseFile(r.file!).block.tasks!.rrr!.suggestion).toBe("newer");
  });
  test("why a result that only changes other blocks can't be a button says so", () => {
    // One reason per case, in what the writer can see, around the one rule: a button rewrites only its own text.
    expect(whyNoButton(schema, { edits: [{ before: "A", after: "B" }] })).toBe("It also changes other parts of the page (struck through in red). A button can only rewrite its own text.");
    expect(whyNoButton(schema, { suggestion: "Title", edits: [{ before: "A", after: "B" }] })).toBe("It also changes other parts of the page (struck through in red). A button can only rewrite its own text.");
    expect(whyNoButton(schema, { suggestion: "" })).toBe("It deletes the text, so there would be nothing for a button to rewrite.");
    expect(whyNoButton(schema, { suggestion: "A <!-- gen:abc --> b" })).toBe("It contains new requests of its own, which a button can't hold.");
    expect(whyNoButton(schema, { suggestion: "```\ncode\n```" })).toBe("It starts or ends with a code block, which a button can't hold.");
  });
});

describe("a button's schedule", () => {
  const { scheduleButton } = require("../src/server/suggest") as typeof import("../src/server/suggest");
  const { nextRunAt, BUTTON_EVERY, everyLabel } = require("../src/shared/docfile") as typeof import("../src/shared/docfile");
  const AT = new Date("2026-11-10T10:00:00.000Z");
  const rec: TaskRecord = { type: "sel", created_by: "writer", created: "2026-11-10T09:00:00.000Z", status: "button", finished: "2026-11-10T09:30:00.000Z", button: { at: "2026-11-10T09:40:00.000Z" } };
  const src = serializeFile(btn("three o'clock", "add the time"), { ...emptyBlock(), tasks: { rrr: rec } });

  test("set: kept on the button's record, from now; the body untouched", () => {
    const out = parseFile(scheduleButton(src, "rrr", 300_000, AT).file!);
    expect(out.block.tasks!.rrr!.button).toEqual({ at: rec.button!.at, every: 300_000, from: AT.toISOString() });
    expect(out.markdown).toBe(btn("three o'clock", "add the time"));
    expect(nextRunAt(out.block.tasks!.rrr!)).toBe(AT.getTime() + 300_000);
  });
  test("off: the schedule goes, the button stays", () => {
    const on = scheduleButton(src, "rrr", 60_000, AT).file!;
    expect(parseFile(scheduleButton(on, "rrr", null, AT).file!).block.tasks!.rrr!.button).toEqual({ at: rec.button!.at });
  });
  test("only one of the offered intervals, and only on a button", () => {
    expect(scheduleButton(src, "rrr", 1000, AT).error).toContain("every must be one of");
    expect(scheduleButton(src, "zzz", 60_000, AT).error).toBe("That request has no button.");
    const plain = serializeFile("text", { ...emptyBlock(), tasks: { rrr: { ...rec, button: undefined } } });
    expect(scheduleButton(plain, "rrr", 60_000, AT).error).toBe("That request has no button.");
  });
  test("it next runs one interval after its last run, its button, or the schedule being set, whichever is latest", () => {
    expect(nextRunAt({ ...rec, button: { ...rec.button!, every: 60_000 } })).toBe(Date.parse(rec.button!.at) + 60_000);
    expect(nextRunAt({ ...rec, finished: "2026-11-10T11:00:00.000Z", button: { ...rec.button!, every: 60_000 } })).toBe(Date.parse("2026-11-10T11:00:00.000Z") + 60_000);
    expect(nextRunAt(rec)).toBeNull();
  });
  test("the intervals in words", () => {
    expect(BUTTON_EVERY.map(everyLabel)).toEqual(["every minute", "every 5 minutes", "every 15 minutes", "every hour", "every day"]);
  });
});

