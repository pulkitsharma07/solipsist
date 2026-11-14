// A run's reply as a suggestion: the envelope, the checks, the ack and the write into the record (`src/server/suggest.ts`).
import { describe, expect, test } from "bun:test";
import { ackTask, checkReply, finishRun, parseReply, type Reply } from "../src/server/suggest";
import { config } from "../src/server/config";
import { emptyBlock, parseFile, serializeFile, type TaskRecord } from "../src/shared/docfile";

const NOW = new Date("2026-10-27T10:00:00.000Z");
const sug = (text: string, mode: "at" | "replace" | "after" = "at", place: "inline" | "blocks" = "inline"): Reply => ({ kind: "suggestion", mode, place, suggestion: text });
const gen = { id: "abc", taskType: "gen" };
const sel = { id: "abc", taskType: "sel" };

describe("parseReply", () => {
  test("a suggestion with its note, the markdown taken raw between the tags", () => {
    expect(parseReply('Did it.\n\n<suggestion mode="at" place="blocks">\n| a | b |\n| - | - |\n</suggestion>\n<note>A table.</note>'))
      .toEqual({ kind: "suggestion", mode: "at", place: "blocks", suggestion: "| a | b |\n| - | - |", note: "A table." });
  });

  test("an empty one (a deletion) and one on a single line", () => {
    expect(parseReply('<suggestion mode="replace" place="inline"></suggestion>')).toMatchObject({ suggestion: "" });
    expect(parseReply('<suggestion mode="at" place="inline">(30 Sep)</suggestion>')).toMatchObject({ suggestion: "(30 Sep)" });
  });

  test("the last envelope counts, so a draft quoted earlier doesn't", () => {
    const r = parseReply('First try:\n<suggestion mode="at" place="inline">draft</suggestion>\nBetter:\n<suggestion mode="at" place="inline">final</suggestion>');
    expect(r).toMatchObject({ suggestion: "final" });
  });

  test("a decline", () => {
    expect(parseReply("Can't.\n<decline>No heading, nothing around it.</decline>")).toEqual({ kind: "decline", note: "No heading, nothing around it." });
  });

  test("an answer to a question: on its own, with a note if there is one", () => {
    expect(parseReply("Looked.\n<answer>\nYes, except the **freeze**.\n</answer>\n<note>Checked the dates.</note>")).toEqual({ kind: "answer", answer: "Yes, except the **freeze**.", note: "Checked the dates." });
    expect(parseReply('<answer>Yes.</answer><suggestion mode="after" place="inline">x</suggestion>')).toMatchObject({ error: expect.stringContaining("alone") });
    expect(parseReply("<answer>Yes.</answer><decline>no</decline>")).toMatchObject({ error: expect.stringContaining("alone") });
    expect(parseReply("<answer> </answer>")).toMatchObject({ error: expect.stringContaining("empty") });
  });

  test("what can't be used, and why", () => {
    expect(parseReply("ok")).toEqual({ error: "The reply has no <suggestion>, <edit>, <answer> or <decline>." });
    expect(parseReply('<suggestion mode="at" place="inline">x</suggestion><decline>no</decline>')).toMatchObject({ error: expect.stringContaining("both") });
    expect(parseReply("<decline> </decline>")).toMatchObject({ error: expect.stringContaining("no reason") });
    expect(parseReply('<suggestion mode="sideways" place="inline">x</suggestion>')).toMatchObject({ error: expect.any(String) });
    expect(parseReply('<suggestion mode="at">x</suggestion>')).toMatchObject({ error: expect.any(String) });
  });
});

describe("checkReply", () => {
  const POINT_MID = "The deadline is end of Q3 <!-- gen:abc:ack --> for all teams.";
  const POINT_ALONE = "# Plan\n\n<!-- gen:abc:ack -->\n\nAfter.";
  const RANGE_MID = "Check <!-- sel:abc:ack -->end of Q3<!-- /sel:abc:ack --> here.";
  const RANGE_WHOLE = "<!-- sel:abc:ack -->List three risks<!-- /sel:abc:ack -->\n\nNext.";

  test("a point's suggestion goes at it; the markdown is stored canonical", () => {
    expect(checkReply(sug("(30 _September_)"), POINT_MID, gen, [])).toEqual({ status: "suggested", mode: "at", place: "inline", suggestion: "(30 *September*)" });
  });

  test("the mode must be one the kind allows: at for a point, after or replace for sel", () => {
    expect(checkReply(sug("x", "after"), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining('mode="at"') });
    expect(checkReply(sug("x", "at"), RANGE_MID, sel, [])).toMatchObject({ error: expect.stringContaining('mode="replace" or mode="after"') });
    expect(checkReply(sug("x", "replace"), RANGE_MID, sel, [])).toMatchObject({ status: "suggested", mode: "replace" });
    expect(checkReply(sug("x", "after"), RANGE_MID, sel, [])).toMatchObject({ status: "suggested", mode: "after" });
  });

  test("a range's text as the run read it is kept, to tell later whether it changed", () => {
    expect(checkReply(sug("(30 Sep)", "after"), RANGE_MID, sel, [])).toMatchObject({ saw: "end of Q3" });
    const two = "<!-- sel:abc:ack -->One.<!-- /sel:abc:ack -->\n\n<!-- sel:abc:ack -->Two.<!-- /sel:abc:ack -->";
    expect(checkReply(sug("x", "after"), two, sel, [])).toMatchObject({ saw: "One.\n\nTwo." });
    expect(checkReply(sug("x"), POINT_MID, gen, [])).not.toHaveProperty("saw");
  });

  test("where it goes follows what fits: one paragraph mid-line is inline, blocks where the spot takes them", () => {
    // blocks asked for, but it's one paragraph mid-line: inline
    expect(checkReply(sug("A few words.", "at", "blocks"), POINT_MID, gen, [])).toMatchObject({ place: "inline" });
    // inline asked for, but it's a list, and the marker is alone on its line: blocks
    expect(checkReply(sug("- a\n- b"), POINT_ALONE, gen, [])).toMatchObject({ place: "blocks", suggestion: "- a\n- b" });
    // one paragraph alone on its line may be either: as asked
    expect(checkReply(sug("A paragraph.", "at", "blocks"), POINT_ALONE, gen, [])).toMatchObject({ place: "blocks" });
    expect(checkReply(sug("A paragraph."), POINT_ALONE, gen, [])).toMatchObject({ place: "inline" });
    // after a range: blocks go after its block, wherever the range is
    expect(checkReply(sug("- a\n- b", "after"), RANGE_MID, sel, [])).toMatchObject({ place: "blocks" });
    expect(checkReply(sug("- a\n- b", "after"), RANGE_WHOLE, sel, [])).toMatchObject({ place: "blocks" });
  });

  test("blocks that don't fit (a list mid-line) are refused", () => {
    expect(checkReply(sug("- a\n- b"), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("inside a line") });
  });

  test("empty is a deletion, so only for replace; otherwise it is a decline", () => {
    expect(checkReply(sug(""), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("decline") });
    expect(checkReply(sug("  \n"), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("decline") });
  });

  test("placeholders in it must be waiting, not its own, and get new ids where theirs are taken", () => {
    expect(checkReply(sug("More <!-- gen:x1y:ack -->"), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("not waiting") });
    expect(checkReply(sug("More <!-- gen:abc -->"), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("your own task") });
    const ok = checkReply(sug("One <!-- gen:x1y --> and <!-- sel:zzz -->two<!-- /sel:zzz -->"), POINT_MID, gen, ["abc", "zzz", "qqq"]);
    expect(ok).toMatchObject({ status: "suggested" });
    const proposal = (ok as { suggestion: string }).suggestion;
    expect(proposal).toContain("<!-- gen:x1y -->"); // free: kept
    const id = proposal.match(/<!-- sel:([a-z0-9]{3,6}) -->two<!-- \/sel:\1 -->/)?.[1];
    expect(id).toBeDefined(); // taken: a new id, the same on both of its comments
    expect(["abc", "zzz", "qqq", "x1y"]).not.toContain(id!);
    // One with an instruction keeps it when its id changes.
    const again = checkReply(sug(`One <!-- sel:zzz "check it" -->two<!-- /sel:zzz -->`), POINT_MID, gen, ["abc", "zzz"]) as { suggestion: string };
    expect(again.suggestion).toMatch(/<!-- sel:(?!zzz)[a-z0-9]{3,6} "check it" -->two<!-- \/sel:[a-z0-9]{3,6} -->/);
  });

  test("a comments block in it is refused; a long one too", () => {
    expect(checkReply(sug('x\n\n<!-- solip-comments\n"meta": {}\n-->'), POINT_ALONE, gen, [])).toMatchObject({ error: expect.stringContaining("comments block") });
    expect(checkReply(sug("x".repeat(config().suggestions.max_chars + 1)), POINT_MID, gen, [])).toMatchObject({ error: expect.stringContaining("longer") });
  });

  test("an answer is kept as it is, canonical, with the text it was about; nothing to put in the page", () => {
    expect(checkReply({ kind: "answer", answer: "It means _the end_ of Q3.", note: "Explained." }, RANGE_MID, sel, [])).toEqual({ status: "suggested", answer: "It means *the end* of Q3.", saw: "end of Q3", note: "Explained." });
  });

  test("a decline is its reason", () => {
    expect(checkReply({ kind: "decline", note: "No." }, POINT_MID, gen, [])).toEqual({ status: "declined", note: "No." });
  });

  test("a placeholder the run's page doesn't have can't take a suggestion", () => {
    expect(checkReply(sug("x"), "No placeholder here.", gen, [])).toMatchObject({ error: expect.stringContaining("not in the page") });
  });
});

const file = (body: string, records: Record<string, TaskRecord> = {}) =>
  serializeFile(body, { ...emptyBlock(), meta: { rev: 4, body_rev: 4, body_by: "tab" }, ...(Object.keys(records).length && { tasks: records }) });
const writer = (extra: Partial<TaskRecord> = {}): TaskRecord => ({ type: "gen", created_by: "writer", created: "2026-10-27T09:00:00.000Z", status: "pending", ...extra });

describe("ackTask", () => {
  test("moves every comment of the placeholder to ack, and its record, as a server body change", () => {
    const src = file("<!-- sel:abc -->a<!-- /sel:abc -->\n\n<!-- sel:abc -->b<!-- /sel:abc --> and <!-- gen:zzz -->", { abc: writer({ type: "sel" }) });
    const r = ackTask(src, "abc", NOW)!;
    expect(r.taskType).toBe("sel");
    const { markdown, block } = parseFile(r.file);
    expect(markdown).toBe("<!-- sel:abc:ack -->a<!-- /sel:abc:ack -->\n\n<!-- sel:abc:ack -->b<!-- /sel:abc:ack --> and <!-- gen:zzz -->");
    expect(block.tasks!.abc).toEqual({ ...writer({ type: "sel" }), status: "ack", acked: NOW.toISOString() });
    expect(block.meta).toEqual({ rev: 5, body_rev: 5, body_by: "server" });
  });
  test("keeps the instruction on the opening comment, and finishing keeps it too", () => {
    const src = file(`<!-- sel:abc "make it &quot;short&quot;" -->a long sentence<!-- /sel:abc --> and <!-- gen:zzz -->`, { abc: writer({ type: "sel" }) });
    const acked = ackTask(src, "abc", NOW)!;
    expect(parseFile(acked.file).markdown).toBe(`<!-- sel:abc:ack "make it &quot;short&quot;" -->a long sentence<!-- /sel:abc:ack --> and <!-- gen:zzz -->`);
    const done = finishRun(acked.file, sel, parseFile(acked.file).markdown, { reply: '<suggestion mode="replace" place="inline">short</suggestion>' }, NOW);
    expect(parseFile(done.file!).block.tasks!.abc).toMatchObject({ status: "suggested", mode: "replace", suggestion: "short", saw: "a long sentence" });
    expect(parseFile(done.file!).markdown).toBe(`<!-- sel:abc:sug "make it &quot;short&quot;" -->a long sentence<!-- /sel:abc:sug --> and <!-- gen:zzz -->`);
  });

  test("one written by hand, with no record, gets the writer's", () => {
    const r = ackTask(file("x <!-- gen:abc -->"), "abc", NOW)!;
    expect(parseFile(r.file).block.tasks!.abc).toEqual({ type: "gen", created_by: "writer", created: NOW.toISOString(), status: "ack", acked: NOW.toISOString() });
  });

  test("one that isn't waiting is left alone", () => {
    expect(ackTask(file("x <!-- gen:abc:ack -->"), "abc", NOW)).toBeNull();
    expect(ackTask(file("x <!-- gen:abc:sug -->"), "abc", NOW)).toBeNull();
    expect(ackTask(file("x"), "abc", NOW)).toBeNull();
  });
});

describe("finishRun", () => {
  const ACKED = "The plan is <!-- gen:abc:ack --> done.";
  const REPLY = { reply: 'Done.\n<suggestion mode="at" place="inline">\nFilled in.\n</suggestion>\n<note>Filled it.</note>' };
  const start = (records = { abc: writer({ status: "ack", acked: "2026-10-27T09:59:00.000Z" }) }) => file(ACKED, records);

  test("a usable reply: the placeholder moves to sug and the record holds the suggestion", () => {
    const f = finishRun(start(), gen, ACKED, REPLY, NOW);
    expect(f.outcome).toEqual({ done: "suggested" });
    const { markdown, block } = parseFile(f.file!);
    expect(markdown).toBe("The plan is <!-- gen:abc:sug --> done.");
    expect(block.tasks!.abc).toEqual({
      ...writer(), status: "suggested", acked: "2026-10-27T09:59:00.000Z", finished: NOW.toISOString(), failures: 0,
      mode: "at", place: "inline", suggestion: "Filled in.", note: "Filled it.",
    });
  });

  test("the writer typed elsewhere while it ran: their text is kept", () => {
    const f = finishRun(file(`Typed first. ${ACKED}`, { abc: writer({ status: "ack" }) }), gen, ACKED, REPLY, NOW);
    expect(parseFile(f.file!).markdown).toBe("Typed first. The plan is <!-- gen:abc:sug --> done.");
  });

  test("a decline: sug, with the reason and no proposal (one from an earlier try goes)", () => {
    const f = finishRun(start({ abc: writer({ status: "ack", suggestion: "old", mode: "at", place: "inline", asked_again: 1 }) }), gen, ACKED, { reply: "<decline>Too vague.</decline>" }, NOW);
    expect(f.outcome).toEqual({ done: "declined" });
    const r = parseFile(f.file!).block.tasks!.abc!;
    expect(r).toMatchObject({ status: "declined", note: "Too vague.", asked_again: 1 });
    expect(r.suggestion).toBeUndefined();
    expect(r.mode).toBeUndefined();
  });

  test("an answer: sug, with the answer and no proposal; the page's text is not touched", () => {
    const body = "Check <!-- sel:abc:ack \"what does this mean?\" -->end of Q3<!-- /sel:abc:ack --> here.";
    const f = finishRun(file(body, { abc: writer({ type: "sel", status: "ack", suggestion: "old", mode: "after", place: "inline" }) }), sel, body, { reply: "<answer>The last day of September.</answer>" }, NOW);
    expect(f.outcome).toEqual({ done: "suggested" });
    const after = parseFile(f.file!);
    expect(after.markdown).toBe(body.replaceAll(":ack", ":sug"));
    expect(after.block.tasks!.abc).toMatchObject({ status: "suggested", answer: "The last day of September.", saw: "end of Q3" });
    expect(after.block.tasks!.abc!.suggestion).toBeUndefined();
  });

  test("a reply that can't be used, or a run that failed: it stays acknowledged for the reset, counted", () => {
    const f = finishRun(start(), gen, ACKED, { reply: "ok" }, NOW);
    expect(f.outcome).toEqual({ done: "failed", error: "The reply has no <suggestion>, <edit>, <answer> or <decline>.", failures: 1 });
    const { markdown, block } = parseFile(f.file!);
    expect(markdown).toBe(ACKED);
    expect(block.tasks!.abc).toMatchObject({ status: "ack", failures: 1 });
    expect(block.meta.body_rev).toBe(4); // only the record changed
    const g = finishRun(f.file!, gen, ACKED, { error: "exit 1" }, NOW);
    expect(g.outcome).toEqual({ done: "failed", error: "exit 1", failures: 2 });
  });

  test("the third failure in a row gives up: declined, saying why", () => {
    const f = finishRun(start({ abc: writer({ status: "ack", failures: 2 }) }), gen, ACKED, { error: "Timed out after 600s." }, NOW);
    expect(f.outcome).toEqual({ done: "declined" });
    expect(parseFile(f.file!).markdown).toBe("The plan is <!-- gen:abc:sug --> done.");
    expect(parseFile(f.file!).block.tasks!.abc).toMatchObject({ status: "declined", failures: 3, note: expect.stringContaining("Timed out after 600s.") });
  });

  test("a success after failures starts the count again", () => {
    const f = finishRun(start({ abc: writer({ status: "ack", failures: 2 }) }), gen, ACKED, REPLY, NOW);
    expect(parseFile(f.file!).block.tasks!.abc).toMatchObject({ status: "suggested", failures: 0 });
  });

  test("the writer deleted the placeholder: the page is left alone, the suggestion kept as dropped", () => {
    const f = finishRun(file("The plan is done.", { abc: writer({ status: "ack" }) }), gen, ACKED, REPLY, NOW);
    expect(f.outcome).toEqual({ done: "dropped" });
    const { markdown, block } = parseFile(f.file!);
    expect(markdown).toBe("The plan is done.");
    expect(block.tasks!.abc).toMatchObject({ status: "dropped", suggestion: "Filled in." });
    expect(block.meta.body_rev).toBe(4);
  });

  test("deleted, and the run failed too: nothing to keep", () => {
    expect(finishRun(file("The plan is done."), gen, ACKED, { error: "x" }, NOW)).toEqual({ outcome: { done: "nothing" } });
  });

  test("no longer acknowledged (reset, asked again): left alone", () => {
    expect(finishRun(file("The plan is <!-- gen:abc --> done."), gen, ACKED, REPLY, NOW)).toEqual({ outcome: { done: "nothing" } });
    expect(finishRun(file("The plan is <!-- gen:abc:sug --> done."), gen, ACKED, REPLY, NOW)).toEqual({ outcome: { done: "nothing" } });
  });

  test("checked against the page the run read, with ids taken in the page now and in the record", () => {
    const now = file(`${ACKED} <!-- gen:new -->`, { abc: writer({ status: "ack" }), old: writer() });
    const f = finishRun(now, gen, ACKED, { reply: '<suggestion mode="at" place="inline">A <!-- gen:new --> and <!-- gen:old --> and <!-- gen:fre --></suggestion>' }, NOW);
    const proposal = parseFile(f.file!).block.tasks!.abc!.suggestion!;
    expect(proposal).toContain("<!-- gen:fre -->");
    expect(proposal).not.toContain("<!-- gen:new -->");
    expect(proposal).not.toContain("<!-- gen:old -->");
  });
});

describe("edits to other blocks", () => {
  const TABLE = "| Team | Date |\n| ---- | ---- |\n| Web  | 3 Sep |";
  /** The table as the page writes it. */
  const CANON = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
  const PAGE = `<!-- sel:abc:ack -->Remove this table<!-- /sel:abc:ack -->\n\n${TABLE}\n\nAfter.`;
  const edit = (before: string, after = "") => `<edit>\n<before>\n${before}\n</before>\n<after>\n${after}\n</after>\n</edit>`;
  const only = (...edits: { before: string; after: string }[]): Reply => ({ kind: "suggestion", edits });

  test("parseReply reads every <edit>, alone or with a suggestion", () => {
    expect(parseReply(`${edit(TABLE)}\n<note>Removed it.</note>`)).toEqual({ kind: "suggestion", edits: [{ before: TABLE, after: "" }], note: "Removed it." });
    expect(parseReply(`<suggestion mode="after" place="inline">ok</suggestion>\n${edit("A.", "B.")}\n${edit("C.")}`))
      .toEqual({ kind: "suggestion", mode: "after", place: "inline", suggestion: "ok", edits: [{ before: "A.", after: "B." }, { before: "C.", after: "" }] });
    expect(parseReply(`${edit("A.")}<decline>no</decline>`)).toMatchObject({ error: expect.stringContaining("both") });
  });

  test("an edit is found as whole blocks in the page the run read, and kept as the page writes them", () => {
    const r = checkReply(only({ before: "| Team | Date |\n|---|---|\n| Web | 3 Sep |", after: "" }), PAGE, sel, []);
    expect(r).toEqual({ status: "suggested", edits: [{ before: CANON, after: "" }], saw: "Remove this table" });
  });

  test("its replacement is canonical, with fresh ids for placeholders in it", () => {
    const r = checkReply(only({ before: "After.", after: "After, _changed_. <!-- gen:abc --><!-- gen:zzz -->" }), PAGE, sel, ["zzz"]);
    expect(r).toMatchObject({ error: expect.stringContaining("the marker of your own task") });
    const ok = checkReply(only({ before: "After.", after: "After, _changed_. <!-- gen:zzz -->" }), PAGE, sel, ["zzz"]) as { edits: { after: string }[] };
    expect(ok.edits[0]!.after).toMatch(/^After, \*changed\*\. <!-- gen:[a-z0-9]{3,6} -->$/);
    expect(ok.edits[0]!.after).not.toContain("gen:zzz");
  });

  test("what can't be used: not found, found twice, part of a block, its own block, overlapping, too many", () => {
    expect(checkReply(only({ before: "Not on the page.", after: "" }), PAGE, sel, [])).toMatchObject({ error: expect.stringContaining("found once") });
    expect(checkReply(only({ before: "Twice.", after: "" }), `${PAGE}\n\nTwice.\n\nTwice.`, sel, [])).toMatchObject({ error: expect.stringContaining("found once") });
    expect(checkReply(only({ before: "| Web  | 3 Sep |", after: "" }), PAGE, sel, [])).toMatchObject({ error: expect.stringContaining("found once") });
    expect(checkReply(only({ before: "<!-- sel:abc:ack -->Remove this table<!-- /sel:abc:ack -->", after: "" }), PAGE, sel, [])).toMatchObject({ error: expect.stringContaining("your own marker") });
    expect(checkReply(only({ before: `${TABLE}\n\nAfter.`, after: "" }, { before: "After.", after: "" }), PAGE, sel, [])).toMatchObject({ error: expect.stringContaining("overlaps") });
    const many = Array.from({ length: 21 }, () => ({ before: "After.", after: "" }));
    expect(checkReply(only(...many), PAGE, sel, [])).toMatchObject({ error: expect.stringContaining("More than") });
  });

  test("a run whose result is only edits: suggested, with no result at its spot", () => {
    const src = serializeFile(PAGE, { ...emptyBlock(), tasks: { abc: writer({ type: "sel", status: "ack" }) } });
    const f = finishRun(src, sel, PAGE, { reply: `${edit(TABLE)}\n<note>Removed it.</note>` }, NOW);
    expect(f.outcome).toEqual({ done: "suggested" });
    const r = parseFile(f.file!).block.tasks!.abc!;
    expect(r).toMatchObject({ status: "suggested", edits: [{ before: CANON, after: "" }], note: "Removed it." });
    expect(r.suggestion).toBeUndefined();
    expect(r.mode).toBeUndefined();
    expect(parseFile(f.file!).markdown).toBe(PAGE.replaceAll(":ack", ":sug"));
  });
});
