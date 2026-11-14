// The page chat's button: the engine's mark, and how the chat's agent is, by state.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { asPageChatStatus, ChatLaunch, type PageChatStatus } from "../src/app/pages/ChatLaunch";

const render = (status?: PageChatStatus, engine = "pi") => renderToStaticMarkup(<ChatLaunch engine={engine} engineTitle={engine === "pi" ? "Pi" : engine} status={status} onOpen={() => {}} />);

test("quiet with no agent: the mark and its name, nothing lit", () => {
  const html = render();
  expect(html).toContain('data-state="none"');
  expect(html).toContain('aria-label="Chat with Pi about this page"');
  expect(html).toContain("pi-logo");
  expect(html).not.toContain("pi-launch-ring");
  expect(html).not.toContain("pi-launch-dot");
});

test("each state is on the button and in its name; only a reply in flight runs the ring", () => {
  expect(render({ state: "snoozed" })).toContain("(its conversation is kept)");
  expect(render({ state: "waiting" })).toContain('data-state="waiting"');
  expect(render({ state: "waiting" })).not.toContain("pi-launch-ring");
  const working = render({ state: "working" }, "pi");
  expect(working).toContain('data-state="working"');
  expect(working).toContain("pi-launch-ring");
  expect(working).toContain("pi-launch-halo");
  expect(working).toContain("Chat with Pi about this page (it is replying)");
});

test("a reply that came while the chat was closed shows a dot, and says so", () => {
  const html = render({ state: "waiting", unread: true });
  expect(html).toContain("pi-launch-dot");
  expect(html).toContain("(its agent is up, a new reply)");
});

test("reads a status from the stream, refusing anything else", () => {
  expect(asPageChatStatus({ state: "working", at: 1, event: "pichat" })).toEqual({ state: "working" });
  expect(asPageChatStatus({ state: "open", unread: true })).toEqual({ state: "open", unread: true });
  expect(asPageChatStatus({ state: "dancing" })).toBeNull();
  expect(asPageChatStatus(undefined)).toBeNull();
});
