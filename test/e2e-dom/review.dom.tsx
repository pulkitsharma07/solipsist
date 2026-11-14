// The Reader through the real app: the writer clicks Page review in the status bar, the real client calls the real
// server over HTTP, and the questions arrive in the margin. The browser half of `test/reader*.test.ts`.
//
// It exists because of a bug the server-side tests could not see: the client built the URL by hand, so a page whose
// id holds the folder it is in (`docs2/w8s1jmmy`) made a path the route cannot match and the button answered 501.
// Every case here uses an id with a slash in it for that reason.
import "./platform"; // first: see platform.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startApp, type App, type PageView } from "./app";

let app: App;
beforeAll(async () => { app = await startApp(); });
afterAll(() => app.close());

const PAGE = `# Why we are moving to Pi

Research shows the Pi harness has the same or better planning capabilities, so the switch costs us nothing.

We moved for stability.
`;

const QUOTE = "Research shows the Pi harness has the same or better planning capabilities, so the switch costs us nothing.";
const comments = (...cs: { quote: string; title: string; gloss: string; score?: number; image?: string }[]) =>
  ({ kind: "comments" as const, comments: cs.map((c) => ({ description: "Why I asked.", ...c })) });

/** The status bar's Read my page button. */
const reviewButton = (p: { $(s: string): HTMLElement | null }) => p.$(".statusbar .review-page") as HTMLButtonElement | null;

/** A page in a folder of the docs tree, as the page list's own ids are: the folder is made first. */
const write = (id: string, markdown: string) => {
  mkdirSync(dirname(join(app.docs, `${id}.md`)), { recursive: true });
  app.write(id, markdown);
};

test("Page review puts the agent's questions in the margin, and writes nothing in the page", async () => {
  // An id with a folder in it, as the app's own page list gives: this is what broke.
  const id = "docs/pi-post";
  write(id, PAGE);
  const p = await app.open(id);
  const before = p.markdown;

  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 9 });

  const button = reviewButton(p);
  expect(button).not.toBeNull();
  expect(button!.textContent).toContain("Page review");
  p.click(button!);

  await app.until("the question is in the margin", () => p.$$(".margin .card").length > 0, 3000, () => `status: ${p.status}`);

  // The gloss is the closed card, as a reader's pencil note.
  expect(p.$$(".margin .card").map((c) => c.textContent).join(" ")).toContain("which research?");
  // The passage is highlighted, anchored to the words the agent quoted.
  expect(p.$$("[data-comment]").length).toBeGreaterThan(0);
  // The writer's text is untouched: the Reader has no way to write the page.
  expect(p.markdown).toBe(before);
  expect(app.body(id)).toContain("Research shows the Pi harness");
});

test("the request really reaches the server: no 501 from an id with a slash", async () => {
  const id = "docs2/w8s1jmmy";
  write(id, PAGE);
  const p = await app.open(id);

  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 8 });
  p.click(reviewButton(p)!);

  // A reading that never reached the handler would leave the button saying nothing happened and the margin empty.
  await app.until("a run was made for the review", () => app.model.runs.length > 0, 3000, () => `status: ${p.status}`);
  await app.until("the question is in the margin", () => p.$$(".margin .card").length > 0, 3000);
  expect(p.$$(".margin .card").length).toBe(1);
});

test("the card opens with the whole question, and Dismiss takes it down for good", async () => {
  const id = "docs/dismissing";
  write(id, PAGE);
  const p = await app.open(id);

  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 7 });
  p.click(reviewButton(p)!);
  await app.until("the question is in the margin", () => p.$$(".margin .card").length > 0, 3000);

  // The card is the gloss alone; the question opens in a window of its own.
  expect(p.$$(".margin .card")[0]!.textContent).not.toContain("What research");
  p.click(p.$$(".margin .card")[0]!);
  await app.until("the question's window opened", () => p.$$(".comment-modal").length === 1, 2000,
    () => `cards=${p.$$(".margin .card").length} modals=${p.$$(".comment-modal").length}`);
  const modal = p.$$(".comment-modal")[0]!;
  expect(modal.textContent).toContain("What research, and what did it measure?");
  expect(modal.textContent).toContain("Why I asked.");
  // The same popover as every other comment, in the question's accent; the passage lights up and the rest of the page steps back.
  expect(modal.getAttribute("data-kind")).toBe("review");
  expect(p.$$(".comment-modal .pop-eyebrow")[0]!.textContent).toBe("Question");
  expect(p.$$(".sheet [data-comment].active").length).toBeGreaterThan(0);
  expect(p.$$(".sheet .tiptap.spot, .sheet .ProseMirror.spot").length).toBe(1);
  // The passage it is about, so the writer need not hunt for the highlight.
  expect(p.$$(".comment-modal .comment-passage")[0]!.textContent).toContain("Research shows the Pi harness");
  // Who asked: the reviewer, and the model it ran on.
  expect(p.$$(".comment-modal .comment-by")[0]!.textContent).toContain("reviewer");
  expect(p.$$(".comment-modal .comment-by")[0]!.textContent).toContain("m");
  // No Accept or Reject: nothing was put in the page, so there is nothing to accept.
  const labels = p.$$(".comment-modal footer button").map((b) => b.textContent);
  expect(labels).toContain("Dismiss");
  expect(labels).not.toContain("Accept");

  p.click(p.$$(".comment-modal footer button").find((b) => b.textContent === "Dismiss")!);
  await app.until("the comment is gone from the margin", () => p.$$(".margin .card").length === 0, 3000);
  expect(p.$$(".spot").length).toBe(0); // the page is back to normal once the window has closed
  await app.until("and dismissed in the file", () => /"status": "dismissed"/.test(app.file(id)), 3000, () => app.file(id));
});

test("Chat carries the question into the page chat, with the passage and the question in the message box", async () => {
  const id = "docs/chatting";
  write(id, PAGE);
  const p = await app.open(id);
  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 7 });
  p.click(reviewButton(p)!);
  await app.until("the question is in the margin", () => p.$$(".margin .card").length > 0, 3000);
  p.click(p.$$(".margin .card")[0]!);
  await app.until("the question's window opened", () => p.$$(".comment-modal").length === 1, 2000);

  const chat = p.$$(".comment-modal footer button").find((b) => b.textContent === "Chat");
  expect(chat).toBeDefined();
  p.click(chat!);
  const box = () => document.querySelector(".chat-modal textarea") as HTMLTextAreaElement | null;
  await app.until("the page chat is open and ready", () => !!box() && !box()!.disabled, 3000);
  expect(p.$$(".comment-modal").length).toBe(0);
  expect(document.querySelector(".chat-modal")!.textContent).toContain("Chat with");
  // Nothing is sent: the writer finishes the message, carrying on after what was put there.
  expect(box()!.value).toBe(`About this passage:\n> ${QUOTE}\n\nThe reviewer asked: What research, and what did it measure?\n\n`);
  expect(box()!.selectionStart).toBe(box()!.value.length);
  expect(document.querySelectorAll(".chat-modal .chat-msg").length).toBe(0);
  // The question stays in the margin: talking it over isn't dismissing it.
  expect(p.$$(".margin .card").length).toBe(1);
});

test("a review that raises nothing says so where the writer asked", async () => {
  const id = "docs/nothing-to-ask";
  write(id, PAGE);
  const p = await app.open(id);

  app.model.script = () => comments();
  p.click(reviewButton(p)!);

  await app.until("the button says what happened", () => /Nothing to ask about/.test(reviewButton(p)?.getAttribute("title") ?? ""), 3000, () => `title: ${reviewButton(p)?.getAttribute("title")}`);
  expect(p.$$(".margin .card").length).toBe(0);
});


/** Clicks Review and waits until its run has really started and ended, then a moment for the placing: a test that a question is refused counts cards only after this, or it would count them before the run began. */
async function reviewAndSettle(p: PageView) {
  const before = app.model.runs.length;
  p.click(reviewButton(p)!);
  await app.until("the review run to start", () => app.model.runs.length > before, 4000, () => p.status);
  await app.until("the review run to end", () => app.model.runs.slice(before).every((r) => r.ended), 6000, () => p.status);
  await Bun.sleep(400);
}

test("a picture the reviewer drew is shown in the open card, and the status bar counts the questions", async () => {
  const id = "docs/with-a-picture";
  write(id, PAGE);
  const p = await app.open(id);

  // The reviewer draws into the page's own image folder, the only place it may write, and names the file as the page
  // would. The server checks the file is really there before the question is kept.
  // The page's own image folder: `<project>/.solipsist/images/<id>`, the only place a reviewer may write.
  const images = join(app.docs, "..", "images", id);
  mkdirSync(images, { recursive: true });
  const drawn = "timeline.svg";
  writeFileSync(join(images, drawn), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');

  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 9, image: `images/with-a-picture/${drawn}` });
  p.click(reviewButton(p)!);
  await app.until("the question is in the margin", () => p.$$(".margin .card").length > 0, 3000, () => p.status);

  // The status bar says how many questions are on the page — the only sign of them when the margin has no room.
  await app.until("the status bar counts it", () => /1 question(?!s)/.test(p.status), 3000, () => p.status);

  // The margin says a picture is there without showing it; the window shows it.
  expect(p.$$(".margin .card img").length).toBe(0);
  expect(p.$$(".margin .card .card-has-image").length).toBe(1);
  p.click(p.$$(".margin .card")[0]!);
  await app.until("the picture is in the window", () => p.$$(".comment-modal img.comment-image").length === 1, 3000);
  const img = p.$$(".comment-modal img.comment-image")[0] as HTMLImageElement;
  // The link is relative to the page's folder (`docs/`), so its folder is the page's file name, not its whole id; and it leads to the file.
  expect(img.getAttribute("src")).toBe(`/api/assets/docs/images/with-a-picture/${drawn}`);
  expect((await fetch(img.getAttribute("src")!)).status).toBe(200);
  // The page itself has no image in it: the picture belongs to the question, not to the writer's text.
  expect(p.markdown).not.toContain(drawn);
});

test("a picture linked by the page's whole id (the folder it is stored in, not the link) is refused, though the file is there", async () => {
  const id = "docs/whole-id";
  write(id, PAGE);
  const p = await app.open(id);
  const images = join(app.docs, "..", "images", id);
  mkdirSync(images, { recursive: true });
  writeFileSync(join(images, "t.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
  app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 9, image: `images/${id}/t.svg` });
  await reviewAndSettle(p);
  expect(p.$$(".margin .card").length).toBe(0);
});

test("a picture outside the page's image folder, or with no file behind it, is refused", async () => {
  for (const [what, image] of [["outside the folder", "../../../secrets/key.svg"], ["no file behind it", "images/docs/ghosts/nothing.svg"]] as const) {
    const id = `docs/refused-${what.length}`;
    write(id, PAGE);
    const p = await app.open(id);
    app.model.script = () => comments({ quote: QUOTE, title: "What research, and what did it measure?", gloss: "which research?", score: 9, image });
    // Turned away while the run is still going, so nothing is placed: the writer gets no question rather than a
    // card with a broken picture in it.
    await reviewAndSettle(p);
    expect(p.$$(".margin .card").length).toBe(0);
    expect(p.markdown).toBe(PAGE.trimEnd());
  }
});
