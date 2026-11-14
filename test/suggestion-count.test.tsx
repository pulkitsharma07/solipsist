// The status bar's suggestion count: renders with the editor the page gives it, and says how many wait.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const reply = (x: string) => `<suggestion mode="at" place="inline">${x}</suggestion>`;

test("nothing when no suggestion waits; the count when some do", async () => {
  const { SuggestionCount } = await import("../src/app/pages/SuggestionCount");
  const server = new Server("One <!-- gen:aaa --> two <!-- gen:bbb --> three.");
  const tab = new Tab(server.src);
  await tab.save(server);
  expect(renderToStaticMarkup(<SuggestionCount editor={tab.editor as never} />)).toBe("");
  server.agentRun("aaa", reply("A"));
  tab.receive(server.src);
  expect(renderToStaticMarkup(<SuggestionCount editor={tab.editor as never} />)).toContain(">1 suggestion</button>");
  server.agentRun("bbb", "<decline>No.</decline>");
  tab.receive(server.src);
  const html = renderToStaticMarkup(<SuggestionCount editor={tab.editor as never} />);
  expect(html).toContain(">2 suggestions</button>");
  expect(html).not.toContain("sug-menu"); // the menu opens on a click
});
