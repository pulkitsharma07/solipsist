// The pages list and its file dialog, rendered against a fake server: when the dialog opens by itself, what Cancel
// records, the count on Add files, and coming back to the tab asking again.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { SetupInfo } from "../src/app/doc/client";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const base: SetupInfo = { project: true, needed: false, changed: false, found: [], searchPaths: ["*.md"], capped: false };

/** A server whose setup answer is `setup()` each time; returns what was posted to /api/setup and how often it was read. */
function fakeServer(setup: () => SetupInfo) {
  const posts: unknown[] = [];
  let reads = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === "/api/pages") return Response.json([{ id: "a", title: "A", mtime: 0 }]);
    if (u === "/api/setup" && init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return Response.json({ failed: [] }); }
    if (u === "/api/setup") { reads++; return Response.json(setup()); }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  return { posts, reads: () => reads };
}

async function mount() {
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const { Pages, pagesLoader } = await import("../src/app/pages/Pages");
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const router = createMemoryRouter([{ path: "/", element: <Pages />, loader: pagesLoader }]);
  await act(async () => { root.render(<RouterProvider router={router} />); await router.navigate("/"); });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  await settle();
  const dialog = () => el.querySelector('[role="dialog"]');
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;
  const done = async () => { await act(() => root.unmount()); el.remove(); };
  return { el, act, settle, dialog, button, done };
}

test("after the search paths change, the dialog opens by itself, and Cancel records that it was answered", async () => {
  let setup: SetupInfo = { ...base, changed: true, found: ["notes/b.md"], searchPaths: ["*.md", "notes/*.md"] };
  const server = fakeServer(() => setup);
  const ui = await mount();
  expect(ui.dialog()?.textContent).toContain("b.md");
  // Nothing is ticked: these weren't asked for one by one.
  expect((ui.dialog()!.querySelector(".btn-primary") as HTMLButtonElement).disabled).toBe(true);

  setup = { ...setup, changed: false };
  await ui.act(async () => { ui.button("Cancel").click(); });
  await ui.settle();
  expect(server.posts).toEqual([{ paths: [] }]);
  expect(ui.dialog()).toBeNull();
  await ui.done();
});

test("with nothing changed there's no dialog, and Add files counts the files not added yet", async () => {
  fakeServer(() => ({ ...base, found: ["b.md", "c.md"] }));
  const ui = await mount();
  expect(ui.dialog()).toBeNull();
  expect(ui.button("Add files").textContent).toBe("Add files2");
  expect(ui.button("Add files").querySelector(".btn-count")?.textContent).toBe("2");
  // Opened by hand, Cancel just closes it: nothing to record.
  await ui.act(async () => { ui.button("Add files").click(); });
  expect(ui.dialog()).not.toBeNull();
  await ui.done();
});

test("no count when every file is already a page", async () => {
  fakeServer(() => base);
  const ui = await mount();
  expect(ui.button("Add files").textContent).toBe("Add files");
  await ui.done();
});

test("coming back to the tab asks the server again, so a restart with new search paths shows without a reload", async () => {
  let setup: SetupInfo = base;
  const server = fakeServer(() => setup);
  const ui = await mount();
  expect(ui.dialog()).toBeNull();
  const before = server.reads();

  setup = { ...base, changed: true, found: ["notes/b.md"] };
  await ui.act(async () => { window.dispatchEvent(new Event("focus")); });
  await ui.settle();
  expect(server.reads()).toBe(before + 1);
  expect(ui.dialog()?.textContent).toContain("b.md");
  await ui.done();
});

test("a first launch in a folder with no markdown offers a new page, and creating it opens it", async () => {
  const setup: SetupInfo = { ...base, needed: true };
  const made: unknown[] = [];
  let taken = true;
  fakeServer(() => setup);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/pages" && init?.method === "POST") {
      made.push(JSON.parse(String(init.body)));
      return taken ? Response.json({ error: "taken" }, { status: 400 }) : Response.json({ id: "notes" });
    }
    return inner(url, init);
  }) as typeof fetch;
  const ui = await mount();
  expect(ui.dialog()?.textContent).toContain("Start with a new page");
  expect(ui.dialog()?.textContent).not.toContain("Add 0 files");
  const field = ui.dialog()!.querySelector('input[aria-label="Path of the new page"]') as HTMLInputElement;
  expect(field.value).toBe("notes.md");

  // Refused (the name is taken): it says so and stays.
  await ui.act(async () => { ui.button("Create page").click(); });
  await ui.settle();
  expect(made).toEqual([{ path: "notes.md" }]);
  expect(ui.dialog()?.textContent).toContain("Couldn't create notes.md");

  taken = false;
  await ui.act(async () => { ui.button("Create page").click(); });
  await ui.settle();
  // Made: the dialog gives way to the page.
  expect(made).toHaveLength(2);
  expect(ui.dialog()).toBeNull();
  await ui.done();
});
