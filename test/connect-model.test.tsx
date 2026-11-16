// Connect an AI model: the dialog a page opens with when no AI model can run. It asks for an OpenRouter key, says where to
// get one, sends it to the server (`save`, a stand-in here) and says why one wasn't kept.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// react-dom keeps the `setTimeout` and `queueMicrotask` it finds when it first loads. Under happy-dom those are the
// window's, which stop once it is unregistered, and a later file's renders would then never commit: so react-dom is
// loaded here with Bun's own, the DOM being there already.
const native = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, queueMicrotask: globalThis.queueMicrotask };
beforeAll(async () => {
  GlobalRegistrator.register();
  const dom = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, queueMicrotask: globalThis.queueMicrotask };
  Object.assign(globalThis, native);
  await import("react-dom/client");
  Object.assign(globalThis, dom);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
// The act flag is process-wide: left on, a later file that renders without act would never see its updates.
afterAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; GlobalRegistrator.unregister(); });
const noop = () => {};

test("it says how to get a key and asks for it", async () => {
  const { ConnectModel } = await import("../src/app/pages/ConnectModel");
  const html = renderToStaticMarkup(<ConnectModel onClose={noop} />);
  expect(html).toContain("Connect an AI model");
  expect(html).toContain('href="https://openrouter.ai/settings/keys"');
  expect(html).toContain('type="password"');
  expect(html).toContain('aria-label="OpenRouter key"');
  expect(html).toContain("SOLIPSIST_OPENROUTER_KEY"); // the other ways are still there
  expect(html).toContain("<code>/login</code>");
});

test("with saving turned off it only says how to set a key", async () => {
  const { ConnectModel } = await import("../src/app/pages/ConnectModel");
  const html = renderToStaticMarkup(<ConnectModel onClose={noop} canSave={false} />);
  expect(html).not.toContain("<input");
  expect(html).toContain("SOLIPSIST_OPENROUTER_KEY");
});

async function mount(save: (key: string) => Promise<any>) {
  // Loaded after happy-dom is registered: react-dom decides at load whether there is a DOM to listen to.
  const { ConnectModel } = await import("../src/app/pages/ConnectModel");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const seen = { connected: 0, closed: 0, sent: [] as string[] };
  act(() => root.render(<ConnectModel onClose={() => { seen.closed++; }} onConnected={() => { seen.connected++; }} save={async (k) => { seen.sent.push(k); return save(k); }} />));
  const input = el.querySelector('[aria-label="OpenRouter key"]') as HTMLInputElement;
  const button = () => [...el.querySelectorAll("button")].find((b) => /Save key|Checking/.test(b.textContent ?? "")) as HTMLButtonElement;
  const type = (v: string) => act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => act(async () => { button().click(); });
  return { el, seen, button, type, submit, act, done: () => { act(() => root.unmount()); el.remove(); } };
}

test("Save key sends the trimmed key and reports success", async () => {
  const m = await mount(async () => ({ ok: true, noEngine: false }));
  expect(m.button().disabled).toBe(true);
  await m.type("  sk-or-v1-abc  ");
  expect(m.button().disabled).toBe(false);
  await m.submit();
  expect(m.seen.sent).toEqual(["sk-or-v1-abc"]);
  expect(m.seen.connected).toBe(1);
  m.done();
});

test("a refused key says why and stays open", async () => {
  const m = await mount(async () => ({ ok: false, error: "OpenRouter didn't accept that key." }));
  await m.type("sk-or-v1-bad");
  await m.submit();
  expect(m.el.querySelector('[role="alert"]')?.textContent).toBe("OpenRouter didn't accept that key.");
  expect(m.seen.connected).toBe(0);
  await m.type("sk-or-v1-bad2"); // typing again clears it
  expect(m.el.querySelector('[role="alert"]')).toBeNull();
  m.done();
});

test("Not now closes it", async () => {
  const m = await mount(async () => ({ ok: true, noEngine: false }));
  m.act(() => { ([...m.el.querySelectorAll("button")].find((b) => b.textContent === "Not now") as HTMLButtonElement).click(); });
  expect(m.seen.closed).toBe(1);
  m.done();
});
