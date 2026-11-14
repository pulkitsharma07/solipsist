// The panel that shows the agent's messages: renders with the props the page gives it, and shows what it is told.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "../src/app/doc/client";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const noop = () => {};
const at = Date.now();
const MODELS = [
  { id: "fake:small", engine: "Fake", title: "Small" },
  { id: "fake:large", engine: "Fake", title: "Large" },
  { id: "pi:z-ai/glm", engine: "Pi", title: "z-ai/glm", unavailable: "Set SOLIPSIST_OPENROUTER_KEY (in .env or the environment) to use Pi." },
];
async function render(events: AgentEvent[], model = "fake:small", link: "live" | "offline" | "refused" | "paused" = "live") {
  const { DebugPanel } = await import("../src/app/pages/DebugPanel");
  return renderToStaticMarkup(<DebugPanel events={events} link={link} cost={0.0123} model={model} models={MODELS} onModel={noop} onClear={noop} onClose={noop} />);
}

test("renders with no messages", async () => {
  const html = await render([]);
  expect(html).toContain("No messages yet");
});

// The picker's own list, search and keys are in test/model-picker.test.tsx: closed, it is one button.
test("the header's model picker names the model the page is on", async () => {
  const html = await render([], "fake:large");
  expect(html).toContain('<span class="model-name">Large</span>');
  expect(html).toContain('aria-haspopup="listbox"');
});

test("before the server has listed its models, the picker shows the current choice", async () => {
  const { DebugPanel } = await import("../src/app/pages/DebugPanel");
  const html = renderToStaticMarkup(<DebugPanel events={[]} link="live" cost={0} model="pi:z-ai/glm" onModel={noop} onClear={noop} onClose={noop} />);
  expect(html).toContain('<span class="model-name">z-ai/glm</span>');
});

test("a run in progress, a finished one, a failed one and a model switch each show up", async () => {
  const html = await render([
    { event: "hello", at, model: "small", gapMs: 1000 },
    { event: "start", at, run: 1 },
    { event: "step", at, run: 1, kind: "tool", text: "Read /x" },
    { event: "end", at, run: 1, ok: true, durationMs: 1500, costUsd: 0.001 },
    { event: "model", at, model: "large" },
    { event: "start", at, run: 2 },
    { event: "end", at, run: 2, ok: false, durationMs: 900, error: "boom" },
  ]);
  for (const s of ["run #1 started", "Read /x", "run #1 finished", "now large", "run #2 failed", "boom"]) expect(html).toContain(s);
});

test("a refused or offline agent says so", async () => {
  expect(await render([], "fake:small", "refused")).toContain("another tab");
  expect(await render([], "fake:small", "offline")).toContain("Reconnecting");
});

test("a skipped run says why: nothing waiting, or the page unchanged", async () => {
  const { agentPhase } = await import("../src/app/pages/DebugPanel");
  const idle = [{ event: "skip", at, run: 0, reason: "nothing pending" }];
  expect(await render(idle)).toContain("no request is waiting");
  expect(agentPhase(idle, "live").label).toBe("Idle: nothing to do");
  const same = [{ event: "skip", at, run: 1, reason: "unchanged" }];
  expect(await render(same)).toContain("page unchanged since the last prompt");
  expect(agentPhase(same, "live").label).toBe("Idle: page unchanged");
});

/** Two runs at once (#1 and #2), after one that has ended (#0 of an earlier stream does not count). */
const twoRuns: AgentEvent[] = [
  { event: "start", at, run: 1, taskType: "gen", task: "old" },
  { event: "hello", at, model: "fake:small", concurrency: 3 },
  { event: "start", at, run: 1, taskType: "gen", task: "aaa" },
  { event: "start", at, run: 2, taskType: "sel", task: "bbb" },
  { event: "step", at, run: 1, kind: "text", text: "first run says" },
  { event: "step", at, run: 2, kind: "text", text: "second run says" },
  { event: "start", at, run: 3, taskType: "gen", task: "ccc" },
  { event: "end", at, run: 3, ok: true, durationMs: 10 },
];

test("the runs in flight each have a tab, and the phase counts them; one that has ended has none", async () => {
  const { agentPhase } = await import("../src/app/pages/DebugPanel");
  const html = await render(twoRuns);
  const tabs = html.slice(html.indexOf('<nav class="runs"'), html.indexOf("</nav>", html.indexOf('<nav class="runs"')));
  expect(tabs).toContain("#1 gen:aaa");
  expect(tabs).toContain("#2 sel:bbb");
  expect(tabs).not.toContain("#3 gen:ccc");
  expect(tabs).not.toContain("gen:old"); // from before the stream reconnected
  expect(agentPhase(twoRuns, "live").label).toBe("Running 2 runs");
  expect(html).toContain("up to 3 runs at once");
  expect(await render([{ event: "hello", at, model: "fake:small" }])).toContain("No run in flight");
});

test("‹ › cycle through the runs in flight, showing only the picked one's messages, then all again", async () => {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { DebugPanel } = await import("../src/app/pages/DebugPanel");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const draw = (events: AgentEvent[]) => act(() => root.render(<DebugPanel events={events} link="live" cost={0} model="fake:small" models={MODELS} onModel={noop} onClear={noop} onClose={noop} />));
  await draw(twoRuns);
  const text = () => el.querySelector(".events")!.textContent!;
  const press = (label: string) => act(() => { (el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); });
  expect(text()).toContain("first run says");
  expect(text()).toContain("second run says");
  await press("Next run");
  expect(text()).toContain("first run says");
  expect(text()).not.toContain("second run says");
  await press("Next run");
  expect(text()).toContain("second run says");
  expect(text()).not.toContain("first run says");
  // The picked run ends: it keeps its tab, and its messages, until another is picked.
  await draw([...twoRuns, { event: "end", at, run: 2, ok: false, durationMs: 5, error: "boom" }]);
  expect(el.textContent).toContain("#2 sel:bbb");
  expect(text()).toContain("run #2 failed");
  await press("Next run");
  expect(text()).toContain("first run says");
  expect(text()).toContain("second run says"); // all again
  await press("Previous run");
  expect(text()).not.toContain("second run says"); // #2 has ended and is no longer listed: back to #1
  expect(text()).toContain("first run says");
  await act(() => root.unmount());
  el.remove();
});

test("the agent switch: what it says and what it does, and nothing when the page sends none", async () => {
  const { DebugPanel } = await import("../src/app/pages/DebugPanel");
  const panel = (agent?: { on: boolean; toggle(): void }) =>
    renderToStaticMarkup(<DebugPanel events={[]} link={agent?.on === false ? "paused" : "live"} cost={0} model="fake:small" models={MODELS} agent={agent} onModel={noop} onClear={noop} onClose={noop} />);
  expect(panel({ on: true, toggle: noop })).toContain("Agent <b>on</b>");
  expect(panel({ on: true, toggle: noop })).toContain("background agent is running");
  expect(panel({ on: false, toggle: noop })).toContain("Agent <b>off</b>");
  expect(panel({ on: false, toggle: noop })).toContain("background agent is stopped");
  expect(panel()).not.toContain("agent-switch");

  // Clicking it tells the page, which saves the choice in the page's file.
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  let toggles = 0;
  await act(() => root.render(<DebugPanel events={[]} link="live" cost={0} model="fake:small" models={MODELS} agent={{ on: true, toggle: () => { toggles++; } }} onModel={noop} onClear={noop} onClose={noop} />));
  // On mousedown, so the editor keeps its focus.
  await act(() => { el.querySelector(".agent-switch")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
  expect(toggles).toBe(1);
  await act(() => root.unmount());
  el.remove();
});
