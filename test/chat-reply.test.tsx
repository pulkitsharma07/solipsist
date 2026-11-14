// Solipsist's own tools in the chat (`suggest`, `answer`, `decline`): read from a call's arguments (`readReplyCall`)
// and shown apart from the agent's own tool calls, as the result the writer decides on (`ReplyCard`).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isReplyTool, readReplyCall, REPLY_TOOL_NAMES, type ChatMessage, type ChatTool } from "../src/shared/chat";
import { REPLY_TOOLS } from "../src/server/agent/replyTools";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const call = (name: string, args: object, rest: Partial<ChatTool> = {}): ChatTool =>
  ({ type: "tool", id: `t-${name}`, name, brief: "", args: JSON.stringify(args, null, 2), reply: true, ...rest });

async function render(blocks: ChatMessage["blocks"]) {
  const { ChatLog } = await import("../src/app/pages/ChatModal");
  const m: ChatMessage = { id: "m1", role: "assistant", at: Date.now(), blocks };
  return renderToStaticMarkup(<ChatLog messages={[m]} />);
}

test("the page and the server call the same tools ours", () => {
  expect([...REPLY_TOOL_NAMES].sort()).toEqual(REPLY_TOOLS.map((t) => t.name).sort() as typeof REPLY_TOOL_NAMES[number][]);
});

test("ours by the engine's word, or by its name for a stream that doesn't say; anything else is the agent's own", () => {
  expect(isReplyTool({ name: "suggest", reply: true })).toBe(true);
  expect(isReplyTool({ name: "suggest" })).toBe(true); // an older stream: by the name
  expect(isReplyTool({ name: "bash" })).toBe(false);
  // A tool of the agent's that happens to be called `answer` is still the agent's, when its engine says so.
  expect(isReplyTool({ name: "answer", reply: false })).toBe(false);
});

test("a call is read into what the writer sees: the markdown and where it goes, the edits, the note", () => {
  const got = readReplyCall(call("suggest", { mode: "at", place: "inline", markdown: " quietly ", note: " Used the page's own word. ", edits: [{ before: "A.", after: "B." }] }));
  expect(got).toEqual({ tool: "suggest", label: "Suggestion", markdown: "quietly", where: "at · inline", edits: [{ before: "A.", after: "B." }], note: "Used the page's own word." });
  expect(readReplyCall(call("answer", { answer: "No: 100°C." }))).toEqual({ tool: "answer", label: "Answer", answer: "No: 100°C." });
  expect(readReplyCall(call("decline", { reason: "Nothing fits here." }))).toEqual({ tool: "decline", label: "Declined", reason: "Nothing fits here." });
  // Not ours, or arguments that can't be read yet (a call still streaming in): nothing to show as a result.
  expect(readReplyCall(call("bash", { command: "ls" }, { reply: false }))).toBeNull();
  expect(readReplyCall({ ...call("suggest", {}), args: '{"markdown": "half' })).toBeNull();
});

test("a suggestion shows as the result, outside the work fold, with its note and its edits", async () => {
  const html = await render([
    { type: "thinking", text: "The page names a date." },
    call("bash", { command: "grep -n date /docs/plan.md" }, { reply: false, result: "3:…", durationMs: 12 }),
    call("suggest", { mode: "at", place: "inline", markdown: "30 September", note: "The plan's own date.", edits: [{ before: "End of Q3.", after: "30 September." }] }),
  ]);
  expect(html).toContain("chat-reply suggest done");
  expect(html).toContain("Solipsist");
  expect(html).toContain("Suggestion");
  expect(html).toContain("at · inline");
  expect(html).toContain("30 September");
  expect(html).toContain("The plan&#x27;s own date.");
  expect(html).toContain("chat-edit del");
  // The agent's own call stays in the fold; ours is not counted as work.
  expect(html).toContain("chat-work");
  expect(html).toMatch(/1 tool/);
  expect(html.indexOf("chat-reply")).toBeGreaterThan(html.indexOf("chat-work"));
});

test("a call the page refused says so and keeps the reason; one still going says it is sending", async () => {
  const refused = await render([call("suggest", { mode: "after", place: "inline", markdown: "smoothly" }, { isError: true, result: "A point's result goes `at`." })]);
  expect(refused).toContain("chat-reply suggest refused");
  expect(refused).toContain("not used");
  expect(refused).toContain("A point&#x27;s result goes `at`.");
  const going = await render([call("decline", { reason: "No room." }, { running: true })]);
  expect(going).toContain("chat-reply decline running");
  expect(going).toContain("sending…");
  expect(going).toContain("No room.");
});

test("a call whose arguments can't be read is shown as any other tool call", async () => {
  const html = await render([{ ...call("suggest", {}), args: '{"markdown": "half', running: true }]);
  expect(html).toContain("chat-tool");
  expect(html).not.toContain("chat-reply");
});
