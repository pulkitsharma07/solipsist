// Suggestions in the page: the agent's result shown where it would go, and the writer accepting, rejecting or asking
// again, by the card, the keys or the status bar's menu (`src/app/editor/suggestions.ts`).
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

const { decideAll, decideSuggestion, goToSuggestion, suggestionsIn } = await import("../src/app/editor/suggestions");

const reply = (text: string, mode = "at", place = "inline", note = "Did it.") => `<suggestion mode="${mode}" place="${place}">\n${text}\n</suggestion>\n<note>${note}</note>`;

/** A page open in a tab, with the agent's run on `id` already turned into a suggestion. */
async function suggested(body: string, id: string, answer: string) {
  const server = new Server(body);
  const tab = new Tab(server.src);
  document.body.append(tab.editor.view.dom);
  await tab.save(server);
  expect(server.agentRun(id, answer)).toMatchObject({ done: expect.stringMatching(/suggested|declined/) });
  tab.receive(server.src);
  return { server, tab };
}
const dom = (tab: Tab) => tab.editor.view.dom;
const caretAt = (tab: Tab, pos: number) => tab.dispatch(tab.state.tr.setSelection(TextSelection.create(tab.doc, pos)));
const press = (tab: Tab, key: string, mods: { meta?: boolean; alt?: boolean; ctrl?: boolean } = {}) => {
  const e = new KeyboardEvent("keydown", { key, metaKey: !!mods.meta && mac, ctrlKey: (!!mods.meta && !mac) || !!mods.ctrl, altKey: !!mods.alt, bubbles: true, cancelable: true });
  dom(tab).dispatchEvent(e);
};

describe("what the page shows", () => {
  test("a point's suggestion: its result in place, marked, and the page itself unchanged", async () => {
    const { tab } = await suggested("The deadline is end of Q3 <!-- gen:abc --> for all teams.", "abc", reply("(30 *September*)"));
    const p = dom(tab).querySelector<HTMLElement>('.sug-preview[data-sug="abc"]')!;
    expect(p.classList.contains("sug-inline")).toBe(true);
    expect(p.textContent).toBe("(30 September)");
    expect(p.querySelector("em")?.textContent).toBe("September");
    expect(tab.markdown).toBe("The deadline is end of Q3 <!-- gen:abc:sug --> for all teams.");
    expect(suggestionsIn(tab.state).map((s) => s.id)).toEqual(["abc"]);
  });

  test("blocks: drawn as blocks", async () => {
    const { tab } = await suggested("# Plan\n\n<!-- gen:abc -->\n\nAfter.", "abc", reply("| Team | Date |\n| --- | --- |\n| Web | 3 Sep |", "at", "blocks"));
    const p = dom(tab).querySelector<HTMLElement>('.sug-preview[data-sug="abc"]')!;
    expect(p.tagName).toBe("DIV");
    expect(p.querySelector("table")).not.toBeNull();
  });

  test("a result after a range: the range keeps its text, the result follows it", async () => {
    const { tab } = await suggested("Check <!-- sel:abc -->end of Q3<!-- /sel:abc --> here.", "abc", reply("(30 Sep)", "after"));
    expect(dom(tab).querySelector(".sug-old")).toBeNull();
    expect(dom(tab).querySelector('.sug-preview[data-sug="abc"]')!.textContent).toBe("(30 Sep)");
  });

  test("a decline: a chip with the reason, no preview", async () => {
    const { tab } = await suggested("A <!-- gen:abc --> b.", "abc", "<decline>Nothing says what goes here.</decline>");
    expect(dom(tab).querySelector(".sug-preview")).toBeNull();
    expect(dom(tab).querySelector(".sug-declined")!.textContent).toBe("Declined: Nothing says what goes here.");
    expect(suggestionsIn(tab.state)[0]).toMatchObject({ id: "abc", declined: true });
  });

  test("a suggestion that arrives while the page is open shows at once, next to the writer's typing", async () => {
    const server = new Server("First <!-- gen:abc --> para.\n\nSecond para.");
    const tab = new Tab(server.src);
    await tab.save(server);
    tab.typeAfter("Second para.", " Typed.");
    server.agentRun("abc", reply("inserted"));
    tab.receive(server.src);
    expect(dom(tab).querySelector('.sug-preview[data-sug="abc"]')!.textContent).toBe("inserted");
    expect(tab.markdown).toBe("First <!-- gen:abc:sug --> para.\n\nSecond para. Typed.");
  });
});

describe("the card beside the diff", () => {
  const hover = (el: Element) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("hovering the diff shows it with Accept, Reject, Ask again and Chat; it stays while the pointer is on the card, and goes once it leaves both", async () => {
    const { tab } = await suggested("Plan: <!-- sel:abc -->the long sentence<!-- /sel:abc --> end.", "abc", reply("short", "replace"));
    // The struck-through text is part of the diff too.
    hover(dom(tab).querySelector('.sug-old[data-sug="abc"]')!);
    // The newest card: editors of earlier tests are never destroyed, and theirs come back on the next scroll.
    const card = [...document.querySelectorAll<HTMLElement>(".sug-side .sug-card")].at(-1)!;
    // A sel's Accept has a dropdown beside it (Accept as a Button, task-button-ui.test.ts).
    expect([...card.querySelector(".sug-actions")!.getElementsByTagName("button")].map((b) => b.textContent)).toEqual(["Accept", "▾", "Reject", "Ask again", "Chat"]);
    hover(card.querySelector("button")!);
    await wait(300);
    expect(document.querySelector(".sug-card")).not.toBeNull();
    hover(document.body);
    expect(document.querySelector(".sug-card")).not.toBeNull(); // a moment to reach the card
    await wait(300);
    expect(document.querySelector(".sug-card")).toBeNull();
  });

  test("a click pins it: the pointer leaving doesn't hide it, Escape does; hovering another diff shows that one's meanwhile", async () => {
    const { server, tab } = await suggested("A <!-- gen:abc --> and B <!-- gen:xyz --> end.", "abc", reply("one"));
    server.agentRun("xyz", reply("two"));
    tab.receive(server.src);
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    hover(document.body);
    await wait(300);
    expect(document.querySelector(".sug-side")!.textContent).toContain("Suggestion");
    hover(dom(tab).querySelector('[data-sug="xyz"]')!);
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.for).toBe("xyz");
    hover(document.body);
    await wait(300);
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.for).toBe("abc"); // back to the pinned one
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".sug-side")).toBeNull();
  });

  test("stickyTop: level with the diff, held in view while any of it is", async () => {
    const { stickyTop } = await import("../src/app/editor/sideCard");
    const view = { top: 50, bottom: 750 };
    expect(stickyTop({ top: 200, bottom: 1500 }, 150, view)).toBe(200); // level with its top
    expect(stickyTop({ top: -600, bottom: 1500 }, 150, view)).toBe(50); // a large diff scrolled up: held at the top
    expect(stickyTop({ top: -1200, bottom: 400 }, 150, view)).toBe(50); // still held, the card within the diff
    expect(stickyTop({ top: -1200, bottom: 120 }, 150, view)).toBe(50); // only its end in view: the card stays whole, in view
    expect(stickyTop({ top: 700, bottom: 720 }, 150, view)).toBe(600); // near the bottom edge: kept on screen
    expect(stickyTop({ top: 300, bottom: 320 }, 150, view)).toBe(300); // a diff shorter than the card: level with it
    expect(stickyTop({ top: -500, bottom: 40 }, 150, view)).toBeNull(); // out of view
    expect(stickyTop({ top: 800, bottom: 900 }, 150, view)).toBeNull();
  });
});

describe("an answer to a question about the text", () => {
  test("the text stays as it is, with an Answered chip; the card shows the answer, and Done takes the marker out", async () => {
    const body = 'Check <!-- sel:abc "what does this mean?" -->end of Q3<!-- /sel:abc --> here.';
    const { server, tab } = await suggested(body, "abc", "<answer>\nThe last day of **September**.\n</answer>");
    expect(tab.markdown).toBe(body.replaceAll("sel:abc", "sel:abc:sug"));
    expect(dom(tab).querySelector(".sug-preview")).toBeNull(); // no diff
    const chip = dom(tab).querySelector<HTMLElement>('.sug-answer[data-sug="abc"]')!;
    expect(chip.textContent).toBe("Answered");
    chip.click();
    const card = document.querySelector<HTMLElement>(".sug-card")!;
    expect(card.querySelector("header")!.textContent).toBe("Answer");
    // The popover is the same for every comment: only its accent changes, and the side card carries it too.
    expect(card.dataset.kind).toBe("answer");
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.kind).toBe("answer");
    expect(card.querySelector(".sug-answer-text")!.innerHTML).toContain("<strong>September</strong>");
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Done", "Ask again", "Chat"]);
    card.querySelector<HTMLButtonElement>('[data-decision="rejected"]')!.click();
    expect(tab.markdown).toBe("Check end of Q3 here.");
    await tab.save(server);
    expect(server.block.tasks?.abc?.status).toBe("rejected");
  });
});

describe("deciding", () => {
  test("a click on the preview opens the card; Accept puts the result in the page, as the writer's edit", async () => {
    const { server, tab } = await suggested("End of Q3 <!-- gen:abc --> for all.", "abc", reply("(30 Sep)"));
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    const card = document.querySelector<HTMLElement>(".sug-card")!;
    expect(card.textContent).toContain("Suggestion");
    expect(card.dataset.kind).toBe("suggestion");
    expect(document.querySelector<HTMLElement>(".sug-side")!.dataset.kind).toBe("suggestion");
    expect(card.textContent).toContain("Did it.");
    card.querySelector<HTMLButtonElement>('[data-decision="accepted"]')!.click();
    expect(tab.markdown).toBe("End of Q3 (30 Sep) for all.");
    expect(document.querySelector(".sug-card")).toBeNull();
    expect(tab.dirty).toBe(true); // saved like typing
    await tab.save(server);
    expect(server.markdown).toBe("End of Q3 (30 Sep) for all.");
    tab.undo();
    expect(tab.markdown).toBe("End of Q3 <!-- gen:abc:sug --> for all.");
    expect(dom(tab).querySelector('.sug-preview[data-sug="abc"]')).not.toBeNull(); // back, preview and all
  });

  test("Reject from the card keeps the writer's text", async () => {
    const { tab } = await suggested("Check <!-- sel:abc -->end of Q3<!-- /sel:abc --> here.", "abc", reply("(30 Sep)", "after"));
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    document.querySelector<HTMLButtonElement>('.sug-card [data-decision="rejected"]')!.click();
    expect(tab.markdown).toBe("Check end of Q3 here.");
  });

  test("Ask again puts it back to waiting", async () => {
    const { tab } = await suggested("A <!-- gen:abc --> b.", "abc", reply("x"));
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    document.querySelector<HTMLButtonElement>('.sug-card [data-decision="asked_again"]')!.click();
    expect(tab.markdown).toBe("A <!-- gen:abc --> b.");
    expect(suggestionsIn(tab.state)).toEqual([]);
  });

  test("a decline's card: Dismiss takes the marker out", async () => {
    const { tab } = await suggested("A <!-- gen:abc --> b.", "abc", "<decline>No.</decline>");
    dom(tab).querySelector<HTMLElement>(".sug-declined")!.click();
    const card = document.querySelector<HTMLElement>(".sug-card")!;
    expect([...card.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Dismiss", "Ask again", "Chat"]);
    expect(card.dataset.kind).toBe("declined");
    card.querySelector<HTMLButtonElement>('[data-decision="rejected"]')!.click();
    expect(tab.markdown).toBe("A b.");
  });

  test("the keys act on the suggestion at the caret: ⌥⌘Y accepts, ⌥⌘N rejects", async () => {
    const { tab } = await suggested("One <!-- gen:aaa --> two <!-- gen:bbb --> three.", "aaa", reply("A"));
    const at = suggestionsIn(tab.state)[0]!;
    caretAt(tab, at.to);
    press(tab, "y", { meta: true, alt: true });
    expect(tab.markdown).toBe("One A two <!-- gen:bbb --> three.");
    press(tab, "n", { meta: true, alt: true }); // nothing at the caret now: nothing happens
    expect(tab.markdown).toBe("One A two <!-- gen:bbb --> three.");
  });

  test("next and previous go round the suggestions and open each one's card", async () => {
    const server = new Server("One <!-- gen:aaa --> two <!-- gen:bbb --> three.");
    const tab = new Tab(server.src);
    document.body.append(dom(tab));
    await tab.save(server);
    server.agentRun("aaa", reply("A"));
    server.agentRun("bbb", reply("B"));
    tab.receive(server.src);
    caretAt(tab, 1);
    expect(goToSuggestion(tab.editor.view, 1)).toBe(true);
    expect(document.querySelector(".sug-card")).not.toBeNull();
    press(tab, "y", { meta: true, alt: true }); // the open one, at the caret
    expect(tab.markdown).toBe("One A two <!-- gen:bbb:sug --> three.");
    expect(goToSuggestion(tab.editor.view, -1)).toBe(true); // wraps round to the only one left
    press(tab, "n", { meta: true, alt: true });
    expect(tab.markdown).toBe("One A two three.");
    expect(goToSuggestion(tab.editor.view, 1)).toBe(false);
  });

  test("Accept all and Reject all: one edit each, one Undo", async () => {
    const server = new Server("One <!-- gen:aaa --> two.\n\n<!-- sel:bbb -->Three<!-- /sel:bbb -->\n\nFour <!-- gen:ccc --> five.");
    const tab = new Tab(server.src);
    await tab.save(server);
    server.agentRun("aaa", reply("A"));
    server.agentRun("bbb", reply("- x\n- y", "after", "blocks"));
    server.agentRun("ccc", "<decline>No.</decline>");
    tab.receive(server.src);
    const before = tab.markdown;
    expect(decideAll(tab.editor.view, "accepted")).toBe(3);
    expect(tab.markdown).toBe("One A two.\n\nThree\n\n- x\n- y\n\nFour five.");
    tab.undo();
    expect(tab.markdown).toBe(before);
    expect(decideAll(tab.editor.view, "rejected")).toBe(3);
    expect(tab.markdown).toBe("One two.\n\nThree\n\nFour five.");
  });

  test("vim: ga accepts and gr rejects the suggestion under the cursor", async () => {
    const { tab } = await suggested("One <!-- gen:aaa --> two.", "aaa", reply("A"));
    const { setVim } = await import("../src/app/editor/vim");
    setVim(tab.editor, true);
    caretAt(tab, suggestionsIn(tab.state)[0]!.from);
    press(tab, "g");
    press(tab, "a");
    expect(tab.markdown).toBe("One A two.");
  });

  test("the card says when the range's text changed after the suggestion was made", async () => {
    const { tab } = await suggested("Check <!-- sel:abc -->end of Q3<!-- /sel:abc --> here.", "abc", reply("(30 Sep)", "after"));
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    expect(document.querySelector(".sug-stale")).toBeNull();
    document.querySelectorAll(".task-popup").forEach((el) => el.remove());
    tab.replace("Q3", "Q4");
    tab.editor.view.dispatch(tab.state.tr.setMeta((await import("../src/app/editor/suggestions")).suggestionKey, { open: null }));
    dom(tab).querySelector<HTMLElement>('[data-sug="abc"]')!.click();
    expect(document.querySelector(".sug-stale")?.textContent).toContain("changed after the suggestion was made");
  });
});

describe("the record of a decision", () => {
  const record = (server: Server, id: string) => server.block.tasks?.[id];
  const pick = (tab: Tab, id: string, decision: "accepted" | "rejected" | "asked_again") => {
    dom(tab).querySelector<HTMLElement>(`[data-sug="${id}"]`)!.click();
    document.querySelector<HTMLButtonElement>(`.sug-card [data-decision="${decision}"]`)!.click();
  };

  test("accepted and rejected are recorded with the time, by the save that carries them", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.\n\nThree <!-- sel:bbb -->four<!-- /sel:bbb -->.", "aaa", reply("A"));
    server.agentRun("bbb", reply("(4)", "after"));
    tab.receive(server.src);
    pick(tab, "aaa", "accepted");
    pick(tab, "bbb", "rejected");
    expect(record(server, "aaa")?.status).toBe("suggested"); // not saved yet
    await tab.save(server);
    expect(record(server, "aaa")).toMatchObject({ status: "accepted", reviewed: expect.any(String), suggestion: "A" });
    expect(record(server, "bbb")).toMatchObject({ status: "rejected", reviewed: expect.any(String) });
    expect(tab.makePut().decisions).toBeUndefined(); // sent once
  });

  test("asked again: waiting again, counted, the turned-down proposal kept for the next run; that run's result replaces it", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.", "aaa", reply("First."));
    pick(tab, "aaa", "asked_again");
    await tab.save(server);
    expect(record(server, "aaa")).toMatchObject({ status: "pending", asked_again: 1, suggestion: "First." });
    server.agentRun("aaa", reply("Second."));
    expect(record(server, "aaa")).toMatchObject({ status: "suggested", asked_again: 1, suggestion: "Second." });
  });

  test("a suggestion the writer deleted by hand is recorded as edited; a decline dismissed stays declined, with when", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.\n\nThree <!-- gen:bbb --> four.", "aaa", reply("A"));
    server.agentRun("bbb", "<decline>No.</decline>");
    tab.receive(server.src);
    const { from, to } = suggestionsIn(tab.state)[0]!;
    tab.dispatch(tab.state.tr.delete(from, to)); // backspaced over it
    pick(tab, "bbb", "rejected");
    await tab.save(server);
    expect(record(server, "aaa")).toMatchObject({ status: "edited", reviewed: expect.any(String) });
    expect(record(server, "bbb")).toMatchObject({ status: "declined", note: "No.", reviewed: expect.any(String) });
  });

  test("Undo after an accepted suggestion was saved: the next save makes it a suggestion again", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.", "aaa", reply("A"));
    pick(tab, "aaa", "accepted");
    await tab.save(server);
    expect(record(server, "aaa")?.status).toBe("accepted");
    tab.undo();
    await tab.save(server);
    expect(server.markdown).toBe("One <!-- gen:aaa:sug --> two.");
    expect(record(server, "aaa")?.status).toBe("suggested");
    expect(record(server, "aaa")?.reviewed).toBeUndefined();
    expect(dom(tab).querySelector('.sug-preview[data-sug="aaa"]')!.textContent).toBe("A");
  });

  test("a decision undone before the save is not recorded", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.", "aaa", reply("A"));
    pick(tab, "aaa", "accepted");
    tab.undo();
    await tab.save(server);
    expect(record(server, "aaa")?.status).toBe("suggested");
  });

  test("a follow-up in an accepted suggestion is recorded as the agent's, made from it", async () => {
    const { server, tab } = await suggested("One <!-- gen:aaa --> two.", "aaa", reply("A, and more to come <!-- gen:f00 -->"));
    pick(tab, "aaa", "accepted");
    await tab.save(server);
    expect(server.markdown).toBe("One A, and more to come <!-- gen:f00 --> two.");
    expect(record(server, "f00")).toMatchObject({ type: "gen", created_by: "agent", created_from: "aaa", status: "pending" });
  });
});

describe("edits to other blocks", () => {
  const T = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
  const PAGE = `<!-- sel:t7w -->Remove this table<!-- /sel:t7w -->\n\n${T}\n\nAfter.`;
  const edit = (before: string, after = "") => `<edit>\n<before>\n${before}\n</before>\n<after>\n${after}\n</after>\n</edit>`;

  test("the table to remove is struck through, a chip at the request says where; Accept removes it and records it", async () => {
    const { server, tab } = await suggested(PAGE, "t7w", `${edit(T)}\n<note>Removed the old table.</note>`);
    const old = dom(tab).querySelectorAll('.sug-old-block[data-sug="t7w"]');
    expect(old.length).toBe(1);
    expect(old[0]!.textContent).toContain("3 Sep");
    expect(dom(tab).querySelector(".sug-chip")!.textContent).toBe("Changes suggested below");
    expect(dom(tab).querySelector(".sug-preview")).toBeNull();
    expect(suggestionsIn(tab.state)[0]).toMatchObject({ declined: false });
    dom(tab).querySelector<HTMLElement>(".sug-chip")!.click();
    const card = document.querySelector<HTMLElement>(".sug-card")!;
    expect(card.querySelector(".sug-edits")!.textContent).toBe("Removes a table");
    card.querySelector<HTMLButtonElement>('[data-decision="accepted"]')!.click();
    expect(tab.markdown).toBe("Remove this table\n\nAfter.");
    await tab.save(server);
    expect(server.block.tasks?.t7w).toMatchObject({ status: "accepted" });
    tab.undo();
    expect(tab.markdown).toBe(PAGE.replaceAll("t7w", "t7w:sug"));
  });

  test("a replacement shows after the blocks it replaces; a click in those blocks opens the card", async () => {
    const { tab } = await suggested(PAGE, "t7w", `${edit("After.", "After, changed.")}`);
    expect(dom(tab).querySelector(".sug-old-block")!.textContent).toBe("After.");
    expect(dom(tab).querySelector('.sug-preview[data-sug="t7w"]')!.textContent).toBe("After, changed.");
    expect(dom(tab).querySelector(".sug-chip")!.textContent).toBe("Changes suggested below");
    dom(tab).querySelector<HTMLElement>(".sug-old-block")!.click();
    expect(document.querySelector(".sug-card .sug-edits")!.textContent).toBe("Changes a paragraph");
  });

  test("a click on a question's highlight in those blocks is the question's: the suggestion's card stays shut", async () => {
    const { tab } = await suggested(PAGE, "t7w", `${edit("After.", "After, changed.")}`);
    const highlight = document.createElement("span");
    highlight.setAttribute("data-comment", "q1");
    dom(tab).querySelector(".sug-old-block")!.append(highlight);
    highlight.click();
    expect(document.querySelector(".sug-card")).toBeNull();
  });

  test("blocks the writer changed since: not marked, and the card says Accept leaves them", async () => {
    const { tab } = await suggested(PAGE, "t7w", edit(T));
    tab.replace("3 Sep", "4 Sep");
    expect(dom(tab).querySelector(".sug-old-block")).toBeNull();
    dom(tab).querySelector<HTMLElement>(".sug-chip")!.click();
    expect(document.querySelector(".sug-edits li.gone")!.textContent).toContain("changed since");
    document.querySelector<HTMLButtonElement>('.sug-card [data-decision="accepted"]')!.click();
    expect(tab.markdown).toBe("Remove this table\n\n| Team | Date |\n| --- | --- |\n| Web | 4 Sep |\n\nAfter.");
  });

  test("Undo after a saved Accept of edits only: a suggestion again, not a decline", async () => {
    const { server, tab } = await suggested(PAGE, "t7w", edit(T));
    dom(tab).querySelector<HTMLElement>(".sug-chip")!.click();
    document.querySelector<HTMLButtonElement>('.sug-card [data-decision="accepted"]')!.click();
    await tab.save(server);
    tab.undo();
    await tab.save(server);
    expect(server.block.tasks?.t7w?.status).toBe("suggested");
  });
});

describe("the caret after a decision", () => {
  const para = (n: number) => `Paragraph ${n} with some words in it.`;
  const long = `${Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n")}\n\nSay <!-- sel:abc "shorter" -->a long phrase here<!-- /sel:abc --> now.\n\n${Array.from({ length: 12 }, (_, i) => para(i + 20)).join("\n\n")}\n`;

  for (const decision of ["accepted", "rejected"] as const) {
    test(`${decision}: the caret goes to the suggestion, so the page isn't scrolled back to where the caret was`, async () => {
      const { tab } = await suggested(long, "abc", reply("short", "replace"));
      const view = tab.editor.view;
      expect(view.state.selection.head).toBeLessThan(5); // the page opened with the caret at the start
      let scrolled = false;
      const dispatch = view.dispatch.bind(view);
      view.dispatch = (tr) => { scrolled ||= tr.scrolledIntoView; dispatch(tr); };
      decideSuggestion(view, "abc", decision);
      const head = view.state.selection.head;
      expect(view.state.doc.textBetween(Math.max(0, head - 12), head)).toMatch(decision === "accepted" ? /short$|Say $/ : /Say $|phrase here$/);
      expect(head).toBeGreaterThan(view.state.doc.content.size / 3);
      expect(scrolled).toBe(true); // to the caret, which is by the suggestion now
    });
  }

  test("the caret goes to the first suggestion when all are decided", async () => {
    const { tab } = await suggested(long, "abc", reply("short", "replace"));
    const view = tab.editor.view;
    decideAll(view, "accepted");
    expect(view.state.selection.head).toBeGreaterThan(view.state.doc.content.size / 3);
  });

  test("giving the editor focus back after a modal doesn't scroll to the caret", async () => {
    const { focusQuietly } = await import("../src/app/editor/focus");
    const { tab } = await suggested(long, "abc", reply("short", "replace"));
    const view = tab.editor.view;
    let scrolled = false;
    const dispatch = view.dispatch.bind(view);
    view.dispatch = (tr) => { scrolled ||= tr.scrolledIntoView; dispatch(tr); };
    view.dom.blur();
    focusQuietly(tab.editor);
    await new Promise((r) => setTimeout(r, 30));
    expect(scrolled).toBe(false);
    expect(view.state.selection.head).toBeLessThan(5); // and the caret was not moved
  });
});

describe("a change proposed in the generic chat", () => {
  test("shows as a suggestion; Accept makes its edits and adds its blocks at the end, Reject leaves the page as it was", async () => {
    const { suggestOnPage } = await import("../src/server/suggest");
    const page = "# Plan\n\nIntro text.\n\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n\nEnd.\n";
    const reply = '<edit><before>\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n</before><after></after></edit>\n<suggestion mode="at" place="blocks">\nAdded paragraph.\n</suggestion>\n<note>Dropped the table.</note>';
    const made = suggestOnPage(page, reply);
    expect(made.error).toBeUndefined();
    for (const decision of ["accepted", "rejected"] as const) {
      const tab = new Tab(made.file!);
      document.body.append(tab.editor.view.dom);
      expect(dom(tab).querySelector(".sug-old-block")).not.toBeNull(); // the table, marked for removal
      expect(suggestionsIn(tab.state)).toHaveLength(1);
      decideSuggestion(tab.editor.view, made.id!, decision);
      expect(tab.markdown).toBe(decision === "accepted" ? "# Plan\n\nIntro text.\n\nEnd.\n\nAdded paragraph." : page.trimEnd());
    }
  });
});
