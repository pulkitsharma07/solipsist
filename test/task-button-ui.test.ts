// Accept as a Button in the page: the card's dropdown, the popup that says what a button
// does, the button above the text, a press, and its result going straight into the page.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { parseFile } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.querySelectorAll(".task-popup").forEach((el) => el.remove());
  document.body.innerHTML = "";
});

const reply = (text: string, mode = "after") => `<suggestion mode="${mode}" place="inline">\n${text}\n</suggestion>\n<note>Did it.</note>`;
const click = (el: Element | null) => {
  expect(el).not.toBeNull();
  el!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  (el as HTMLElement).click();
};
const enter = (field: HTMLTextAreaElement) => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

async function suggested(body: string, answer: string) {
  const server = new Server(body);
  const tab = new Tab(server.src);
  document.body.append(tab.editor.view.dom);
  await tab.save(server);
  server.agentRun("abc", answer);
  tab.receive(server.src);
  return { server, tab, dom: tab.editor.view.dom };
}
/** The card for suggestion abc, pinned by a click on its diff. */
const openCard = (dom: HTMLElement) => {
  click(dom.querySelector('[data-sug="abc"]:not(.sug-old)'));
  return document.querySelector<HTMLElement>(".sug-side .sug-card")!;
};
/** Accept ▾, then Accept as a Button in its dropdown. */
const pickAcceptAsButton = (dom: HTMLElement) => {
  click(openCard(dom).querySelector(".sug-accept-more"));
  click(document.querySelector('.task-popup [data-action="accept-as-button"]'));
};
const PAGE = 'The time is <!-- sel:abc "add the current time in words" -->now<!-- /sel:abc -->.';

describe("Accept as a Button", () => {
  test("the dropdown floats under Accept ▾; the popup says what it does, and Cancel leaves the suggestion waiting", async () => {
    const { tab, dom } = await suggested(PAGE, reply("half past three"));
    const card = openCard(dom);
    const more = card.querySelector<HTMLElement>(".sug-accept-more")!;
    expect(more.getAttribute("aria-label")).toBe("More ways to accept");
    expect(document.querySelector(".sug-more")).toBeNull();
    click(more);
    const menu = document.querySelector<HTMLElement>(".task-popup .sug-more")!;
    // Not inside the card (it scrolls, and would cut the menu off), but beside it, and part of the suggestion.
    expect(card.contains(menu)).toBe(false);
    expect(menu.dataset.sug).toBe("abc");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // ▾ again closes it.
    click(more);
    expect(document.querySelector(".sug-more")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    click(more);
    click(document.querySelector('.task-popup [data-action="accept-as-button"]'));
    expect(document.querySelector(".sug-more")).toBeNull();
    const popup = document.querySelector<HTMLElement>(".task-popup .sug-button-confirm")!;
    expect(popup.textContent).toContain("You won't see a diff");
    click([...popup.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
    expect(document.querySelector(".sug-button-confirm")).toBeNull();
    expect(tab.markdown).toContain(":sug");
  });

  test("Escape closes the dropdown before the card", async () => {
    const { dom } = await suggested(PAGE, reply("half past three"));
    click(openCard(dom).querySelector(".sug-accept-more"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".sug-more")).toBeNull();
    expect(document.querySelector(".sug-side .sug-card")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".sug-side .sug-card")).toBeNull();
  });

  test("a result that can't be a button is never a dead end: Ask again as a button, saying why in plain words", async () => {
    const { server, tab, dom } = await suggested(PAGE, '<suggestion mode="after" place="blocks">\n```\ncode\n```\n</suggestion>');
    click(openCard(dom).querySelector(".sug-accept-more"));
    expect(document.querySelector('.task-popup [data-action="accept-as-button"]')).toBeNull();
    const item = document.querySelector<HTMLButtonElement>('.task-popup [data-action="ask-for-button"]')!;
    expect(item.disabled).toBe(false);
    expect(item.querySelector(".sug-menu-label")!.textContent).toBe("Ask again as a button");
    expect(item.querySelector(".sug-menu-note")!.textContent).toBe("It starts or ends with a code block, which a button can't hold. The agent will be asked for a version in one piece here, leaving the rest of the page as it is.");
    // It asks again as Ask again does (the instruction first), and the server records that a button is wanted.
    click(item);
    const field = document.querySelector<HTMLTextAreaElement>(".task-popup textarea")!;
    expect(field.value).toBe("add the current time in words");
    enter(field);
    expect(tab.markdown).toBe(PAGE); // waiting again, as after Ask again
    expect(tab.makePut().decisions).toEqual({ abc: "asked_for_button" });
    await tab.save(server);
    expect(parseFile(server.src).block.tasks!.abc).toMatchObject({ status: "pending", wants_button: true, asked_again: 1 });

    // The run is held to it: a result that can't be a button goes back to the agent; one that can is the suggestion.
    expect(() => server.agentRun("abc", '<suggestion mode="after" place="blocks">\n```\ncode\n```\n</suggestion>')).not.toThrow();
    expect(parseFile(server.src).block.tasks!.abc!.note).toContain("asked for a result they can keep as a button");
    server.handEdit((md) => md.replace(":ack", "")); // the failed run's task waits again, as the loop would leave it
    expect(server.agentRun("abc", reply("half past three"))).toEqual({ done: "suggested" });
    tab.receive(server.src);

    // Its card leads with Accept as a Button; plain Accept is in ▾.
    const card = openCard(dom);
    const lead = card.querySelector<HTMLElement>('.sug-accept [data-action="accept-as-button"]')!;
    expect(lead.textContent).toBe("Accept as a Button");
    expect(card.querySelector('.sug-accept [data-decision="accepted"]')).toBeNull();
    click(card.querySelector(".sug-accept-more"));
    click(document.querySelector('.task-popup [data-action="accept-plain"]'));
    expect(tab.markdown).toBe("The time is now half past three.");
  });

  test("asked for as a button: the main button goes through the same popup", async () => {
    const { server, tab, dom } = await suggested(PAGE, '<suggestion mode="after" place="blocks">\n```\ncode\n```\n</suggestion>');
    click(openCard(dom).querySelector(".sug-accept-more"));
    click(document.querySelector('.task-popup [data-action="ask-for-button"]'));
    enter(document.querySelector<HTMLTextAreaElement>(".task-popup textarea")!);
    await tab.save(server);
    server.agentRun("abc", reply("half past three"));
    tab.receive(server.src);
    click(openCard(dom).querySelector('.sug-accept [data-action="accept-as-button"]'));
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    expect(tab.markdown).toContain(":btn");
  });

  test("confirmed: the result in the page at :btn, a button above it, the decision saved; a press runs it again and its result goes straight in", async () => {
    const { server, tab, dom } = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    expect(tab.markdown).toBe('The time is now <!-- sel:abc:btn "add the current time in words" -->half past three<!-- /sel:abc:btn -->.');
    expect(tab.makePut().decisions).toEqual({ abc: "button" });
    await tab.save(server);
    expect(parseFile(server.src).block.tasks!.abc!.status).toBe("button");

    const button = dom.querySelector<HTMLElement>('.task-button[data-task-button="abc"]')!;
    expect(button.querySelector(".task-press")!.textContent).toBe("↻ add the current time in words");
    // Above the text: before its paragraph, not inside it.
    expect(button.parentElement).toBe(dom);
    // Hovering it marks the text it owns.
    button.dispatchEvent(new MouseEvent("mouseenter"));
    expect(dom.querySelector(".task-button-hover")?.textContent).toBe("half past three");
    button.dispatchEvent(new MouseEvent("mouseleave"));
    expect(dom.querySelector(".task-button-hover")).toBeNull();

    // A press runs it again at once, with the instruction it has: no input to fill in again.
    click(button.querySelector(".task-press"));
    expect(document.querySelector(".task-popup textarea")).toBeNull();
    expect(tab.markdown).toBe('The time is now <!-- sel:abc "add the current time in words" -->half past three<!-- /sel:abc -->.');
    expect(dom.querySelector(".task-button")).toBeNull();
    await tab.save(server);

    expect(server.agentRun("abc", reply("twenty to four", "replace"))).toMatchObject({ done: "applied" });
    tab.receive(server.src);
    expect(tab.markdown).toBe('The time is now <!-- sel:abc:btn "add the current time in words" -->twenty to four<!-- /sel:abc:btn -->.');
    expect(dom.querySelector('.task-button[data-task-button="abc"]')).not.toBeNull();
    expect(document.querySelector(".sug-side .sug-card")).toBeNull();
    // Nothing to review: no fade, no new-block line on the text the button rewrote (the margin says when it ran).
    const { freshTexts } = await import("../src/app/editor/freshText");
    const { newBlockKey } = await import("../src/app/editor/newBlocks");
    expect(freshTexts(tab.state)).toEqual([]);
    expect(newBlockKey.getState(tab.state)!.find()).toEqual([]);
    // Text from outside elsewhere is still flagged as ever.
    server.handEdit((md) => `${md}\n\nA new line from outside.`);
    tab.receive(server.src);
    expect(freshTexts(tab.state)).toEqual(["A new line from outside."]);
  });

  test("✎ changes the button's instruction without running it", async () => {
    const { tab, dom } = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    click(dom.querySelector(".task-edit"));
    const field = document.querySelector<HTMLTextAreaElement>(".task-popup textarea")!;
    expect(field.value).toBe("add the current time in words");
    field.value = "add the time in French";
    enter(field);
    expect(tab.markdown).toBe('The time is now <!-- sel:abc:btn "add the time in French" -->half past three<!-- /sel:abc:btn -->.');
    expect(dom.querySelector(".task-press")!.textContent).toBe("↻ add the time in French");
  });

  test("⏱ offers the schedules, the current one ticked, and tells the page which was picked", async () => {
    const { server, tab, dom } = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    await tab.save(server);
    click(dom.querySelector(".task-schedule"));
    const menu = document.querySelector<HTMLElement>(".task-popup .task-schedule-menu")!;
    expect(menu.textContent).toContain("even with this page closed");
    expect([...menu.querySelectorAll(".sug-menu-label")].map((e) => e.textContent)).toEqual(["✓ Only when pressed", "Every minute", "Every 5 minutes", "Every 15 minutes", "Every hour", "Every day"]);
    click(menu.querySelector('[data-every="300000"]'));
    expect(tab.schedules).toEqual([{ task: "abc", every: 300000 }]);
    expect(document.querySelector(".task-schedule-menu")).toBeNull();
    // The server keeps it on the record; the button then says so without hovering, and the menu ticks it.
    const { scheduleButton } = await import("../src/server/suggest");
    server.src = scheduleButton(server.src, "abc", 300000)!.file!;
    tab.receive(server.src);
    expect(dom.querySelector(".task-every")!.textContent).toBe("⏱ every 5 minutes");
    expect(dom.querySelector<HTMLElement>(".task-every")!.title).toContain("even with this page closed");
    click(dom.querySelector(".task-schedule"));
    expect(document.querySelector('.task-schedule-menu [aria-checked="true"]')!.textContent).toBe("✓ Every 5 minutes");
  });

  test("× takes the button off and leaves the text; Undo brings it back", async () => {
    const { tab, dom } = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    click(dom.querySelector(".task-remove"));
    expect(tab.markdown).toBe("The time is now half past three.");
    expect(dom.querySelector(".task-button")).toBeNull();
    tab.undo();
    expect(tab.markdown).toContain(":btn");
  });

  test("a task with a button: no dropdown on its next card, and Accept says the button stays", async () => {
    const { server, tab, dom } = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    await tab.save(server);
    click(dom.querySelector(".task-press"));
    await tab.save(server);
    // The text changes during the run: its result waits as a diff instead of going in.
    expect(server.agentRun("abc", reply("twenty to four", "replace"), () => server.handEdit((md) => md.replace("half past three", "half past three (ish)")))).toEqual({ done: "suggested" });
    tab.receive(server.src);
    expect(tab.markdown).toContain("half past three (ish)<!-- /sel:abc:sug -->");
    const card = openCard(dom);
    expect(card.querySelector(".sug-accept-more")).toBeNull();
    expect(card.querySelector<HTMLElement>('[data-decision="accepted"]')!.title).toContain("the button stays");
  });

  test("another task's result arriving before the save doesn't undo the decision", async () => {
    const page = `${PAGE}\n\nOther <!-- gen:ddd --> here.`;
    const { server, tab, dom } = await suggested(page, reply("half past three"));
    pickAcceptAsButton(dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    // Not saved yet: the file still has abc waiting at :sug when ddd's run writes it.
    server.agentRun("ddd", '<suggestion mode="at" place="inline">\nfilled\n</suggestion>');
    tab.receive(server.src);
    expect(tab.markdown).toContain('<!-- sel:abc:btn "add the current time in words" -->half past three<!-- /sel:abc:btn -->');
    expect(tab.markdown).toContain("<!-- gen:ddd:sug -->");
    await tab.save(server);
    expect(parseFile(server.src).markdown).toContain("<!-- sel:abc:btn");
    expect(parseFile(server.src).block.tasks!.abc!.status).toBe("button");
  });

  test("after a plain Accept, a spot marks where the result landed, for the agent's note; it follows edits and goes on Undo", async () => {
    const { tab, dom } = await suggested(PAGE, reply("half past three"));
    click(openCard(dom).querySelector('[data-decision="accepted"]'));
    expect(tab.markdown).toBe("The time is now half past three.");
    const spot = () => dom.querySelector<HTMLElement>('[data-accepted="abc"]');
    expect(spot()).not.toBeNull();
    tab.typeBefore("The time", "Note. ");
    expect(spot()).not.toBeNull();
    tab.undo();
    tab.undo();
    expect(tab.markdown).toContain(":sug");
    expect(spot()).toBeNull();
  });

  test("Reject leaves no spot; a result kept as a button has its button instead", async () => {
    const { dom } = await suggested(PAGE, reply("half past three"));
    click(openCard(dom).querySelector('[data-decision="rejected"]'));
    expect(dom.querySelector("[data-accepted]")).toBeNull();
    document.body.innerHTML = "";
    const b = await suggested(PAGE, reply("half past three"));
    pickAcceptAsButton(b.dom);
    click(document.querySelector('.sug-button-confirm [data-decision="button"]'));
    expect(b.dom.querySelector("[data-accepted]")).toBeNull();
    expect(b.dom.querySelector("[data-task-button]")).not.toBeNull();
  });

  test("a type that isn't reusable has no dropdown", async () => {
    const { dom } = await suggested("A <!-- gen:abc --> b.", '<suggestion mode="at" place="inline">\nx\n</suggestion>');
    expect(openCard(dom).querySelector(".sug-accept-more")).toBeNull();
  });
});
