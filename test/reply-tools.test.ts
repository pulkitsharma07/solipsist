// The reply tools (`src/server/agent/replyTools.ts`): what each call means as a `Reply`, and what it can't say.
import { describe, expect, test } from "bun:test";
import { callReplyTool, REPLY_TOOLS } from "../src/server/agent/replyTools";

const call = (name: string, params: unknown, check?: Parameters<typeof callReplyTool>[2]) => callReplyTool(REPLY_TOOLS.find((t) => t.name === name)!, params, check);

describe("suggest", () => {
  test("a result with where it goes, edits, or both, with a note", () => {
    expect(call("suggest", { mode: "at", place: "inline", markdown: "x", note: " Did it. " })).toEqual({ reply: { kind: "suggestion", mode: "at", place: "inline", suggestion: "x", note: "Did it." } });
    expect(call("suggest", { edits: [{ before: "A.", after: "" }] })).toEqual({ reply: { kind: "suggestion", edits: [{ before: "A.", after: "" }] } });
    expect(call("suggest", { mode: "replace", place: "inline", markdown: "", edits: [{ before: "A.", after: "B." }] }))
      .toEqual({ reply: { kind: "suggestion", mode: "replace", place: "inline", suggestion: "", edits: [{ before: "A.", after: "B." }] } });
  });
  test("nothing to suggest, or markdown with nowhere to go, is an error", () => {
    expect(call("suggest", {})).toMatchObject({ error: expect.stringContaining("`edits`") });
    expect(call("suggest", { edits: [] })).toMatchObject({ error: expect.any(String) });
    expect(call("suggest", { markdown: "x" })).toMatchObject({ error: expect.stringContaining("`mode`") });
  });
});

test("answer and decline need words", () => {
  expect(call("answer", { answer: " Yes. " })).toEqual({ reply: { kind: "answer", answer: "Yes." } });
  expect(call("answer", { answer: " " })).toMatchObject({ error: expect.any(String) });
  expect(call("decline", { reason: "No room." })).toEqual({ reply: { kind: "decline", note: "No room." } });
  expect(call("decline", { reason: "" })).toMatchObject({ error: expect.any(String) });
});

test("the run's check decides last: its reason is the error", () => {
  expect(call("decline", { reason: "No." }, () => "not now")).toEqual({ error: "not now" });
  expect(call("decline", { reason: "No." }, () => null)).toEqual({ reply: { kind: "decline", note: "No." } });
});
