// The tree merge: changes to different blocks, list items, table rows or cells never conflict; a text block changed on
// both sides does, unless one side only finished a marker in it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { TextSelection } from "@tiptap/pm/state";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mergeBodies } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

describe("mergeBodies", () => {
  test("an ordered-list item added by hand while the writer edits a later item: merged, numbered once", () => {
    const base = "1. one\n2. two\n3. three";
    expect(mergeBodies(base, "1. one\n2. two\n3. three, edited", "1. one\n2. new\n3. two\n4. three")).toBe("1. one\n2. new\n3. two\n4. three, edited");
  });

  test("different cells of one row: merged", () => {
    const base = "| A | B |\n| --- | --- |\n| x | y |";
    expect(mergeBodies(base, "| A | B |\n| --- | --- |\n| x mine | y |", "| A | B |\n| --- | --- |\n| x | y theirs |")).toBe("| A | B |\n| --- | --- |\n| x mine | y theirs |");
  });

  test("a code fence growing on one side, a paragraph added after the block on the other: merged", () => {
    const base = "```\ncode\n```";
    const mine = "````\ncode ```\n````";
    expect(mergeBodies(base, mine, `${base}\n\nAfter.`)).toBe(`${mine}\n\nAfter.`);
  });

  test("a task ticked on one side and its text edited on the other: merged", () => {
    expect(mergeBodies("- [ ] buy milk\n- [ ] call", "- [ ] buy oat milk\n- [ ] call", "- [x] buy milk\n- [ ] call")).toBe("- [x] buy oat milk\n- [ ] call");
  });

  test("a list's start changed on one side and an item on the other: merged", () => {
    expect(mergeBodies("3. a\n4. b", "3. a\n4. b!", "5. a\n6. b")).toBe("5. a\n6. b!");
  });

  test("nested: different items of a list inside a quote", () => {
    expect(mergeBodies("> - a\n> - b", "> - a mine\n> - b", "> - a\n> - b theirs")).toBe("> - a mine\n> - b theirs");
  });

  test("an insertion by the writer right next to a block they changed: merged", () => {
    expect(mergeBodies("A.\n\nB.\n\nC.", "A.\n\nNew.\n\nB.\n\nC.", "A.\n\nB, theirs.\n\nC.")).toBe("A.\n\nNew.\n\nB, theirs.\n\nC.");
    expect(mergeBodies("A.\n\nB.\n\nC.", "A.\n\nB.\n\nNew.\n\nC.", "A.\n\nB, theirs.\n\nC.")).toBe("A.\n\nB, theirs.\n\nNew.\n\nC.");
  });

  test("the same insertion made on both sides, next to other edits, is kept once", () => {
    expect(mergeBodies("A.\n\nB.\n\nC.", "A, mine.\n\nB.\n\nSame.\n\nC.", "A.\n\nB.\n\nSame.\n\nC, theirs.")).toBe("A, mine.\n\nB.\n\nSame.\n\nC, theirs.");
  });

  test("two neighbouring items changed on one side, a different part of one of them on the other: merged", () => {
    // The diff groups the two items into one change, which used to overlap the other side's without lining up.
    expect(mergeBodies("- A\n  - B\n- C\n  - D", "- A\n  - B w\n- C\n  - D w", "- A\n  - B\n- C h\n  - D")).toBe("- A\n  - B w\n- C h\n  - D w");
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    expect(mergeBodies(table, table.replace("| 1 |", "| 1x |").replace("| 3 |", "| 3x |"), table.replace("| 4 |", "| 4y |"))).toBe("| a | b |\n| --- | --- |\n| 1x | 2 |\n| 3x | 4y |");
  });

  test("a block changed and a block added after it on one side, the changed one edited elsewhere on the other: merged", () => {
    // The diff groups the change and the insertion into one change (one block became two); each is now taken apart.
    const base = "- A <!-- gen:abc -->\n- B";
    expect(mergeBodies(base, "- A <!-- gen:abc -->\n- B, mine", "- A filled\n- B\n\nAdded by hand.")).toBe("- A filled\n- B, mine\n\nAdded by hand.");
    expect(mergeBodies("A.\n\nB.", "A.\n\nB, mine.", "New first.\n\nA, theirs.\n\nB.")).toBe("New first.\n\nA, theirs.\n\nB, mine.");
  });

  test("a block the writer left as it was keeps their copy: a trailing space just typed is not lost", () => {
    expect(mergeBodies("Hello there.\n\nB b.", "Hello there. \n\nB b.", "Hello there.\n\nB b.\n\nC c.")).toBe("Hello there. \n\nB b.\n\nC c.");
  });

  describe("still a conflict", () => {
    test("the same paragraph changed on both sides, even in different sentences", () => {
      expect(mergeBodies("One. Two.", "One! Two.", "One. Two!")).toBeNull();
    });
    test("the same cell changed on both sides", () => {
      const base = "| A |\n| --- |\n| x |";
      expect(mergeBodies(base, "| A |\n| --- |\n| x1 |", "| A |\n| --- |\n| x2 |")).toBeNull();
    });
    test("a block deleted on one side and edited on the other", () => {
      expect(mergeBodies("A.\n\nB.\n\nC.", "A.\n\nC.", "A.\n\nB, edited.\n\nC.")).toBeNull();
    });
    test("two different insertions at one place", () => {
      expect(mergeBodies("A.", "A.\n\nmine", "A.\n\ntheirs")).toBeNull();
    });
    test("the same attribute changed two ways", () => {
      expect(mergeBodies("# T", "## T", "### T")).toBeNull();
    });
  });

  describe("placeholder fills", () => {
    test("a gen marker filled by the agent while the writer typed elsewhere in the paragraph: both kept", () => {
      const base = "Start <!-- gen:abc --> end.";
      expect(mergeBodies(base, "Start <!-- gen:abc --> end, and more.", "Start continued text end.")).toBe("Start continued text end, and more.");
    });
    test("a sel range finished (comments removed, result after it) while the writer typed before it: both kept", () => {
      const base = "Intro. <!-- sel:abc -->List risks<!-- /sel:abc --> here.";
      const theirs = "Intro. List risks: late data, no owner. here.";
      expect(mergeBodies(base, "Intro, typed. <!-- sel:abc -->List risks<!-- /sel:abc --> here.", theirs)).toBe("Intro, typed. List risks: late data, no owner. here.");
    });
    test("a fill that brings a follow-up placeholder keeps it", () => {
      expect(mergeBodies("A <!-- gen:abc --> b.", "A <!-- gen:abc --> b, typed.", "A filled <!-- sel:xyz -->check<!-- /sel:xyz --> b.")).toBe("A filled <!-- sel:xyz -->check<!-- /sel:xyz --> b, typed.");
    });
    test("several placeholders finished in the paragraph the writer typed in: each fill lands at its own", () => {
      const base = "A <!-- gen:abc --> b <!-- gen:xyz --> c.";
      expect(mergeBodies(base, "A <!-- gen:abc --> b <!-- gen:xyz --> c, typed.", "A one b two c.")).toBe("A one b two c, typed.");
      // a point and a range, the writer typing between them
      const mixed = "A <!-- gen:abc --> b <!-- sel:xyz -->task<!-- /sel:xyz --> c.";
      expect(mergeBodies(mixed, "A <!-- gen:abc --> b, typed, <!-- sel:xyz -->task<!-- /sel:xyz --> c.", "A one b task: done c.")).toBe("A one b, typed, task: done c.");
      // one finished and one only acked (states are merged apart from the text)
      expect(mergeBodies(base, "A <!-- gen:abc --> b <!-- gen:xyz --> c, typed.", "A one b <!-- gen:xyz --> c.")).toBe("A one b <!-- gen:xyz --> c, typed.");
    });
    test("a fill after the writer deleted the marker: a conflict", () => {
      expect(mergeBodies("Start <!-- gen:abc --> end.", "Start end, typed.", "Start continued text end.")).toBeNull();
    });
    test("their other edits in the same block are not a fill: a conflict", () => {
      expect(mergeBodies("Start <!-- gen:abc --> end.", "Start <!-- gen:abc --> end, typed.", "Begin continued text end.")).toBeNull();
    });
  });
});

describe("the page", () => {
  test("the agent fills a gen marker in the paragraph the writer is typing in: merged, the caret where it was", async () => {
    const server = new Server("# Notes\n\nThe plan is <!-- gen:abc --> and then we ship.");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("then we ship.", " Soon");
    const caret = tab.state.selection.head;
    server.handEdit((md) => md.replace("<!-- gen:abc -->", "to test first"));
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toBe("# Notes\n\nThe plan is to test first and then we ship. Soon");
    expect(tab.state.selection.head).toBe(caret - 1 + "to test first".length); // the marker (one position) became the text
    tab.typeAtCaret("!");
    expect(tab.markdown.endsWith("Soon!")).toBe(true);
  });

  test("the agent acks a sel range in one list item while the writer edits another: merged, no review", async () => {
    const server = new Server("- <!-- sel:abc -->plan it<!-- /sel:abc -->\n- second");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("second", " item");
    server.handEdit((md) => md.replaceAll("sel:abc -->", "sel:abc:ack -->"));
    expect(tab.receive(server.src)).not.toBe("conflict");
    expect(tab.markdown).toBe("- <!-- sel:abc:ack -->plan it<!-- /sel:abc:ack -->\n- second item");
  });

  test("no conflict when the writer and the outside edit touched different cells", async () => {
    const server = new Server("| A | B |\n| --- | --- |\n| x | y |");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("x", " mine");
    server.handEdit((md) => md.replace("| y |", "| y theirs |"));
    expect(tab.receive(server.src)).toBe("merged");
    expect(tab.markdown).toBe("| A | B |\n| --- | --- |\n| x mine | y theirs |");
  });

  test("two tabs edit different cells of one row: the second merges, both saves land", async () => {
    const server = new Server("| Team | Owner | Status |\n| --- | --- | --- |\n| Backend | Priya | waiting |");
    const a = new Tab(server.src);
    const b = new Tab(server.src);
    a.typeAfter("Priya", " and Ana");
    b.typeAfter("waiting", " (week 2)");
    await a.save(server);
    expect(b.receive(server.src)).toBe("merged");
    await b.save(server);
    expect(server.markdown).toBe("| Team | Owner | Status |\n| --- | --- | --- |\n| Backend | Priya and Ana | waiting (week 2) |");
  });

  test("the caret in a block the file replaces outright lands in text, not between blocks", async () => {
    const server = new Server("A.\n\nB here.\n\nC.");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find("B here.").to)));
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: unknown) => void warnings.push(String(m));
    try {
      server.handEdit((md) => md.replace("B here.", "- B here, as a list item."));
      expect(tab.receive(server.src)).toBe("reloaded");
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
    expect(tab.state.selection.$head.parent.inlineContent).toBe(true);
  });

  test("the caret stays in its cell when a hand edit changes another cell of the row", async () => {
    const server = new Server("| A | B |\n| --- | --- |\n| x | y |");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, tab.find("x").to)));
    tab.typeAtCaret("1");
    server.handEdit((md) => md.replace("| y |", "| y2 |"));
    expect(tab.receive(server.src)).toBe("merged");
    tab.typeAtCaret("2");
    expect(tab.markdown).toBe("| A | B |\n| --- | --- |\n| x12 | y2 |");
  });
});
