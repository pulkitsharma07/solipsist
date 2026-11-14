// The settings dialog: the gear, the tabs, and the prompts editor, rendered with the data the server would send.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { LoadedPrompts } from "../src/app/pages/PromptsPane";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const data: LoadedPrompts = {
  dir: "/home/me/.config/solipsist/prompts",
  prompts: [
    { id: "protocol", title: "Protocol", group: "Agent", description: "The system prompt.", slots: [], text: "Be brief.", default: "Be thorough.", custom: true, file: "/home/me/.config/solipsist/prompts/protocol.md" },
    { id: "run", title: "Run prompt", group: "Agent", description: "What each run is sent.", slots: [{ name: "target", description: "The placeholder.", required: true }, { name: "page", description: "The page." }], text: "Do {target}.", default: "Do {target}.", custom: false, file: "/home/me/.config/solipsist/prompts/run.md" },
    { id: "type.gen", title: "Task type: gen", group: "Task types", description: "A gen request.", slots: [], text: "Write.", default: "Write.", custom: false, file: "/x/type.gen.md" },
  ],
};

test("the prompts pane lists them by group, marks the edited one, and shows the first one's editor", async () => {
  const { PromptsPane } = await import("../src/app/pages/PromptsPane");
  const html = renderToStaticMarkup(<PromptsPane initial={data} />);
  expect(html).toContain("<h3>Agent</h3>");
  expect(html).toContain("<h3>Task types</h3>");
  expect(html).not.toContain("<h3>Chat</h3>"); // a group with nothing in it is left out
  expect(html).toMatch(/prompt-item on custom[^>]*>.*Protocol.*<i title="Different from the built-in text">edited<\/i>/);
  expect(html).toContain('aria-label="Protocol text">Be brief.</textarea>');
  expect(html).toContain("Be brief.");
  expect(html).toContain("Saved in /home/me/.config/solipsist/prompts/protocol.md");
  // Nothing changed yet: Save and Revert are off; the prompt is customised, so Reset is on.
  expect(html).toMatch(/<button class="btn btn-primary" disabled="">Save<\/button><button class="btn" disabled="">Revert<\/button><button class="btn btn-ghost"[^>]*>Reset to default<\/button>/);
  expect(html).toContain("applies to the next run");
});

test("the dialog has the gear, both tabs, and the prompts first", async () => {
  const { SettingsButton, SettingsDialog } = await import("../src/app/pages/SettingsDialog");
  expect(renderToStaticMarkup(<SettingsButton />)).toContain('aria-label="Settings"');
  const html = renderToStaticMarkup(<SettingsDialog onClose={() => {}} />);
  expect(html).toContain('role="dialog"');
  expect(html).toMatch(/<button class="dlg-tab on"[^>]*aria-pressed="true">Prompts<\/button><button class="dlg-tab"[^>]*aria-pressed="false">Loaded settings<\/button>/);
});

test("the gear is in the page's top bar and on the pages list", async () => {
  const { TopBar } = await import("../src/app/pages/Frame");
  const { PagesView } = await import("../src/app/pages/PagesView");
  expect(renderToStaticMarkup(<MemoryRouter><TopBar title="T" save="saved" /></MemoryRouter>)).toContain("settings-gear");
  expect(renderToStaticMarkup(<MemoryRouter><PagesView docs={[]} onNew={() => {}} /></MemoryRouter>)).toContain("settings-gear");
});

test("the debug panel is the agent's messages only, with no settings tab", async () => {
  const { DebugPanel } = await import("../src/app/pages/DebugPanel");
  const html = renderToStaticMarkup(<DebugPanel events={[]} link="live" cost={0} model="pi:x" onModel={() => {}} onClear={() => {}} onClose={() => {}} />);
  expect(html).toContain("No messages yet");
  expect(html).not.toContain("view-tab");
});

test("Escape in the moment after an edit warns about it, instead of closing on it", async () => {
  // The dialog's key handler must answer with what the dialog knows now: the edit and the key arrive in one task, so
  // anything the dialog only learns after the next paint is too late (`SettingsDialog`, `PromptsPane.onDirty`).
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { SettingsDialog } = await import("../src/app/pages/SettingsDialog");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  let closed = 0;
  await act(() => root.render(<SettingsDialog onClose={() => { closed++; }} prompts={data} />));
  const box = el.querySelector('[aria-label="Protocol text"]') as HTMLTextAreaElement;
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  await act(() => {
    // The writer types, then hits Escape before anything has been painted.
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(box, `${box.value}\nExtra.`);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    escape();
  });
  expect(closed).toBe(0);
  expect(el.querySelector('[role="alert"]')?.textContent).toContain("unsaved changes");
  expect(el.textContent).toContain("unsaved");

  // Asked once: the next Escape closes it, changes and all.
  await act(() => { escape(); });
  expect(closed).toBe(1);
  await act(() => root.unmount());
  el.remove();
});
