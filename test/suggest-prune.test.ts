// A decided suggestion keeps its proposal for a while, so Undo can bring it back, then the cleanup stage drops it.
import { expect, test } from "bun:test";
import { pruneFile } from "../src/server/put";
import { nextSuggestionExpiry } from "../src/server/suggest";
import { emptyBlock, parseFile, serializeFile, type TaskRecord } from "../src/shared/docfile";

const rec = (extra: Partial<TaskRecord>): TaskRecord => ({ type: "gen", created_by: "writer", created: "2026-10-27T09:00:00.000Z", status: "suggested", suggestion: "P", ...extra });
const file = (records: Record<string, TaskRecord>) => serializeFile("Body.", { ...emptyBlock(), tasks: records });
const AT = "2026-10-27T10:00:00.000Z";

test("decided suggestions lose their proposal and what the run saw once they are old enough; the rest stays", () => {
  const src = file({
    acc: rec({ status: "accepted", reviewed: AT, saw: "s" }),
    rej: rec({ status: "rejected", reviewed: AT }),
    edi: rec({ status: "edited", reviewed: AT }),
    waits: rec({}), // still waiting for the writer
    again: rec({ status: "pending", asked_again: 1, reviewed: AT }), // the next run's prompt needs it
    drop: rec({ status: "dropped" }),
  });
  const block = parseFile(src).block;
  expect(nextSuggestionExpiry(block, 30_000)).toBe(Date.parse(AT) + 30_000);
  expect(pruneFile(src, new Date(Date.parse(AT) + 29_000), 30_000)).toBeNull();
  const r = pruneFile(src, new Date(Date.parse(AT) + 30_000), 30_000)!;
  const after = parseFile(r.file).block.tasks!;
  expect(after.acc).toEqual({ type: "gen", created_by: "writer", created: "2026-10-27T09:00:00.000Z", status: "accepted", reviewed: AT });
  expect(after.rej!.suggestion).toBeUndefined();
  expect(after.edi!.suggestion).toBeUndefined();
  expect(after.waits!.suggestion).toBe("P");
  expect(after.again!.suggestion).toBe("P");
  expect(after.drop!.suggestion).toBe("P");
  expect(nextSuggestionExpiry(parseFile(r.file).block, 30_000)).toBeNull();
  expect(parseFile(r.file).markdown).toBe("Body.");
});
