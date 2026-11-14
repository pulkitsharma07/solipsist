// The model picker: the shortlist it shows at a glance, the search over every model the engines can run, and the keys.
// Mounted for real (happy-dom), since all of it but the trigger only exists once it is open.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ReactElement } from "react";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { ModelSelect, searchModels, groupModels, contextSize, priceOf } = await import("../src/app/pages/ModelPicker");
type Option = Parameters<typeof ModelSelect>[0]["models"][number];

/** What the page's stream offers: the writer's preferred model, then each engine's shortlist. */
const MODELS: Option[] = [
  { id: "fake:large", engine: "Fake", title: "Large", preferred: true, context: 200_000, inUsd: 3, outUsd: 15 },
  { id: "pi:openrouter/~deepseek/deepseek-flash-latest", engine: "Pi", title: "DeepSeek Flash Latest", vendor: "DeepSeek", note: "Pi's own default", context: 1_048_576, inUsd: 0.02, outUsd: 1 },
  { id: "fake:small", engine: "Fake", title: "Small", unavailable: "Set FAKE_KEY to use Fake." },
];
/** Every model the writer's engines can run: the shortlist, and more behind the search. */
const CATALOG: Option[] = [
  ...MODELS,
  { id: "pi:openrouter/acme/acme-small-4.5", engine: "Pi", title: "Acme Small 4.5", vendor: "Acme", context: 200_000, inUsd: 1, outUsd: 5 },
  { id: "pi:openrouter/openai/gpt-6.1-sol", engine: "Pi", title: "GPT-6.1 Sol", vendor: "OpenAI", context: 1_050_000, inUsd: 2, outUsd: 10 },
  { id: "pi:openrouter/meta/llama-free", engine: "Pi", title: "Llama Free", vendor: "Meta", context: 128_000, inUsd: 0, outUsd: 0 },
];

const tick = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(ui: ReactElement) {
  const { createRoot } = await import("react-dom/client");
  const el = document.createElement("div");
  document.body.append(el);
  createRoot(el).render(ui);
  await tick();
  const q = <T extends Element>(sel: string) => el.querySelector<T>(sel);
  const all = (sel: string) => [...el.querySelectorAll(sel)];
  return {
    el, q, all,
    text: (sel: string) => all(sel).map((n) => n.textContent ?? ""),
    async click(node: Element | null) { (node as HTMLElement).click(); await tick(); },
    async open() { (q<HTMLElement>(".model-trigger"))!.click(); await tick(); },
    /** Types into the search field the way a writer would: React reads the value off the node it tracks. */
    async type(text: string) {
      const input = q<HTMLInputElement>(".model-search input")!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    },
    async key(key: string) {
      q<HTMLInputElement>(".model-search input")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      await tick();
    },
  };
}

test("closed, it names the model the page is on; open, it lists the shortlist under Preferred and each engine", async () => {
  const v = await mount(<ModelSelect model="fake:large" models={MODELS} catalog={CATALOG} onModel={() => {}} />);
  expect(v.q(".model-name")!.textContent).toBe("Large");
  expect(v.q(".model-menu")).toBeNull();

  await v.open();
  expect(v.text(".model-group-name")).toEqual(["Preferred", "Pi", "Fake"]);
  // Each model's own words: what Pi calls its default, and what a million tokens cost.
  expect(v.text(".model-row-note")).toContain("Pi's own default");
  expect(v.text(".model-row-meta").join(" ")).toContain("200K · $3 / $15");
  // The one that is on now is ticked; the one whose engine isn't set up can't be chosen, and says so.
  expect(v.q(".model-row.on .model-row-name")!.textContent).toBe("Large");
  expect(v.q(".model-row.off")!.getAttribute("title")).toBe("Set FAKE_KEY to use Fake.");
});

test("typing searches every model the engines can run, grouped by vendor, and not only the shortlist", async () => {
  const v = await mount(<ModelSelect model="fake:large" models={MODELS} catalog={CATALOG} onModel={() => {}} />);
  await v.open();
  await v.type("small");
  const names = v.text(".model-row-name");
  // Both the shortlist's Small and one that is only in the catalog.
  expect(names).toEqual(["Small", "Acme Small 4.5"]);
  expect(v.text(".model-group-name")).toEqual(["Fake", "Acme"]);

  await v.type("gpt");
  expect(v.text(".model-row-name")).toEqual(["GPT-6.1 Sol"]);
  await v.type("nothing-like-this");
  expect(v.q(".model-none")!.textContent).toBe("No model matches.");
});

test("Enter picks the model the keys are on, a model that can't run is not picked, and Escape closes", async () => {
  const picked: string[] = [];
  const v = await mount(<ModelSelect model="fake:large" models={MODELS} catalog={CATALOG} onModel={(m) => picked.push(m)} />);

  await v.open();
  await v.type("gpt");
  await v.key("Enter");
  expect(picked).toEqual(["pi:openrouter/openai/gpt-6.1-sol"]);
  // Picking closes it.
  expect(v.q(".model-menu")).toBeNull();

  await v.open();
  await v.type("small");
  // The first result is the one whose engine isn't set up: clicking it does nothing.
  await v.click(v.q(".model-row.off"));
  expect(picked).toEqual(["pi:openrouter/openai/gpt-6.1-sol"]);
  expect(v.q(".model-menu")).not.toBeNull();

  await v.key("Escape");
  expect(v.q(".model-menu")).toBeNull();
});

test("before the server has listed its models, the picker still names the page's choice", async () => {
  const v = await mount(<ModelSelect model="pi:openrouter/z-ai/glm" models={[]} catalog={[]} onModel={() => {}} />);
  expect(v.q(".model-name")!.textContent).toBe("openrouter/z-ai/glm");
  await v.open();
  expect(v.text(".model-row-name")).toEqual(["openrouter/z-ai/glm"]);
});

test("search: every word must match, a name that starts with it comes first, a preferred model before its equals", () => {
  // Both words anywhere in the name, the vendor, the engine or the id.
  expect(searchModels(CATALOG, "acme small").map((m) => m.id)).toEqual(["pi:openrouter/acme/acme-small-4.5"]);
  expect(searchModels(CATALOG, "fake small").map((m) => m.id)).toEqual(["fake:small"]);
  // "Small" starts with what was typed; "Acme Small 4.5" only contains it.
  expect(searchModels(CATALOG, "small").map((m) => m.title)).toEqual(["Small", "Acme Small 4.5"]);
  // Matches on the id too, which is where the provider is.
  expect(searchModels(CATALOG, "openrouter/meta").map((m) => m.title)).toEqual(["Llama Free"]);
  expect(searchModels(CATALOG, "   ")).toEqual([]);
});

test("the list is grouped by engine at a glance, and by vendor while searching", () => {
  expect(groupModels(MODELS, false).map((g) => g.group)).toEqual(["Preferred", "Pi", "Fake"]);
  expect(groupModels(CATALOG, true).map((g) => g.group)).toEqual(["Fake", "DeepSeek", "Acme", "OpenAI", "Meta"]);
});

test("a model's size and price as the row says them", () => {
  expect(contextSize(1_048_576)).toBe("1M");
  expect(contextSize(200_000)).toBe("200K");
  expect(contextSize(1_050_000)).toBe("1.1M");
  expect(priceOf({ id: "a", engine: "Pi", title: "A", inUsd: 0.02, outUsd: 1 })).toBe("$0.02 / $1");
  expect(priceOf({ id: "a", engine: "Pi", title: "A", inUsd: 3, outUsd: 15 })).toBe("$3 / $15");
  expect(priceOf({ id: "a", engine: "Pi", title: "A", inUsd: 0, outUsd: 0 })).toBe("free");
  expect(priceOf({ id: "a", engine: "Pi", title: "A" })).toBeNull();
});
