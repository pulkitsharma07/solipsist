// Copy page's button in the top bar: what it shows idle, after a copy and after a failed one.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};

test("idle, copied and failed each show themselves, with the same label", async () => {
  const { CopyButtonView } = await import("../src/app/pages/CopyButton");
  const idle = renderToStaticMarkup(<CopyButtonView copy={{ state: "idle" }} onCopy={noop} />);
  expect(idle).toContain('class="btn btn-ghost copy-page idle"');
  expect(idle).toContain('aria-label="Copy page as markdown"');
  expect(idle).toContain('title="Copy page as markdown"');
  const copied = renderToStaticMarkup(<CopyButtonView copy={{ state: "copied", note: "Copied (1 of 2 images linked, not embedded: over 8 MB of images)" }} onCopy={noop} />);
  expect(copied).toContain("copy-page copied");
  expect(copied).toContain('aria-label="Copy page as markdown"');
  expect(copied).toContain("over 8 MB of images");
  expect(copied).toContain(">Copied</span>");
  const failed = renderToStaticMarkup(<CopyButtonView copy={{ state: "failed", note: "Couldn't copy: denied" }} onCopy={noop} />);
  expect(failed).toContain("copy-page failed");
  expect(failed).toContain("Couldn&#x27;t copy: denied");
});

test("the top bar no longer holds the button: it sits above the page", async () => {
  const { TopBar } = await import("../src/app/pages/Frame");
  expect(renderToStaticMarkup(<MemoryRouter><TopBar title="T" save="saved" /></MemoryRouter>)).not.toContain("copy-page");
});

async function clickWith(run: () => Promise<{ note: string }>) {
  const { CopyButton } = await import("../src/app/pages/CopyButton");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<CopyButton run={run} />));
  const button = () => host.querySelector("button.copy-page") as HTMLButtonElement;
  await act(async () => button().click());
  return { button, done: () => { act(() => root.unmount()); host.remove(); } };
}

test("a click copies and shows Copied, then goes back to idle", async () => {
  const { COPY_SHOWN_MS } = await import("../src/app/pages/CopyButton");
  let runs = 0;
  const { button, done } = await clickWith(async () => { runs++; return { note: "Copied" }; });
  expect(runs).toBe(1);
  expect(button().className).toContain("copied");
  expect(button().title).toBe("Copied");
  await act(() => new Promise((r) => setTimeout(r, COPY_SHOWN_MS + 50)));
  expect(button().className).toContain("idle");
  done();
});

test("a failed copy says why", async () => {
  const { button, done } = await clickWith(async () => { throw new Error("Write permission denied."); });
  expect(button().className).toContain("failed");
  expect(button().title).toBe("Couldn't copy: Write permission denied.");
  done();
});
