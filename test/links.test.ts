// Where a link in a page leads: relative to the page's own folder, as on GitHub.
import { expect, test } from "bun:test";
import { headingSlug, resolveLink } from "../src/app/editor/links";

test("a relative .md link is a page, from the folder of the page it is in", () => {
  expect(resolveLink("docs/README", "architecture.md")).toEqual({ kind: "page", id: "docs/architecture", hash: "" });
  expect(resolveLink("docs/README", "decisions/0002-use-postgres.md")).toEqual({ kind: "page", id: "docs/decisions/0002-use-postgres", hash: "" });
  expect(resolveLink("docs/README", "../ROADMAP.md")).toEqual({ kind: "page", id: "ROADMAP", hash: "" });
  expect(resolveLink("README", "./docs/a.md")).toEqual({ kind: "page", id: "docs/a", hash: "" });
  expect(resolveLink("docs/a", "/ROADMAP.md")).toEqual({ kind: "page", id: "ROADMAP", hash: "" });
});

test("spaces, encoded or not, and a heading on the other page", () => {
  expect(resolveLink("ROADMAP", "backlog/task-12 - Sync.md")).toEqual({ kind: "page", id: "backlog/task-12 - Sync", hash: "" });
  expect(resolveLink("ROADMAP", "backlog/task%2012.md")).toEqual({ kind: "page", id: "backlog/task 12", hash: "" });
  expect(resolveLink("docs/a", "../ROADMAP.md#now")).toEqual({ kind: "page", id: "ROADMAP", hash: "now" });
});

test("a folder keeps its path, and ends at No such page", () => {
  expect(resolveLink("README", "docs/decisions/")).toEqual({ kind: "page", id: "docs/decisions", hash: "" });
});

test("external links, a heading here, and a link above the project", () => {
  expect(resolveLink("a", "https://x.test/a.md")).toEqual({ kind: "external", url: "https://x.test/a.md" });
  expect(resolveLink("a", "mailto:a@b.test")).toEqual({ kind: "external", url: "mailto:a@b.test" });
  expect(resolveLink("a", "#tile-proxy")).toEqual({ kind: "anchor", hash: "tile-proxy" });
  expect(resolveLink("a", "../x.md")).toEqual({ kind: "outside" });
});

test("headings slug as on GitHub", () => {
  expect(headingSlug("Tile proxy")).toBe("tile-proxy");
  expect(headingSlug("What's new? (v2)")).toBe("whats-new-v2");
  expect(headingSlug("snake_case and-dash")).toBe("snake_case-and-dash");
});
