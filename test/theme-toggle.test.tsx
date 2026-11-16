// The light / dark toggle: shows the way to the other theme, switches `data-theme` (read by tokens.css), keeps the
// choice in this browser, and puts it back before the next page draws.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

// react-dom keeps the timers it finds when it first loads: Bun's own here, which outlive this file's window.
const native = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, queueMicrotask: globalThis.queueMicrotask };
beforeAll(async () => {
  GlobalRegistrator.register();
  const dom = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, queueMicrotask: globalThis.queueMicrotask };
  Object.assign(globalThis, native);
  await import("react-dom/client");
  Object.assign(globalThis, dom);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; GlobalRegistrator.unregister(); });
beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; });

test("it sits beside the gear, in the top bar and on the pages list", async () => {
  const { TopBar } = await import("../src/app/pages/Frame");
  const { PagesView } = await import("../src/app/pages/PagesView");
  for (const html of [renderToStaticMarkup(<MemoryRouter><TopBar title="T" save="saved" /></MemoryRouter>), renderToStaticMarkup(<MemoryRouter><PagesView docs={[]} onNew={() => {}} /></MemoryRouter>)]) {
    expect(html).toMatch(/theme-toggle[^>]*>.*settings-gear/s);
  }
});

test("a click switches to the other theme and keeps it; the next load puts it back", async () => {
  const { ThemeToggle, applySavedTheme, savedTheme } = await import("../src/app/pages/ThemeToggle");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(<ThemeToggle />));
  const button = () => el.querySelector(".theme-toggle") as HTMLButtonElement;
  const start = button().getAttribute("aria-label");
  const first = start === "Switch to dark mode" ? "dark" : "light";
  act(() => button().click());
  expect(document.documentElement.getAttribute("data-theme")).toBe(first);
  expect(savedTheme() as string).toBe(first);
  expect(button().getAttribute("aria-label")).toBe(first === "dark" ? "Switch to light mode" : "Switch to dark mode");
  act(() => button().click());
  expect(savedTheme() as string).toBe(first === "dark" ? "light" : "dark");
  delete document.documentElement.dataset.theme;
  applySavedTheme();
  expect(document.documentElement.getAttribute("data-theme")).toBe(savedTheme() as string);
  act(() => root.unmount());
});
