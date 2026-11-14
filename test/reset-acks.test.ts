import { expect, test } from "bun:test";
import { resetAcks } from "../src/server/put";
import { emptyBlock, parseFile, serializeFile } from "../src/shared/docfile";

test("resetAcks moves every ack back to pending, both comments of a sel pair, and touches nothing else", () => {
  const body = "Text <!-- gen:abc:ack --> more.\n\n<!-- sel:def:ack -->Plan it<!-- /sel:def:ack --> and <!-- gen:ghi -->\n\n```\n<!-- gen:zzz:ack -->\n```";
  const src = serializeFile(body, { ...emptyBlock(), tasks: { abc: { type: "gen", created_by: "writer", created: "t", status: "ack", acked: "t" } } });
  const r = resetAcks(src, new Date("2026-10-25T12:00:00Z"))!;
  expect(r.ids.sort()).toEqual(["abc", "def"]);
  const { markdown, block } = parseFile(r.file);
  expect(markdown).toBe("Text <!-- gen:abc --> more.\n\n<!-- sel:def -->Plan it<!-- /sel:def --> and <!-- gen:ghi -->\n\n```\n<!-- gen:zzz:ack -->\n```");
  expect(block.tasks!.abc!.status).toBe("pending");
  expect(block.tasks!.abc!.acked).toBe("t");
  expect(block.tasks!.def).toBeUndefined(); // no record is made up
  expect(block.meta).toEqual({ rev: 1, body_rev: 1, body_by: "server" });
});

test("resetAcks keeps a range's instruction", () => {
  const r = resetAcks(serializeFile(`<!-- sel:def:ack "shorter, &quot;please&quot;" -->Plan it<!-- /sel:def:ack -->`, emptyBlock()))!;
  expect(parseFile(r.file).markdown).toBe(`<!-- sel:def "shorter, &quot;please&quot;" -->Plan it<!-- /sel:def -->`);
});

test("resetAcks does nothing on a page without an ack", () => {
  expect(resetAcks(serializeFile("Text <!-- gen:abc -->", emptyBlock()))).toBeNull();
});
