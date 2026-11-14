// Accepting, rejecting and asking again on a suggestion: the task at `:sug` and its record's proposal.
import { describe, expect, test } from "bun:test";
import { history, undo } from "@tiptap/pm/history";
import { EditorState } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { decide, docToMarkdown, findBlocks, markdownToDoc, markerSpots, schema, type Decision, type TaskRecord } from "../src/shared/docfile";

type Rec = Pick<TaskRecord, "mode" | "place" | "suggestion" | "edits">;
const run = (md: string, id: string, decision: Decision, record: Rec) => {
  const tr = new Transform(markdownToDoc(md));
  if (!decide(tr, id, decision, record)) return null;
  tr.doc.check();
  return docToMarkdown(tr.doc);
};

const TABLE = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";

// [what, page, id, decision, record, page after]
const CASES: [string, string, string, Decision, Rec, string][] = [
  // a point (`gen`)
  ["at, inline: the proposal takes the marker's place", "The deadline is end of Q3 <!-- gen:k2x:sug --> for all teams.", "k2x", "accepted", { mode: "at", place: "inline", suggestion: "(30 September)" }, "The deadline is end of Q3 (30 September) for all teams."],
  ["at, inline, right after a word: a space comes first", "End of Q3<!-- gen:k2x:sug --> for all.", "k2x", "accepted", { mode: "at", place: "inline", suggestion: "(30 *September*)" }, "End of Q3 (30 *September*) for all."],
  ["at, rejected: the marker goes, and the space it leaves doubled", "End of Q3 <!-- gen:k2x:sug --> for all.", "k2x", "rejected", { mode: "at", place: "inline", suggestion: "x" }, "End of Q3 for all."],
  ["at, rejected before punctuation", "Text <!-- gen:k2x:sug -->.", "k2x", "rejected", {}, "Text."],
  ["at, blocks: a table takes the marker's paragraph", "# Plan\n\n<!-- gen:m9q:sug -->\n\nAfter.", "m9q", "accepted", { mode: "at", place: "blocks", suggestion: TABLE }, `# Plan\n\n${TABLE}\n\nAfter.`],
  ["at, blocks, rejected: the marker's empty paragraph goes too", "# Plan\n\n<!-- gen:m9q:sug -->\n\nAfter.", "m9q", "rejected", { mode: "at", place: "blocks", suggestion: TABLE }, "# Plan\n\nAfter."],
  ["at, the only block on the page, rejected", "<!-- gen:m9q:sug -->", "m9q", "rejected", {}, ""],
  ["at, in an empty list item: the item's text", "- <!-- gen:iii:sug -->\n- other", "iii", "accepted", { mode: "at", place: "inline", suggestion: "filled" }, "- filled\n- other"],
  ["at, in an empty list item, a list: its items join the list", "- <!-- gen:iii:sug -->\n- other", "iii", "accepted", { mode: "at", place: "blocks", suggestion: "- a\n- b" }, "- a\n- b\n- other"],
  ["at, in an empty list item, rejected: the item goes", "- <!-- gen:iii:sug -->\n- other", "iii", "rejected", {}, "- other"],
  ["at, alone in a quote: the blocks stay in the quote", "> <!-- gen:qqq:sug -->\n\nAfter", "qqq", "accepted", { mode: "at", place: "blocks", suggestion: "A para.\n\nAnother." }, "> A para.\n>\n> Another.\n\nAfter"],
  ["at, in a table cell", "| a | b |\n| - | - |\n| <!-- gen:qqq:sug --> | x |", "qqq", "accepted", { mode: "at", place: "inline", suggestion: "cell text" }, "| a | b |\n| --- | --- |\n| cell text | x |"],
  ["at, in a table cell, rejected: the cell stays, empty", "| a | b |\n| - | - |\n| <!-- gen:qqq:sug --> | x |", "qqq", "rejected", {}, "| a | b |\n| --- | --- |\n| | x |"],
  ["a declined one (no proposal) accepted is dismissed", "The <!-- gen:k2x:sug --> end.", "k2x", "accepted", {}, "The end."],
  ["a follow-up placeholder in the proposal arrives pending", "Para <!-- gen:k2x:sug -->", "k2x", "accepted", { mode: "at", place: "inline", suggestion: "with a follow-up <!-- gen:f00 -->" }, "Para with a follow-up <!-- gen:f00 -->"],
  // a range, the result after it (`sel`)
  ["after, blocks: after the range's block, the writer's text kept", "<!-- sel:r7t:sug -->List three risks<!-- /sel:r7t:sug -->\n\nNext.", "r7t", "accepted", { mode: "after", place: "blocks", suggestion: "- Vendor\n- Freeze\n- On-call" }, "List three risks\n\n- Vendor\n- Freeze\n- On-call\n\nNext."],
  ["after, inline: on the same line, spaced", "Check <!-- sel:r7t:sug -->end of Q3<!-- /sel:r7t:sug --> here.", "r7t", "accepted", { mode: "after", place: "inline", suggestion: "(it is 30 Sep)" }, "Check end of Q3 (it is 30 Sep) here."],
  ["after, rejected: the comments go, the text stays", "Check <!-- sel:r7t:sug -->end of Q3<!-- /sel:r7t:sug --> here.", "r7t", "rejected", { mode: "after", place: "inline", suggestion: "x" }, "Check end of Q3 here."],
  ["after, inline, the range ends inside bold: the result is not bold", "**bold <!-- sel:r7t:sug -->task<!-- /sel:r7t:sug -->** after", "r7t", "accepted", { mode: "after", place: "inline", suggestion: "result" }, "**bold task** result after"],
  ["after, blocks, in a list item: a nested list under it", "- <!-- sel:iii:sug -->item<!-- /sel:iii:sug -->\n- other", "iii", "accepted", { mode: "after", place: "blocks", suggestion: "- nested a\n- nested b" }, "- item\n  - nested a\n  - nested b\n- other"],
  // a range, its text replaced
  ["replace, inline", "Intro. <!-- sel:w2e:sug -->The rollout went well overall.<!-- /sel:w2e:sug --> Next.", "w2e", "accepted", { mode: "replace", place: "inline", suggestion: "The rollout beat every target." }, "Intro. The rollout beat every target. Next."],
  ["replace, empty, at the start of a paragraph: no space left at its start", "<!-- sel:w2e:sug -->As said,<!-- /sel:w2e:sug --> it went well.", "w2e", "accepted", { mode: "replace", place: "inline", suggestion: "" }, "it went well."],
  ["at, rejected at the start of a paragraph", "<!-- gen:k2x:sug --> Then more.", "k2x", "rejected", {}, "Then more."],
  ["replace, empty: the text is deleted, no space doubled", "Intro. <!-- sel:w2e:sug -->As said, it went well.<!-- /sel:w2e:sug --> Next.", "w2e", "accepted", { mode: "replace", place: "inline", suggestion: "" }, "Intro. Next."],
  ["replace, rejected: the text stays", "Intro. <!-- sel:w2e:sug -->Old.<!-- /sel:w2e:sug --> Next.", "w2e", "rejected", { mode: "replace", place: "inline", suggestion: "New." }, "Intro. Old. Next."],
  ["replace, two whole paragraphs by one", "A\n\n<!-- sel:h8j:sug -->First para.<!-- /sel:h8j:sug -->\n\n<!-- sel:h8j:sug -->Second para.<!-- /sel:h8j:sug -->\n\nZ", "h8j", "accepted", { mode: "replace", place: "blocks", suggestion: "One merged para." }, "A\n\nOne merged para.\n\nZ"],
  ["replace, two whole paragraphs by inline text", "A\n\n<!-- sel:h8j:sug -->First para.<!-- /sel:h8j:sug -->\n\n<!-- sel:h8j:sug -->Second para.<!-- /sel:h8j:sug -->\n\nZ", "h8j", "accepted", { mode: "replace", place: "inline", suggestion: "One merged para." }, "A\n\nOne merged para.\n\nZ"],
  ["replace, a whole paragraph by nothing: the paragraph goes", "A\n\n<!-- sel:h8j:sug -->First para.<!-- /sel:h8j:sug -->\n\nZ", "h8j", "accepted", { mode: "replace", place: "inline", suggestion: "" }, "A\n\nZ"],
  ["replace, the whole page by nothing", "<!-- sel:h8j:sug -->Only para.<!-- /sel:h8j:sug -->", "h8j", "accepted", { mode: "replace", place: "inline", suggestion: "" }, ""],
  ["replace, from mid paragraph to mid paragraph: the ends join", "Head <!-- sel:h8j:sug -->tail one.<!-- /sel:h8j:sug -->\n\n<!-- sel:h8j:sug -->Start two<!-- /sel:h8j:sug --> rest.", "h8j", "accepted", { mode: "replace", place: "inline", suggestion: "merged" }, "Head merged rest."],
  ["replace, a whole paragraph and the start of the next", "A\n\n<!-- sel:h8j:sug -->First para.<!-- /sel:h8j:sug -->\n\n<!-- sel:h8j:sug -->Start two<!-- /sel:h8j:sug --> rest.", "h8j", "accepted", { mode: "replace", place: "inline", suggestion: "merged" }, "A\n\nmerged rest."],
  ["replace, two list items by two: they stay items of the list", "1. <!-- sel:iii:sug -->one<!-- /sel:iii:sug -->\n2. <!-- sel:iii:sug -->two<!-- /sel:iii:sug -->\n3. three", "iii", "accepted", { mode: "replace", place: "blocks", suggestion: "1. uno\n2. dos" }, "1. uno\n2. dos\n3. three"],
  ["replace, two list items by three", "1. one\n2. <!-- sel:iii:sug -->two<!-- /sel:iii:sug -->\n3. <!-- sel:iii:sug -->three<!-- /sel:iii:sug -->", "iii", "accepted", { mode: "replace", place: "blocks", suggestion: "1. dos\n2. tres\n3. cuatro" }, "1. one\n2. dos\n3. tres\n4. cuatro"],
  ["replace, a list item by nothing: the item goes", "- a\n- <!-- sel:iii:sug -->b<!-- /sel:iii:sug -->\n- c", "iii", "accepted", { mode: "replace", place: "inline", suggestion: "" }, "- a\n- c"],
  ["replace, a task item by two", "- [ ] <!-- sel:qqq:sug -->task<!-- /sel:qqq:sug -->\n- [ ] other", "qqq", "accepted", { mode: "replace", place: "blocks", suggestion: "- [ ] t1\n- [ ] t2" }, "- [ ] t1\n- [ ] t2\n- [ ] other"],
  ["replace, in a quote: the quote stays", "> <!-- sel:qqq:sug -->quoted<!-- /sel:qqq:sug -->\n\nAfter", "qqq", "accepted", { mode: "replace", place: "inline", suggestion: "new quote" }, "> new quote\n\nAfter"],
  // asking again
  ["asked again, a point: back to pending", "The <!-- gen:k2x:sug --> end.", "k2x", "asked_again", { mode: "at", place: "inline", suggestion: "x" }, "The <!-- gen:k2x --> end."],
  ["asked again, a range over two paragraphs: both pairs back to pending", "<!-- sel:k2x:sug -->a<!-- /sel:k2x:sug -->\n\n<!-- sel:k2x:sug -->b<!-- /sel:k2x:sug -->", "k2x", "asked_again", { mode: "after" }, "<!-- sel:k2x -->a<!-- /sel:k2x -->\n\n<!-- sel:k2x -->b<!-- /sel:k2x -->"],
];

describe("decide", () => {
  for (const [what, md, id, decision, record, want] of CASES) test(what, () => expect(run(md, id, decision, record)).toBe(want));

  test("several decisions in one transform (Accept all), each placeholder found where the ones before left it", () => {
    const md = "Start <!-- gen:aaa:sug --> one.\n\n<!-- sel:bbb:sug -->Two<!-- /sel:bbb:sug --> mid.\n\n<!-- gen:ccc:sug -->\n\nEnd <!-- sel:ddd:sug -->four<!-- /sel:ddd:sug -->.";
    const records: Record<string, Rec> = {
      aaa: { mode: "at", place: "inline", suggestion: "a long inserted clause" },
      bbb: { mode: "replace", place: "inline", suggestion: "" },
      ccc: { mode: "at", place: "blocks", suggestion: "- x\n- y" },
      ddd: { mode: "after", place: "inline", suggestion: "(after)" },
    };
    const tr = new Transform(markdownToDoc(md));
    for (const id of ["aaa", "bbb", "ccc", "ddd"]) expect(decide(tr, id, "accepted", records[id]!)).toBe(true);
    expect(docToMarkdown(tr.doc)).toBe("Start a long inserted clause one.\n\nmid.\n\n- x\n- y\n\nEnd four (after).");
    const back = new Transform(markdownToDoc(md));
    for (const id of ["ddd", "ccc", "bbb", "aaa"]) decide(back, id, "rejected", records[id]!);
    expect(docToMarkdown(back.doc)).toBe("Start one.\n\nTwo mid.\n\nEnd four.");
  });

  test("a placeholder that isn't there changes nothing", () => {
    const tr = new Transform(markdownToDoc("The <!-- gen:k2x:sug --> end."));
    expect(decide(tr, "zzz", "accepted", { mode: "at", place: "inline", suggestion: "x" })).toBe(false);
    expect(tr.steps).toHaveLength(0);
  });

  test("other placeholders and the writer's formatting are left as they are", () => {
    const md = "A **bold** <!-- gen:aaa --> and <!-- sel:bbb:ack -->busy<!-- /sel:bbb:ack --> then <!-- gen:k2x:sug --> end.";
    expect(run(md, "k2x", "accepted", { mode: "at", place: "inline", suggestion: "done" })).toBe("A **bold** <!-- gen:aaa --> and <!-- sel:bbb:ack -->busy<!-- /sel:bbb:ack --> then done end.");
  });

  test("a margin comment's highlight on the range's text survives a reject", () => {
    const doc = markdownToDoc("Check <!-- sel:r7t:sug -->end of Q3<!-- /sel:r7t:sug --> here.");
    const { pieces } = markerSpots(doc, "r7t")!;
    const tr = new Transform(doc).addMark(pieces[0]!.from, pieces[0]!.to, schema.marks.comment!.create({ id: "c1" }));
    decide(tr, "r7t", "rejected", { mode: "after" });
    const marked: string[] = [];
    tr.doc.descendants((n) => { if (n.isText && n.marks.some((m) => m.type.name === "comment")) marked.push(n.text!); });
    expect(marked).toEqual(["end of Q3"]);
  });
});

describe("markerSpots", () => {
  test("a point's position, a range's pieces (one per block), and the kind", () => {
    const doc = markdownToDoc("x <!-- gen:aaa:sug --> y\n\n<!-- sel:bbb:sug -->one **two**<!-- /sel:bbb:sug -->\n\n<!-- sel:bbb:sug -->three<!-- /sel:bbb:sug -->");
    const point = markerSpots(doc, "aaa")!;
    expect(point.taskType).toBe("gen");
    expect(doc.nodeAt(point.points[0]!)!.type.name).toBe("markerPoint");
    const range = markerSpots(doc, "bbb")!;
    expect(range.taskType).toBe("sel");
    expect(range.pieces.map((p) => doc.textBetween(p.from, p.to))).toEqual(["one two", "three"]);
    expect(markerSpots(doc, "ccc")).toBeNull();
  });
});

describe("undo", () => {
  const MODES: [string, string, Rec][] = [
    ["at", "Before <!-- gen:k2x:sug --> after.\n\n<!-- gen:m9q:sug -->\n\nEnd.", { mode: "at", place: "blocks", suggestion: TABLE }],
    ["after", "<!-- sel:k2x:sug -->List risks<!-- /sel:k2x:sug -->\n\nEnd.", { mode: "after", place: "blocks", suggestion: "- a\n- b" }],
    ["replace", "A\n\n<!-- sel:k2x:sug -->One.<!-- /sel:k2x:sug -->\n\n<!-- sel:k2x:sug -->Two.<!-- /sel:k2x:sug -->", { mode: "replace", place: "inline", suggestion: "Both." }],
  ];
  for (const [mode, md, record] of MODES) {
    for (const decision of ["accepted", "rejected", "asked_again"] as const) {
      test(`${mode}, ${decision}: one Undo brings the page back`, () => {
        const id = mode === "at" ? "m9q" : "k2x";
        let state = EditorState.create({ doc: markdownToDoc(md), plugins: [history()] });
        const tr = state.tr;
        expect(decide(tr, id, decision, record)).toBe(true);
        state = state.apply(tr);
        expect(docToMarkdown(state.doc)).not.toBe(md);
        undo(state, (t) => { state = state.apply(t); });
        expect(docToMarkdown(state.doc)).toBe(md);
      });
    }
  }
});

describe("edits to other blocks", () => {
  const T = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
  const PAGE = `<!-- sel:t7w:sug -->Remove this table<!-- /sel:t7w:sug -->\n\n${T}\n\nAfter.`;

  test("findBlocks: a run of whole top-level blocks found once, by what they say", () => {
    const doc = markdownToDoc(`A.\n\n${T}\n\nB.\n\nA.`);
    expect(doc.slice(findBlocks(doc, T)!.from, findBlocks(doc, T)!.to).content.firstChild!.type.name).toBe("table");
    expect(findBlocks(doc, `${T}\n\nB.`)).not.toBeNull();
    expect(findBlocks(doc, "A.")).toBeNull(); // twice
    expect(findBlocks(doc, "| Web | 3 Sep |")).toBeNull(); // part of a block
    expect(findBlocks(doc, "")).toBeNull();
    expect(findBlocks(markdownToDoc("x <!-- gen:abc:sug --> y"), "x <!-- gen:abc --> y")).not.toBeNull(); // states aside
  });

  test("accepted: the table goes and the request's text stays; rejected: nothing changes but the comments", () => {
    const rec: Rec = { edits: [{ before: T, after: "" }] };
    expect(run(PAGE, "t7w", "accepted", rec)).toBe("Remove this table\n\nAfter.");
    expect(run(PAGE, "t7w", "rejected", rec)).toBe(`Remove this table\n\n${T}\n\nAfter.`);
    expect(run(PAGE, "t7w", "asked_again", rec)).toBe(PAGE.replaceAll(":sug", ""));
  });

  test("an edit with a replacement, with a result at the spot too, in one Undo", () => {
    const rec: Rec = { mode: "after", place: "inline", suggestion: "(done)", edits: [{ before: "After.", after: "After, *changed*.\n\nAnd a new paragraph." }] };
    expect(run(PAGE, "t7w", "accepted", rec)).toBe(`Remove this table (done)\n\n${T}\n\nAfter, *changed*.\n\nAnd a new paragraph.`);
    let state = EditorState.create({ doc: markdownToDoc(PAGE), plugins: [history()] });
    const tr = state.tr;
    decide(tr, "t7w", "accepted", rec);
    state = state.apply(tr);
    undo(state, (t) => { state = state.apply(t); });
    expect(docToMarkdown(state.doc)).toBe(PAGE);
  });

  test("an edit whose blocks the writer changed since is left out; the rest is made", () => {
    const rec: Rec = { edits: [{ before: T, after: "" }, { before: "Gone already.", after: "" }] };
    expect(run(PAGE, "t7w", "accepted", rec)).toBe("Remove this table\n\nAfter.");
  });

  test("removing every other block leaves the page with one", () => {
    expect(run(`${T}\n\nKeep <!-- gen:abc:sug -->`, "abc", "accepted", { mode: "at", place: "inline", suggestion: "x", edits: [{ before: T, after: "" }] })).toBe("Keep x");
  });
});
