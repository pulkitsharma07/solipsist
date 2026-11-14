// What Chat on a review question puts in the page chat's message box (`chatDraft`).
import { expect, test } from "bun:test";
import { chatDraft } from "../src/app/pages/CommentModal";

const anchor = (exact: string) => ({ exact }) as any;

test("the passage is quoted line by line, then the question, then room for the writer", () => {
  expect(chatDraft({ title: "Which study?", anchor: anchor("First line.\nSecond line.") }))
    .toBe("About this passage:\n> First line.\n> Second line.\n\nThe reviewer asked: Which study?\n\n");
});

test("the question's body follows its title; blank space around either is dropped", () => {
  expect(chatDraft({ title: " Which study? ", body: " It cites none. \n", anchor: anchor("  A claim.  ") }))
    .toBe("About this passage:\n> A claim.\n\nThe reviewer asked: Which study?\nIt cites none.\n\n");
});
