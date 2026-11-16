// The product tour: a stop for each part of the page that is there, Next / Back / Skip, the keys only while the card
// has focus, and seen once it is finished or skipped.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

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
beforeEach(() => { localStorage.clear(); document.body.innerHTML = ""; });

/** The parts the tour points at, as the page draws them; `leave` out some. */
function page(leave: string[] = []) {
  const parts: Record<string, string> = {
    agent: '<button class="pi-launch"></button>',
    mode: '<button class="sb-item sb-mode"></button>', model: '<button class="sb-item sb-model"></button>',
    cost: '<span class="sb-item sb-cost"></span>',
    review: '<button class="sb-item review-page"></button>', debug: '<button class="sb-item debug-toggle"></button>',
  };
  const keep = (ids: string[]) => ids.filter((id) => !leave.includes(id)).map((id) => parts[id]).join("");
  document.body.innerHTML = `${keep(["agent"])}<footer class="statusbar">${keep(["mode", "model", "cost", "review", "debug"])}</footer>`;
}

async function mount() {
  const { ProductTour } = await import("../src/app/pages/ProductTour");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  let closed = 0;
  act(() => root.render(<ProductTour onClose={() => { closed++; }} />));
  const card = () => el.querySelector(".tour-card");
  const title = () => card()?.querySelector("h3")?.textContent;
  const count = () => card()?.querySelector(".tour-count")?.textContent;
  const press = (label: string) => act(() => { ([...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement).click(); });
  const key = (k: string) => act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  return { el, card, title, count, press, key, act, closed: () => closed, done: () => act(() => root.unmount()) };
}

test("the page agent first, then the status bar, left to right", async () => {
  page();
  const t = await mount();
  const seen: string[] = [];
  for (;;) {
    seen.push(t.title()!);
    if (t.count()!.startsWith("6 of 6")) break;
    t.press("Next");
  }
  expect(seen).toEqual(["Your page agent", "Editing mode", "AI model", "Cost", "Page review", "Agent panel"]);
  expect(t.el.querySelector(".tour-ring")).not.toBeNull();
  const { tourSeen } = await import("../src/app/pages/ProductTour");
  expect(tourSeen()).toBe(false);
  t.press("Done");
  expect(t.closed()).toBe(1);
  expect(tourSeen()).toBe(true);
  t.done();
});

test("a part that isn't on the page is skipped, and Back goes back", async () => {
  page(["review"]);
  const t = await mount();
  expect(t.count()).toBe("1 of 5");
  t.press("Next"); t.press("Next"); t.press("Next");
  expect(t.title()).toBe("Cost");
  t.press("Back");
  expect(t.title()).toBe("AI model");
  t.done();
});

test("Skip tour ends it and marks it seen", async () => {
  page();
  const t = await mount();
  t.press("Skip tour");
  const { tourSeen } = await import("../src/app/pages/ProductTour");
  expect(t.closed()).toBe(1);
  expect(tourSeen()).toBe(true);
  t.done();
});

test("the arrows and Escape move it only while its card has focus: elsewhere they are the editor's", async () => {
  page();
  const t = await mount();
  const outside = document.createElement("textarea");
  document.body.append(outside);
  outside.focus();
  t.key("ArrowRight");
  t.key("Escape");
  expect(t.title()).toBe("Your page agent");
  expect(t.closed()).toBe(0);
  (t.card()!.querySelector(".btn-primary") as HTMLButtonElement).focus();
  t.key("ArrowRight");
  expect(t.title()).toBe("Editing mode");
  t.key("Escape");
  expect(t.closed()).toBe(1);
  t.done();
});

test("the card goes above a part low on the screen and below one near the top, on screen either way", async () => {
  const { cardPlace } = await import("../src/app/pages/ProductTour");
  const view = { width: 1000, height: 800 };
  expect(cardPlace({ top: 780, left: 900, width: 80, height: 20 }, view)).toMatchObject({ side: "above", left: 1000 - 320 - 16 });
  expect(cardPlace({ top: 20, left: 0, width: 44, height: 44 }, view)).toMatchObject({ side: "below", left: 16 });
});

test("the card, drawn alone", async () => {
  const { TourCard, TOUR_STEPS } = await import("../src/app/pages/ProductTour");
  const html = renderToStaticMarkup(<TourCard step={TOUR_STEPS[0]!} index={0} total={6} onBack={() => {}} onNext={() => {}} onSkip={() => {}} />);
  expect(html).toContain("1 of 6");
  expect(html).toContain("Skip tour");
  expect(html).not.toContain(">Back<");
  expect(html).toContain("<kbd>");
});
