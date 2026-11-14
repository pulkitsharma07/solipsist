// The status bar: text items only (no coloured blocks), toggles that say their state in a word, a dot for the mode and
// the agent.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const noop = () => {};

async function bar(opts: { vim?: boolean; agent?: boolean; tone?: string; build?: { version: string; line: string } } = {}) {
  const { StatusBar } = await import("../src/app/pages/StatusBar");
  const { setVim } = await import("../src/app/editor/vim");
  const tab = new Tab(new Server("Hello there world.\n").src);
  document.body.append(tab.editor.view.dom);
  setVim(tab.editor, !!opts.vim);
  return renderToStaticMarkup(<StatusBar editor={tab.editor} agent={{ on: !!opts.agent, model: "pi:openrouter/~deepseek/deepseek-flash-latest", single: false, cost: 0.0123 }} debug={{ open: false, tone: opts.tone ?? "", toggle: noop }} build={opts.build} />);
}

test("the version, last: short in the bar, the whole --version line in its title", async () => {
  expect(await bar()).not.toContain("sb-version"); // before the hello says
  const rel = await bar({ build: { version: "1.4.2", line: "solipsist 1.4.2 (darwin-arm64, a1b2c3d, 2026-11-10)" } });
  expect(rel).toMatch(/<span class="sb-item sb-version" title="solipsist 1\.4\.2 \(darwin-arm64, a1b2c3d, 2026-11-10\)[^"]*">v1\.4\.2<\/span><\/footer>/);
  const dev = await bar({ build: { version: "0.1.0-dev+a1b2c3d.dirty", line: "solipsist 0.1.0-dev+a1b2c3d.dirty (darwin-x64)" } });
  expect(dev).toContain(">v0.1.0-dev</span>");
});

test("standard editing: the mode, the toggles as words, the position and the count", async () => {
  const html = await bar();
  expect(html).toContain("Standard");
  expect(html).toContain("click to use Vim mode");
  expect(html).toContain("deepseek-flash-latest");
  expect(html).toContain("Single agent <b>off</b>");
  expect(html).toContain("Cost <b>$0.0123</b>");
  expect(html).not.toContain("Auto-merge");
  expect(html).toMatch(/sb-pos">1:\d+</);
  expect(html).toContain("3 words");
  expect(html).not.toContain("Ln ");
  expect(html).not.toContain("sug-count"); // nothing waiting
  expect(html).not.toContain("style=");
});

test("vim: the mode label with a dot that is calm in normal", async () => {
  const html = await bar({ vim: true });
  expect(html).toContain("NORMAL");
  expect(html).not.toMatch(/dot-live"[^>]*><\/span>NORMAL/);
  expect(html).not.toContain("mode-pill");
});

test("the model's dot breathes only while a run is live; the debug dot follows the run", async () => {
  // The bar shows the agent's state; turning it off and on is in the agent panel (`DebugPanel`).
  expect(await bar({ agent: true, tone: "run" })).toMatch(/dot dot-live"><\/span>deepseek-flash-latest/);
  expect(await bar({ agent: true })).toMatch(/dot"><\/span>deepseek-flash-latest/);
  expect(await bar({ agent: false, tone: "run" })).toMatch(/dot"><\/span>deepseek-flash-latest/);
  expect(await bar({ tone: "bad" })).toContain("dot dot-err");
  expect(await bar({ agent: true })).not.toContain("Agent <b>on"); // not the bar's to switch
});
