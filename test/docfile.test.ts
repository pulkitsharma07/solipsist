import { describe as group, expect, test } from "bun:test";
import { Transform } from "@tiptap/pm/transform";
import { applyPut } from "../src/server/put";
import {
  addComment, anchor, anchorInDoc, scrubMarkers, cleanQuote, commentCap, describe, docText, docToMarkdown, emptyBlock,
  diffBodies, type DiffLine, markdownToDoc, mergeBodies, nextOrphanExpiry, parseFile, pruneOrphans, summarize, schema, serializeFile, setStatus,
} from "../src/shared/docfile";

const PAGE = `# Release plan

The **deadline** is end of Q3 for all teams.

Budget approval comes from finance, and headcount comes from finance too.

| Team | Owner | Due |
| --- | --- | --- |
| Data | Priya | Q3 for the platform team |
| Web | Sam | Q4 |

Run \`deploy --prod\` before the review.

\`\`\`ts
const due = "Q3";
ship(due);
\`\`\`

- [x] Kick-off done
- [ ] Budget sign-off

> A quoted line.`;

const textOf = (md: string) => docText(markdownToDoc(md));
const bare = (exact: string, start = 0) => ({ exact, prefix: "", suffix: "", start });
/** Anchor a quote in a page, rebuild a full anchor there, and return it (what a placed comment carries). */
const anchorFor = (md: string, exact: string, nth = 0) => {
  const dt = textOf(md);
  let i = -1;
  for (let k = 0; k <= nth; k++) i = dt.text.indexOf(exact, i + 1);
  if (i < 0) throw new Error(`"${exact}" not in page`);
  return describe(dt, i, i + exact.length);
};
const found = (md: string, a: ReturnType<typeof anchorFor>) => {
  const dt = textOf(md);
  const r = anchor(dt, a);
  return r && dt.text.slice(r.from, r.to);
};

group("file: body + comments block", () => {
  test("round trip", () => {
    const { block } = addComment(emptyBlock(), { thinker: "challenger", title: "t", anchor: bare("x") });
    const src = serializeFile(PAGE, block);
    const back = parseFile(src);
    expect(back.markdown).toBe(PAGE);
    expect(back.block).toEqual(block);
    expect(serializeFile(back.markdown, back.block)).toBe(src);
  });

  test("a save gives the writer's new placeholders a record, once, and leaves the agent's records alone", () => {
    const agent = { type: "sel", created_by: "agent", created_from: "k2x", created: "2026-10-24T10:00:00.000Z", status: "ack" } as const;
    const src = serializeFile("Hi", { ...emptyBlock(), tasks: { r4t: agent } });
    const now = new Date("2026-10-24T11:00:00.000Z");
    const md = "Hi <!-- gen:aaa --> and <!-- sel:bbb -->this<!-- /sel:bbb --> and <!-- sel:r4t:ack -->that<!-- /sel:r4t:ack -->";
    const first = applyPut(src, { client_id: "a", base_rev: 0, markdown: md, comments: {} }, now);
    if (!first.ok) throw new Error("refused");
    const records = parseFile(first.file).block.tasks!;
    expect(records.aaa).toEqual({ type: "gen", created_by: "writer", created: now.toISOString(), status: "pending" });
    expect(records.bbb).toMatchObject({ type: "sel", created_by: "writer" });
    expect(records.r4t).toEqual(agent);
    const later = applyPut(first.file, { client_id: "a", base_rev: 1, markdown: md, comments: {} }, new Date("2026-10-24T12:00:00.000Z"));
    if (!later.ok) throw new Error("refused");
    expect(parseFile(later.file).block.tasks).toEqual(records); // not stamped again
  });

  test("a file with no block has an empty one", () => {
    expect(parseFile(PAGE)).toEqual({ markdown: PAGE, block: emptyBlock(), format: 1 });
  });

  test("the agent's placeholder records survive a read and a write, and are left out when there are none", () => {
    const rec = { type: "sel", created_by: "agent", created_from: "k2x", created: "2026-10-24T10:00:00.000Z", status: "ack", note: "a <b> & c" } as const;
    const block = { ...emptyBlock(), tasks: { m9q: rec } };
    const back = parseFile(serializeFile(PAGE, block));
    expect(back.block.tasks).toEqual({ m9q: rec });
    expect(back.problem).toBeUndefined();
    expect(serializeFile(PAGE, emptyBlock())).not.toContain("tasks");
  });

  test("the block is YAML, and a file whose block is still JSON reads the same and is rewritten as YAML", () => {
    const json = `${PAGE}\n\n<!-- solip-comments\n{"meta":{"rev":4,"body_rev":3,"body_by":"disk"},"comments":{}}\n-->\n`;
    const old = parseFile(json);
    expect(old.problem).toBeUndefined();
    expect(old.block.meta).toEqual({ rev: 4, body_rev: 3, body_by: "disk" });
    const out = serializeFile(old.markdown, old.block);
    expect(out).toContain('"rev": 4');
    expect(out).not.toContain("<!-- solip-comments\n{"); // no longer a JSON object
    expect(parseFile(out).block).toEqual(old.block);
  });

  test("a hand-written YAML block reads, and an id that looks like a number stays text", () => {
    const src = `${PAGE}\n\n<!-- solip-comments\nmeta:\n  rev: 2\n  body_rev: 2\n  body_by: null\ncomments: {}\ntasks:\n  1e5:\n    type: sel\n    created_by: writer\n    created: 2026-10-24T10:00:00.000Z\n    status: pending\n    note: a --> b <i>\n-->\n`;
    const f = parseFile(src);
    expect(f.problem).toBeUndefined();
    expect(Object.keys(f.block.tasks!)).toEqual(["1e5"]);
    expect(f.block.tasks!["1e5"]!.note).toBe("a --> b <i>");
    const back = serializeFile(f.markdown, f.block);
    expect(back.match(/-->/g)).toHaveLength(1); // only the closing one: the note's is escaped
    expect(parseFile(back).block).toEqual(f.block);
  });

  test("--> and <!-- inside a comment can't end the block", () => {
    const { block } = addComment(emptyBlock(), { thinker: "c", title: "ends --> here <!-- or not", anchor: bare("x") });
    const src = serializeFile(PAGE, block);
    expect(src.match(/-->/g)!.length).toBe(1);
    expect(Object.values(parseFile(src).block.comments)[0]!.title).toBe("ends --> here <!-- or not");
  });

  test("a broken block is reported, and the text is kept", () => {
    const src = `${PAGE}\n\n<!-- solip-comments\n{ not json\n-->\n`;
    const f = parseFile(src);
    expect(f.problem).toBe("bad-block");
    expect(f.markdown).toBe(PAGE);
  });

  test("a hand-written comment that looks like the block stays a body comment, and can't end the body", () => {
    const doc = markdownToDoc("Someone wrote <!-- solip-comments\n{} \n--> here.");
    const md = docToMarkdown(doc);
    expect(md).toBe("Someone wrote <!-- solip-comments\n{} \n--> here.");
    const src = serializeFile(md, emptyBlock());
    expect(parseFile(src).markdown).toBe(md);
  });
});

group("markdown: Tiptap, headless", () => {
  test("serialize(parse(x)) is stable", () => {
    const once = docToMarkdown(markdownToDoc(PAGE));
    expect(docToMarkdown(markdownToDoc(once))).toBe(once);
  });

  test("no text is lost in the first round trip", () => {
    const once = docToMarkdown(markdownToDoc(PAGE));
    expect(textOf(once).text).toBe(textOf(PAGE).text);
  });

  test("tables, code, tasks and formatting survive", () => {
    const md = docToMarkdown(markdownToDoc(PAGE));
    for (const s of ["**deadline**", "`deploy --prod`", "```ts", "- [x] Kick-off", "| Data", "> A quoted line."]) expect(md).toContain(s);
  });

  test("document text has no markdown syntax", () => {
    const { text } = textOf(PAGE);
    expect(text).toContain("The deadline is end of Q3");
    expect(text).not.toContain("**");
    expect(text).not.toContain("|");
  });
});

group("anchor: finding a comment by its text", () => {
  test("exact match", () => {
    expect(found(PAGE, anchorFor(PAGE, "end of Q3 for all teams"))).toBe("end of Q3 for all teams");
  });

  test("curly quotes and dashes in the anchor match straight ones in the text", () => {
    const md = `He said "ship it" - twice.`;
    expect(found(md, { exact: "“ship it” — twice", prefix: "He said ", suffix: ".", start: 0 })).toBe(`"ship it" - twice`);
  });

  test("the same words twice: context picks the right one, whatever start says", () => {
    const second = anchorFor(PAGE, "comes from finance", 1);
    const dt = textOf(PAGE);
    const r = anchor(dt, { ...second, start: 0 })!;
    expect(r.from).toBe(dt.text.indexOf("comes from finance", dt.text.indexOf("comes from finance") + 1));
  });

  test("context grows until unique", () => {
    // 32 characters either side are identical for both copies; only more context tells them apart.
    const common = "and then, after a long shared preamble, we say ";
    const tail = " and the same long shared ending follows it here.";
    const md = `Alpha ${common}the same sentence${tail}\n\nBeta ${common}the same sentence${tail}`;
    const a = anchorFor(md, "the same sentence", 1);
    expect(a.prefix.length).toBeGreaterThan(32);
    const dt = textOf(md);
    expect(anchor(dt, { ...a, start: 0 })!.from).toBe(dt.text.lastIndexOf("the same sentence"));
  });

  test("identical paragraphs: start decides", () => {
    const md = "Same line.\n\nSame line.\n\nSame line.";
    const dt = textOf(md);
    const third = dt.text.lastIndexOf("Same line");
    expect(anchor(dt, { exact: "Same line", prefix: "\n", suffix: ".", start: third })!.from).toBe(third);
  });

  test("a quote spanning two blocks is not found", () => {
    expect(anchor(textOf(PAGE), bare("all teams.\nBudget"))).toBeNull();
  });

  test("an edited passage is not found", () => {
    const a = anchorFor(PAGE, "end of Q3 for all teams");
    expect(found(PAGE.replace("end of Q3", "end of Q4"), a)).toBeNull();
  });

  test("deleted passage whose words exist elsewhere with other surroundings: NOT found (no false positive)", () => {
    const md = "Intro.\n\nWe ship the export feature on Friday morning.\n\nLater: the export feature is optional for now.";
    const a = anchorFor(md, "the export feature", 0);
    const without = md.replace("We ship the export feature on Friday morning.", "We ship on Friday.");
    expect(found(without, a)).toBeNull();
  });

  test("lines inserted far above: start is off, still found", () => {
    const a = anchorFor(PAGE, "comes from finance", 1);
    const md = PAGE.replace("# Release plan", "# Release plan\n\nA brand new paragraph.\n\nAnd another one, quite long, to move things.");
    expect(found(md, a)).toBe("comes from finance");
    const dt = textOf(md);
    expect(anchor(dt, a)!.from).toBe(dt.text.lastIndexOf("comes from finance"));
  });

  test("a paragraph inserted directly before: prefix broken, suffix still finds it", () => {
    const a = anchorFor(PAGE, "Budget approval comes");
    const md = PAGE.replace("Budget approval", "Something new in between.\n\nBudget approval");
    expect(found(md, a)).toBe("Budget approval comes");
  });

  test("text changed on both sides: not found", () => {
    const md = "Before words here. The key passage sits here. After words here.";
    const a = anchorFor(md, "The key passage sits here");
    expect(found("Totally new opener! The key passage sits here and a new ending", a)).toBeNull();
  });

  test("describe → anchor round trip at block starts and ends", () => {
    for (const q of ["Release plan", "The deadline", "too.", "A quoted line."]) expect(found(PAGE, anchorFor(PAGE, q))).toBe(q);
  });
});

group("anchor: tables, code and formatting", () => {
  test("inside a table cell", () => {
    expect(found(PAGE, anchorFor(PAGE, "Q3 for the platform team"))).toBe("Q3 for the platform team");
  });

  test("a quote across cells is not found", () => {
    expect(anchor(textOf(PAGE), bare("Priya\nQ3 for"))).toBeNull();
  });

  test("across a bold boundary", () => {
    expect(found(PAGE, anchorFor(PAGE, "deadline is end"))).toBe("deadline is end");
  });

  test("across lines of a code block, and after re-indenting", () => {
    const a = anchorFor(PAGE, 'const due = "Q3";\nship(due)');
    expect(found(PAGE, a)).toBe('const due = "Q3";\nship(due)');
    expect(found(PAGE.replace('const due = "Q3";\nship', 'const due = "Q3";\n    ship'), a)).toBe('const due = "Q3";\n    ship(due)');
  });

  test("comment marks on inline code, code blocks, bold and cells: right text, markdown unchanged", () => {
    const doc = markdownToDoc(PAGE);
    const base = docToMarkdown(doc);
    for (const q of ["deploy --prod", 'const due = "Q3";\nship', "deadline is end", "Q3 for the platform team"]) {
      const r = anchorInDoc(doc, anchorFor(PAGE, q))!;
      const marked = new Transform(doc).addMark(r.from, r.to, schema.marks.comment!.create({ id: "x" })).doc;
      let text = "";
      marked.nodesBetween(r.from, r.to, (n) => { if (n.isText && n.marks.some((m) => m.type.name === "comment")) text += n.text; });
      expect(text).toBe(q);
      expect(docToMarkdown(marked)).toBe(base);
    }
  });
});

group("model quotes", () => {
  test("markdown syntax is stripped", () => {
    expect(cleanQuote("**deadline** is end of Q3")).toEqual({ quote: "deadline is end of Q3" });
    expect(cleanQuote("run `deploy --prod` before")).toEqual({ quote: "run deploy --prod before" });
    expect(cleanQuote("- [ ] Budget sign-off today")).toEqual({ quote: "Budget sign-off today" });
  });
  test("cross-cell and short quotes are rejected", () => {
    expect(cleanQuote("| Data | Priya |")).toEqual({ problem: "crosses-cells" });
    expect(cleanQuote("Q3")).toEqual({ problem: "too-short" });
    expect(cleanQuote("end of Q3")).toEqual({ problem: "too-short" }); // 3 words, but under 12 characters
  });
});

group("comments CRUD", () => {
  test("ids are unique, created_rev is the next rev, statuses change", () => {
    let block = emptyBlock();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = addComment(block, { thinker: "c", title: `${i}`, anchor: bare("x") });
      ids.add(r.id);
      block = r.block;
    }
    expect(ids.size).toBe(50);
    const id = [...ids][0]!;
    expect(block.comments[id]!.created_rev).toBe(1);
    block = setStatus(block, id, "orphaned");
    expect(block.comments[id]!.orphaned_at).toBeString();
    block = setStatus(block, id, "open");
    expect(block.comments[id]!.orphaned_at).toBeUndefined();
  });

  test("cap is max(4, 20% of non-empty blocks)", () => {
    expect(commentCap(markdownToDoc("One.\n\nTwo."))).toBe(4);
    expect(commentCap(markdownToDoc(Array.from({ length: 40 }, (_, i) => `Para ${i}.`).join("\n\n")))).toBe(8);
  });
});

group("mergeBodies", () => {
  const base = "# T\n\nfirst\n\nsecond\n\nthird";
  test("an edit and an insertion right next to it merge, above and below", () => {
    expect(mergeBodies(base, base.replace("second", "second typed"), base.replace("first\n\n", "first\n\nnew\n\n"))).toBe("# T\n\nfirst\n\nnew\n\nsecond typed\n\nthird");
    expect(mergeBodies(base, base.replace("second", "second typed"), `${base}\n\nlast`)).toBe("# T\n\nfirst\n\nsecond typed\n\nthird\n\nlast");
    expect(mergeBodies(base, base.replace("third", "third typed"), `${base}\n\nlast`)).toBe("# T\n\nfirst\n\nsecond\n\nthird typed\n\nlast");
  });
  test("edits of different lines merge", () => {
    expect(mergeBodies(base, base.replace("first", "1st"), base.replace("third", "3rd"))).toBe("# T\n\n1st\n\nsecond\n\n3rd");
  });
  test("the same line changed two ways, or two different insertions at one place, conflict", () => {
    expect(mergeBodies(base, base.replace("second", "mine"), base.replace("second", "theirs"))).toBeNull();
    expect(mergeBodies(base, `${base}\n\nmine`, `${base}\n\ntheirs`)).toBeNull();
  });
  test("the same change made on both sides is kept once", () => {
    expect(mergeBodies(base, `${base}\n\nsame`, `${base}\n\nsame`)).toBe(`${base}\n\nsame`);
  });
  test("an insertion inside a replaced region conflicts", () => {
    const b = "a\nb\nc\nd";
    expect(mergeBodies(b, "a\nB\nC\nd", "a\nb\nx\nc\nd")).toBeNull();
  });
});

group("pruneOrphans", () => {
  const entry = (id: string, status: "open" | "orphaned" | "dismissed", orphaned_at?: string) => ({
    id, status, thinker: "t", title: id, anchor: { exact: id, prefix: "", suffix: "", start: 0 }, created: "x", created_rev: 1, ...(orphaned_at && { orphaned_at }),
  });
  const block = (...cs: ReturnType<typeof entry>[]) => ({ meta: { rev: 1, body_rev: 1, body_by: null }, comments: Object.fromEntries(cs.map((c) => [c.id, c])) });
  const now = new Date("2026-01-01T00:01:00.000Z");

  test("removes orphaned comments older than the keep time, and only those", () => {
    const b = block(
      entry("open1", "open"),
      entry("dismissed1", "dismissed"),
      entry("fresh", "orphaned", "2026-01-01T00:00:45.000Z"),
      entry("old", "orphaned", "2026-01-01T00:00:00.000Z"),
    );
    const r = pruneOrphans(b, now, 30_000);
    expect(r.removed).toEqual(["old"]);
    expect(Object.keys(r.block.comments).sort()).toEqual(["dismissed1", "fresh", "open1"]);
  });
  test("an orphan with no timestamp (a hand-edited file) is removed at once", () => {
    expect(pruneOrphans(block(entry("x", "orphaned")), now).removed).toEqual(["x"]);
  });
  test("nothing to remove returns the same block", () => {
    const b = block(entry("open1", "open"));
    expect(pruneOrphans(b, now).block).toBe(b);
  });
  test("nextOrphanExpiry is the earliest time an orphan becomes removable", () => {
    const b = block(entry("a", "orphaned", "2026-01-01T00:00:10.000Z"), entry("b", "orphaned", "2026-01-01T00:00:05.000Z"), entry("c", "open"));
    expect(nextOrphanExpiry(b, 30_000)).toBe(Date.parse("2026-01-01T00:00:35.000Z"));
    expect(nextOrphanExpiry(block(entry("c", "open")))).toBeNull();
  });
});

group("diffBodies", () => {
  const base = "# T\n\nfirst paragraph\n\nsecond paragraph\n\nthird";
  test("no change, no changes (even for whitespace the markdown can't hold)", () => {
    expect(diffBodies(base, base)).toEqual([]);
    expect(diffBodies(base, `${base}   \n`)).toEqual([]);
  });
  test("an appended paragraph is one added block", () => {
    const c = diffBodies(base, `${base}\n\nLast touched by the loop.`);
    expect(c.map((x) => x.kind)).toEqual(["added"]);
  });
  test("a paragraph changed in place is edited: the old line, then the new one, with only the changed words marked", () => {
    const c = diffBodies(base, base.replace("second paragraph", "second shiny paragraph"));
    expect(c).toHaveLength(1);
    const e = c[0]!;
    expect(e.kind).toBe("edited");
    if (e.kind !== "edited") return;
    expect(e.lines.map((l) => l.kind)).toEqual(["del", "add"]);
    const [del, add] = e.lines as { kind: string; words: { text: string; kind: string }[] }[];
    expect(add!.words.filter((w) => w.kind === "add").map((w) => w.text.trim()).filter(Boolean)).toEqual(["shiny"]);
    expect(del!.words.filter((w) => w.kind === "del")).toEqual([]);
    expect(add!.words.map((w) => w.text).join("")).toBe("second shiny paragraph");
    expect(del!.words.map((w) => w.text).join("")).toBe("second paragraph");
  });
  test("a removed paragraph, a replaced word and an insertion in one go", () => {
    const c = diffBodies(base, "# T\n\nfirst paragraph\n\nbrand new\n\nthird");
    expect(summarize(c)).toEqual({ added: 0, edited: 1, removed: 0 });
    expect(summarize(diffBodies(base, "# T\n\nfirst paragraph\n\nthird"))).toEqual({ added: 0, edited: 0, removed: 1 });
    expect(summarize(diffBodies(base, base.replace("first paragraph", "first paragraph\n\nnew one")))).toEqual({ added: 1, edited: 0, removed: 0 });
  });
  test("a heading turned into a paragraph is a removal plus an addition, not an edit", () => {
    expect(diffBodies(base, base.replace("# T", "T")).map((x) => x.kind)).toEqual(["removed", "added"]);
  });
  test("a table changed in a cell is one edited block", () => {
    const t = "| a | b |\n| - | - |\n| 1 | 2 |";
    const c = diffBodies(t, t.replace("| 1 |", "| 9 |"));
    expect(c.map((x) => x.kind)).toEqual(["edited"]);
  });
});

group("empty list items", () => {
  const cases: Record<string, string> = {
    "ordered, empty second item": "1. one\n2. \n3. three",
    "ordered, empty last item": "1. one\n2. ",
    "ordered, nested with empty items between": "1. Tag pi\n   1. it can research\n2. \n3. Proactive Agents\n   1. Tasks, or Research Items\n4. ",
    "bullets, empty items": "- a\n-\n- b\n- ",
    "task list, empty item": "- [ ] one\n- [ ] ",
    "an empty item alone": "1. ",
  };
  for (const [name, md] of Object.entries(cases)) {
    test(`${name}: parses to a valid page and survives a round trip`, () => {
      const doc = markdownToDoc(md);
      doc.check();
      const again = markdownToDoc(docToMarkdown(doc));
      expect(docToMarkdown(again)).toBe(docToMarkdown(doc));
      expect(docText(again).text).toBe(docText(doc).text);
    });
  }
  test("the text of the other items is kept", () => {
    expect(docText(markdownToDoc("1. one\n2. \n3. three")).text).toContain("three");
  });
  test("the fixture with a bit of everything parses", async () => {
    const md = await Bun.file(`${import.meta.dir}/fixtures/everything.md`).text();
    expect(() => markdownToDoc(md).check()).not.toThrow();
  });
});

group("generate markers", () => {
  const ids = (md: string) => {
    const found: string[] = [];
    markdownToDoc(md).descendants((n) => { if (n.type.name === "markerPoint") found.push(n.attrs.id); });
    return found;
  };
  const stable = (md: string) => {
    const once = docToMarkdown(markdownToDoc(md));
    expect(docToMarkdown(markdownToDoc(once))).toBe(once);
    return once;
  };

  const placements: Record<string, string> = {
    "on a line of its own": "Before.\n\n<!-- gen:abc -->\n\nAfter.",
    "in the middle of a sentence": "Hello <!-- gen:abc --> world",
    "at the start of a line, with text after it": "<!-- gen:abc --> starts the line",
    "at the end of a line": "ends the line <!-- gen:abc -->",
    "after a line break inside a paragraph": "text\n<!-- gen:abc -->\nmore",
    "in a list item": "- item <!-- gen:abc -->\n- other",
    "in a numbered list item": "1. item <!-- gen:abc -->\n2. other",
    "in a heading": "# Heading <!-- gen:abc -->",
    "in a quote": "> quoted <!-- gen:abc -->",
    "in a table cell": "| a | b |\n| - | - |\n| <!-- gen:abc --> | 2 |",
    "inside bold text": "**bold <!-- gen:abc --> still**",
  };
  for (const [name, md] of Object.entries(placements)) {
    test(`${name}: becomes one marker and is written back as the comment`, () => {
      expect(ids(md)).toEqual(["abc"]);
      expect(stable(md)).toContain("<!-- gen:abc -->");
    });
  }
  test("several markers keep their own ids, in order", () => {
    expect(ids("one <!-- gen:aaa --> two <!-- gen:bbb -->\n\n<!-- gen:ccc -->")).toEqual(["aaa", "bbb", "ccc"]);
    expect(stable("one <!-- gen:aaa --><!-- gen:bbb --> two")).toContain("<!-- gen:aaa --><!-- gen:bbb -->");
  });
  test("a marker alone is a paragraph with one marker, and nothing else is added to the file", () => {
    const doc = markdownToDoc("<!-- gen:abc -->");
    expect(doc.childCount).toBe(1);
    expect(doc.firstChild!.type.name).toBe("paragraph");
    expect(docToMarkdown(doc).trim()).toBe("<!-- gen:abc -->");
  });
  test("in a code block or inline code it is just text, and the page still loads", () => {
    expect(ids("```\n<!-- gen:abc -->\n```")).toEqual([]);
    expect(ids("see `<!-- gen:abc -->` here")).toEqual([]);
    expect(stable("```\n<!-- gen:abc -->\n```")).toContain("<!-- gen:abc -->");
    expect(stable("see `<!-- gen:abc -->` here")).toContain("`<!-- gen:abc -->`");
  });
  test("anything that isn't exactly gen: plus 3 to 6 of a-z0-9 stays ordinary text", () => {
    for (const bad of ["<!-- gen:ab -->", "<!-- gen:abcdefg -->", "<!-- gen:ABC -->", "<!-- gen:a-c -->", "<!--gen:abc-->", "<!-- other:abc -->", "<!-- gen: abc -->"]) {
      expect(ids(`x ${bad} y`)).toEqual([]);
      expect(docToMarkdown(markdownToDoc(`x ${bad} y`))).toBe(`x ${bad} y`); // an ordinary HTML comment, kept as written
    }
  });
  test("the comment typed as plain text is not a marker, even after saving and reloading", () => {
    const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<!-- gen:abc -->" }] }] });
    const md = docToMarkdown(doc);
    expect(md).not.toContain("<!-- gen:abc -->");
    expect(ids(md)).toEqual([]);
  });
  test("a marker is one space in the page text, so quotes around it still anchor", () => {
    const doc = markdownToDoc("Hello <!-- gen:abc -->world today");
    const dt = docText(doc);
    expect(dt.text).toBe("Hello  world today");
    const found = anchor(dt, describe(dt, dt.text.indexOf("world"), dt.text.length))!;
    expect(doc.textBetween(dt.toPos(found.from)!, dt.toPos(found.to)!)).toBe("world today");
  });
});

group("an empty list item at the end of the page", () => {
  const items = (md: string) => { let n = 0; markdownToDoc(md).descendants((x) => { if (x.type.name === "listItem") n++; }); return n; };
  for (const md of ["1. a\n2. ", "- a\n- ", "1. Invoke\n   1. How\n      1. via Tagging\n      2. ", "- [ ] a\n- [ ] "]) {
    test(`${JSON.stringify(md)} keeps its empty last item through the file`, () => {
      const file = serializeFile(md, emptyBlock());
      expect(items(parseFile(file).markdown)).toBe(items(md));
      // and through a second round: the file it would write now
      const again = serializeFile(docToMarkdown(markdownToDoc(parseFile(file).markdown)), emptyBlock());
      expect(items(parseFile(again).markdown)).toBe(items(md));
    });
  }
  test("blank lines and trailing spaces after ordinary text are still dropped", () => {
    expect(parseFile(serializeFile("text\n\n\n", emptyBlock())).markdown).toBe("text");
    expect(parseFile(serializeFile("   ", emptyBlock())).markdown).toBe("");
    expect(parseFile(serializeFile("", emptyBlock())).markdown).toBe("");
  });
});

group("diff lines: newlines and structure are kept", () => {
  const edit = (before: string, after: string) => {
    const c = diffBodies(before, after);
    expect(c).toHaveLength(1);
    const e = c[0]!;
    expect(e.kind).toBe("edited");
    return e.kind === "edited" ? e.lines : [];
  };
  const text = (l: DiffLine) => (l.kind === "gap" ? `gap:${l.count}` : l.words.map((w) => w.text).join(""));
  const view = (lines: DiffLine[]) => lines.map((l) => `${l.kind === "gap" ? "~" : l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${text(l)}`);

  test("a line break inside a paragraph is a line break in the diff", () => {
    expect(view(edit("one  \ntwo  \nthree", "one  \ntwo changed  \nthree"))).toEqual([" one", "-two", "+two changed", " three"]);
  });
  test("a changed list item is one old line and one new line, among its neighbours", () => {
    const lines = edit("- alpha\n- beta\n- gamma\n- delta\n- epsilon", "- alpha\n- beta\n- gamma changed\n- delta\n- epsilon");
    expect(view(lines)).toEqual([" • alpha", " • beta", "-• gamma", "+• gamma changed", " • delta", " • epsilon"]);
  });
  test("an added list item is its own line, and numbering is shown as the page shows it", () => {
    expect(view(edit("1. a\n2. b", "1. a\n2. b\n3. c"))).toEqual([" 1. a", " 2. b", "+3. c"]);
    expect(view(edit("1. a\n2. b\n3. c", "1. a\n3. c"))).toEqual([" 1. a", "-2. b", "-3. c", "+2. c"]);
  });
  test("a nested list is indented, a task shows its box, a quote its marker", () => {
    expect(view(edit("- a\n  - b\n  - c", "- a\n  - b\n  - c2"))).toEqual([" • a", "   • b", "-  • c", "+  • c2"]);
    expect(view(edit("- [ ] todo", "- [x] todo"))).toEqual(["-☐ todo", "+☑ todo"]);
    expect(view(edit("> one\n> two", "> one\n> two!"))).toEqual([" > one", "-> two", "+> two!"]);
  });
  test("a table row is one line, cells separated, and a cell edit marks just that line", () => {
    const lines = edit("| a | b |\n| - | - |\n| one | two |\n| three | four |", "| a | b |\n| - | - |\n| one | 2 |\n| three | four |");
    expect(view(lines)).toEqual([" a │ b", "-one │ two", "+one │ 2", " three │ four"]);
  });
  test("a code block's own lines are kept, one change per line", () => {
    const lines = edit("```\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```", "```\nconst a = 1;\nconst b = 20;\nconst c = 3;\n```");
    expect(view(lines)).toEqual([" const a = 1;", "-const b = 2;", "+const b = 20;", " const c = 3;"]);
  });
  test("long runs of unchanged lines fold into a gap", () => {
    const items = Array.from({ length: 12 }, (_, i) => `- item ${i}`);
    const after = [...items];
    after[10] = "- item 10 changed";
    const v = view(edit(items.join("\n"), after.join("\n")));
    expect(v).toEqual(["~gap:9", " • item 9", "-• item 10", "+• item 10 changed", " • item 11"]);
  });
  test("every line's words glue back into the line, whitespace and all", () => {
    for (const l of edit("one two  three\nfour five", "one 2  three\nfour five six")) {
      if (l.kind !== "gap") expect(l.words.map((w) => w.text).join("")).toBe(text(l));
    }
  });
  test("a heading keeps its # and a hard break inside a list item is a continuation line", () => {
    expect(view(edit("## Title here", "## Title there"))).toEqual(["-## Title here", "+## Title there"]);
    expect(view(edit("- one  \n  two", "- one  \n  two!"))).toEqual([" • one", "-  two", "+  two!"]);
  });
});

group("sel ranges", () => {
  const ranges = (md: string) => {
    const found: { id: string; text: string }[] = [];
    markdownToDoc(md).descendants((n) => {
      for (const m of n.marks) if (m.type.name === "markerRange") found.push({ id: m.attrs.id, text: n.isText ? n.text! : n.type.name });
    });
    return found;
  };
  const text = (md: string) => ranges(md).map((r) => r.text).join("");
  const stable = (md: string) => {
    const once = docToMarkdown(markdownToDoc(md));
    expect(docToMarkdown(markdownToDoc(once))).toBe(once);
    return once;
  };

  const placements: Record<string, [string, string]> = {
    "in the middle of a sentence": ["Hello <!-- sel:abc -->selected text<!-- /sel:abc --> and more", "selected text"],
    "around a whole paragraph": ["<!-- sel:abc -->the whole paragraph<!-- /sel:abc -->", "the whole paragraph"],
    "around bold and plain text": ["A <!-- sel:abc -->**bold** and plain<!-- /sel:abc --> end", "bold and plain"],
    "inside bold text": ["A **b <!-- sel:abc -->old<!-- /sel:abc --> c** d", "old"],
    "in a list item": ["- item <!-- sel:abc -->here<!-- /sel:abc -->\n- other", "here"],
    "in a numbered item": ["1. item <!-- sel:abc -->here<!-- /sel:abc -->\n2. other", "here"],
    "in a heading": ["# Head <!-- sel:abc -->line<!-- /sel:abc -->", "line"],
    "in a quote": ["> quoted <!-- sel:abc -->words<!-- /sel:abc -->", "words"],
    "in a table cell": ["| a | b |\n| - | - |\n| <!-- sel:abc -->cell<!-- /sel:abc --> | 2 |", "cell"],
    "around a link": ["see <!-- sel:abc -->[the docs](https://x.y)<!-- /sel:abc --> now", "the docs"],
  };
  for (const [name, [md, selected]] of Object.entries(placements)) {
    test(`${name}: one range over the selected text, written back as the pair of comments`, () => {
      expect(text(md)).toBe(selected);
      expect(new Set(ranges(md).map((r) => r.id))).toEqual(new Set(["abc"]));
      const out = stable(md);
      expect(out).toContain("<!-- sel:abc -->");
      expect(out).toContain("<!-- /sel:abc -->");
    });
  }
  test("the same range in two paragraphs (a selection across them) pairs up in each", () => {
    const md = "<!-- sel:abc -->first<!-- /sel:abc -->\n\n<!-- sel:abc -->second<!-- /sel:abc -->";
    expect(ranges(md).map((r) => `${r.id}:${r.text}`)).toEqual(["abc:first", "abc:second"]);
    stable(md);
  });
  test("a line break inside a range stays inside one pair of comments", () => {
    // The break is a node, not text, so the dialect writes the pair around the whole run (`nodeRangesToText`).
    const md = "line <!-- sel:abc -->one  \ntwo<!-- /sel:abc -->";
    const out = stable(md);
    expect(out).toBe(md);
    expect(out.match(/<!-- sel:abc -->/g)).toHaveLength(1);
    expect(new Set(ranges(out).map((r) => r.id))).toEqual(new Set(["abc"]));
  });
  test("a sel range and a gen marker can share a page, even a range around a marker", () => {
    const md = "A <!-- gen:zzz --> b <!-- sel:abc -->range <!-- gen:yyy --> inside<!-- /sel:abc -->";
    let gens: string[] = [];
    markdownToDoc(md).descendants((n) => { if (n.type.name === "markerPoint") gens.push(n.attrs.id); });
    expect(gens).toEqual(["zzz", "yyy"]);
    expect(ranges(md).length).toBeGreaterThan(0);
    const out = stable(md);
    expect(out).toContain("<!-- gen:zzz -->");
    expect(out).toContain("<!-- gen:yyy -->");
  });
  test("a lone start, a lone end, a mismatched end or overlapping ranges stay as written, as ordinary comments: nothing is lost", () => {
    for (const md of [
      "x <!-- sel:abc --> lone start",
      "x lone end <!-- /sel:abc --> y",
      "mismatch <!-- sel:abc -->x<!-- /sel:xyz -->",
      "overlap <!-- sel:aaa -->a <!-- sel:bbb -->b<!-- /sel:aaa --> c<!-- /sel:bbb -->",
      "across<!-- sel:abc -->two\n\nparagraphs<!-- /sel:abc -->",
    ]) {
      expect(ranges(md)).toEqual([]);
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    }
  });
  test("in code, or with an id that isn't 3 to 6 of a-z0-9, a range is just text", () => {
    for (const md of ["```\n<!-- sel:abc -->in code<!-- /sel:abc -->\n```", "`<!-- sel:abc -->x<!-- /sel:abc -->` inline", "a <!-- do:ab -->x<!-- /do:ab --> b", "a <!-- do:ABC -->x<!-- /do:ABC --> b", "a <!--sel:abc-->x<!--/sel:abc--> b"]) {
      expect(ranges(md)).toEqual([]);
    }
    expect(stable("```\n<!-- sel:abc -->in code<!-- /sel:abc -->\n```")).toContain("<!-- sel:abc -->in code<!-- /sel:abc -->");
  });
  test("the pair typed as plain text is not a range, even after saving and reloading", () => {
    const doc = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<!-- sel:abc -->x<!-- /sel:abc -->" }] }] });
    const md = docToMarkdown(doc);
    expect(md).not.toContain("<!-- sel:abc -->");
    expect(ranges(md)).toEqual([]);
  });
  test("a range doesn't change the page text, so anchors around it line up", () => {
    const plain = docText(markdownToDoc("Hello selected text and more")).text;
    expect(docText(markdownToDoc("Hello <!-- sel:abc -->selected text<!-- /sel:abc --> and more")).text).toBe(plain);
  });
  test("a range added to a paragraph shows in the review diff as ⟦ ⟧ around the text, and a marker as [complete]", () => {
    const [change] = diffBodies("Hello selected text and more", "Hello <!-- sel:abc -->selected text<!-- /sel:abc --> and more");
    expect(change!.kind).toBe("edited");
    if (change!.kind !== "edited") return;
    const lines = change!.lines.map((l) => (l.kind === "gap" ? "" : `${l.kind}:${l.words.map((w) => w.text).join("")}`));
    expect(lines).toEqual(["del:Hello selected text and more", "add:Hello ⟦selected text⟧ and more"]);
    const [said] = diffBodies("Hello selected text", `Hello <!-- sel:abc "shorter" -->selected text<!-- /sel:abc -->`);
    expect(said!.kind === "edited" && said!.lines.map((l) => (l.kind === "gap" ? "" : l.words.map((w) => w.text).join("")))).toEqual(["Hello selected text", `Hello ⟦selected text⟧ → "shorter"`]);
    const [m] = diffBodies("Hello", "Hello <!-- gen:abc -->");
    expect(m!.kind === "edited" && m!.lines.some((l) => l.kind === "add" && l.words.some((w) => w.text.includes("[complete]")))).toBe(true);
  });
});

group("placeholders that leak into a save", () => {
  const OPEN = "", CLOSE = "";
  const leaked = `1\\. ${OPEN}ssel:wcy${CLOSE}solipsist${OPEN}esel:wcy${CLOSE}\n\nand ${OPEN}pgen:67g${CLOSE} here`;
  const bare = (md: string) => /[]/.test(md);

  test("scrubMarkers turns leaked tokens back into their comments and drops stray characters", () => {
    const out = scrubMarkers(leaked);
    expect(out).toContain("<!-- sel:wcy -->solipsist<!-- /sel:wcy -->");
    expect(out).toContain("<!-- gen:67g -->");
    expect(bare(out)).toBe(false);
    expect(scrubMarkers(`a${OPEN}b`)).toBe("ab");
    expect(scrubMarkers("plain <!-- gen:abc --> text")).toBe("plain <!-- gen:abc --> text");
  });
  test("the server cleans a body that arrives with leaked tokens, so the file never holds them", () => {
    const src = serializeFile("# T", emptyBlock());
    const r = applyPut(src, { client_id: "a", base_rev: 0, markdown: leaked, comments: {} });
    expect(r.ok).toBe(true);
    expect(bare(r.file)).toBe(false);
    expect(parseFile(r.file).markdown).toContain("<!-- sel:wcy -->solipsist<!-- /sel:wcy -->");
  });
  test("a page whose file already holds leaked tokens loads as the range and marker they stand for", () => {
    const doc = markdownToDoc(leaked);
    let ranges = 0, markers = 0;
    doc.descendants((n) => {
      if (n.type.name === "markerPoint") markers++;
      if (n.marks.some((m) => m.type.name === "markerRange")) ranges++;
    });
    expect([ranges, markers]).toEqual([1, 1]);
    expect(docToMarkdown(doc)).toContain("<!-- sel:wcy -->solipsist<!-- /sel:wcy -->");
    expect(bare(docToMarkdown(doc))).toBe(false);
  });
  test("what the editor writes is never leaky, for every kind of placeholder and place", () => {
    for (const md of ["a <!-- sel:abc -->b<!-- /sel:abc --> c", "<!-- gen:abc -->", "- x <!-- sel:abc -->y<!-- /sel:abc -->", "1\\. <!-- sel:abc -->solipsist<!-- /sel:abc -->", "# <!-- sel:abc -->h<!-- /sel:abc -->"]) {
      expect(bare(docToMarkdown(markdownToDoc(md)))).toBe(false);
    }
  });
});

test("code next to bold or a link in one run loads (code excludes the other marks) instead of throwing", async () => {
  const { markdownToDoc, docToMarkdown } = await import("../src/shared/docfile");
  for (const md of ["**`plan-0.md` — finish it.** Then more.", "[`a.md`](https://x.test) and *`b`*"]) {
    const doc = markdownToDoc(md);
    expect(() => doc.check()).not.toThrow();
    expect(docToMarkdown(doc)).toContain("`");
  }
});

group("text after the comments block", () => {
  const block = serializeFile("# T", emptyBlock()).slice("# T".length).trim();
  test("added below it by hand (`echo … >> page.md`) is the end of the body", () => {
    const f = parseFile(`# T\n\nBody.\n\n${block}\n\nAppended.\nAnd more.\n`);
    expect(f.markdown).toBe("# T\n\nBody.\n\nAppended.\nAnd more.");
    expect(f.block).toEqual(emptyBlock());
    expect(f.problem).toBeUndefined();
  });
  test("after a block that doesn't read, the file is all body, as before", () => {
    const src = "# T\n\n<!-- solip-comments\n[not, a, mapping\n-->\n\nAppended.\n";
    expect(parseFile(src)).toEqual({ markdown: src, block: emptyBlock(), format: 1 });
  });
});
