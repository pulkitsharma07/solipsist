import { describe, expect, test } from "bun:test";
import { docToMarkdown, markdownToDoc, markerComments } from "../src/shared/docfile";
import { isPageId, isTaskId, newTaskId, pageUrl, TASK_ID } from "../src/shared/ids";

describe("ids", () => {
  test("page ids: a path from the project, without .md", () => {
    for (const ok of ["a", "README", "My Notes", "a.b", "docs/decisions/0002-use-postgres", "backlog/tasks/task-12 - Sync", "é"]) expect(isPageId(ok)).toBe(true);
    for (const bad of ["", "/a", "a/", "a//b", "../x", "a/../b", ".hidden", "docs/.git/x", "a\\b", "a\n", "a".repeat(1025)]) expect(isPageId(bad)).toBe(false);
    expect(isPageId(undefined)).toBe(false);
  });

  test("a page's address keeps its folders and encodes the rest", () => {
    expect(pageUrl("docs/My Notes")).toBe("/d/docs/My%20Notes");
  });

  test("placeholder ids: 3 to 6 of a-z0-9", () => {
    for (const ok of ["abc", "a1b2c", "abcdef", "000"]) expect(isTaskId(ok)).toBe(true);
    for (const bad of ["", "ab", "abcdefg", "ABC", "ab-c", "abc\n", "a c"]) expect(isTaskId(bad)).toBe(false);
    expect(isTaskId(3)).toBe(false);
    expect(TASK_ID.test("xyz12")).toBe(true);
  });

  test("newTaskId: five characters, never one that is taken", () => {
    const seq = [0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5]; // "aaaaa", then another
    let i = 0;
    const id = newTaskId(new Set(["aaaaa"]), () => seq[i++ % seq.length]!);
    expect(id).toMatch(/^[a-z0-9]{5}$/);
    expect(id).not.toBe("aaaaa");
    for (let k = 0; k < 200; k++) {
      const made = newTaskId(["abcde"]);
      expect(isTaskId(made)).toBe(true);
      expect(made).toHaveLength(5);
    }
  });

  test("a page with a 3-character and a 5-character placeholder round-trips", () => {
    const md = "Before <!-- gen:abc --> and <!-- sel:k9x2z:ack \"shorter\" -->some text<!-- /sel:k9x2z:ack --> after, <!-- gen:q1w2e:sug -->.";
    expect(markerComments(md).map((c) => c.id)).toEqual(["abc", "k9x2z", "k9x2z", "q1w2e"]);
    const out = docToMarkdown(markdownToDoc(md));
    expect(markerComments(out).map((c) => [c.taskType, c.id, c.state])).toEqual([
      ["gen", "abc", "pending"], ["sel", "k9x2z", "ack"], ["sel", "k9x2z", "ack"], ["gen", "q1w2e", "sug"],
    ]);
    expect(docToMarkdown(markdownToDoc(out))).toBe(out);
  });

  test("an id that looks like a state code does not swallow it", () => {
    const md = "x <!-- gen:abcs:ack --> y <!-- gen:abc:sug -->";
    const out = docToMarkdown(markdownToDoc(md));
    expect(markerComments(out).map((c) => [c.id, c.state])).toEqual([["abcs", "ack"], ["abc", "sug"]]);
  });
});
