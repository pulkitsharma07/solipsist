// Who holds a block, and who may take it. A comment already on screen keeps its
// place unless a better question comes along and the writer has not read that card; and a comment the writer
// dismissed is taken down for good — nothing reopens it, and the Reader never raises that passage again.
import { describe, expect, test } from "bun:test";
import { placeComments, type Proposal } from "../src/server/place";
import { applyPut } from "../src/server/put";
import { emptyBlock, listComments, parseFile, serializeFile } from "../src/shared/docfile";

const BODY = `# Notes

The deadline is the end of Q3 for all teams.

Trust is impossible without a shared room.

Remote work is better for everyone.
`;

const start = () => serializeFile(BODY, emptyBlock());
const ask = (quote: string, gloss: string, score?: number): Proposal => ({ quote, title: `About ${gloss}?`, gloss, thinker: "reader", ...(score !== undefined && { score }) });
const Q3 = "The deadline is the end of Q3 for all teams.";
const TRUST = "Trust is impossible without a shared room.";
const REMOTE = "Remote work is better for everyone.";
const glosses = (src: string) => listComments(parseFile(src).block, "open").map((c) => c.gloss).sort();

describe("the cap", () => {
  test("holds the page to min_kept when nothing may be displaced", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 5)], new Date(), { minKept: 1, perBlock: 0 });
    expect(first.placed).toHaveLength(1);

    // Full, and the new question is worth less: it is turned away and says why.
    const weaker = placeComments(BODY, first.file, [ask(TRUST, "trust", 2)], new Date(), { minKept: 1, perBlock: 0 });
    expect(weaker.placed).toHaveLength(0);
    expect(weaker.dropped.map((d) => d.reason)).toEqual(["cap-full"]);
    expect(glosses(first.file)).toEqual(["q3"]);
  });

  test("a better question takes the slot of one the writer hasn't read", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 4)], new Date(), { minKept: 1, perBlock: 0 });
    const better = placeComments(BODY, first.file, [ask(TRUST, "trust", 9)], new Date(), { minKept: 1, perBlock: 0 });

    expect(better.placed).toHaveLength(1);
    expect(better.replaced).toHaveLength(1);
    expect(glosses(better.file)).toEqual(["trust"]);
  });

  test("a card the writer has opened is never taken away from them", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 4)], new Date(), { minKept: 1, perBlock: 0 });
    const id = first.placed[0]!;
    const { block } = parseFile(first.file);
    const read = serializeFile(parseFile(first.file).markdown, {
      ...block,
      comments: { ...block.comments, [id]: { ...block.comments[id]!, opened_at: new Date().toISOString() } },
    });

    const better = placeComments(BODY, read, [ask(TRUST, "trust", 9)], new Date(), { minKept: 1, perBlock: 0 });
    expect(better.placed).toHaveLength(0);
    expect(better.replaced).toEqual([]);
    expect(better.dropped.map((d) => d.reason)).toEqual(["cap-full"]);
    expect(glosses(read)).toEqual(["q3"]);
  });

  test("a proposal with no score of its own displaces nothing", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 1)], new Date(), { minKept: 1, perBlock: 0 });
    // The mock generator and the dev route send no score: they only ever add.
    const unscored = placeComments(BODY, first.file, [ask(TRUST, "trust")], new Date(), { minKept: 1, perBlock: 0 });

    expect(unscored.placed).toHaveLength(0);
    expect(unscored.replaced).toEqual([]);
  });
});

describe("the same passage", () => {
  test("one comment per passage: a better question replaces the one there", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 3)], new Date(), { minKept: 4, perBlock: 0 });
    const better = placeComments(BODY, first.file, [ask(Q3, "q3 again", 8)], new Date(), { minKept: 4, perBlock: 0 });

    expect(better.replaced).toHaveLength(1);
    expect(glosses(better.file)).toEqual(["q3 again"]);
  });

  test("a weaker question on a taken passage is refused, and the other slots stay free", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 8)], new Date(), { minKept: 4, perBlock: 0 });
    const r = placeComments(BODY, first.file, [ask(Q3, "q3 again", 2), ask(TRUST, "trust", 2)], new Date(), { minKept: 4, perBlock: 0 });

    expect(r.dropped.map((d) => d.reason)).toEqual(["overlaps"]);
    expect(glosses(r.file)).toEqual(["q3", "trust"]);
  });
});

describe("dismissing", () => {
  const put = (src: string, comments: Parameters<typeof applyPut>[1]["comments"]) =>
    applyPut(src, { client_id: "t1", base_rev: parseFile(src).block.meta.rev, markdown: parseFile(src).markdown, comments });

  test("a tab may take a comment down, and the Reader never raises that passage again", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 5)], new Date(), { minKept: 4, perBlock: 0 });
    const id = first.placed[0]!;

    const saved = put(first.file, { [id]: { status: "dismissed" } });
    expect(saved.ok).toBe(true);
    const after = (saved as { file: string }).file;
    expect(listComments(parseFile(after).block, "open")).toHaveLength(0);
    expect(listComments(parseFile(after).block, "dismissed")).toHaveLength(1);

    const again = placeComments(BODY, after, [ask(Q3, "q3 again", 9)], new Date(), { minKept: 4, perBlock: 0 });
    expect(again.placed).toHaveLength(0);
    expect(again.dropped.map((d) => d.reason)).toEqual(["already-raised"]);
  });

  test("a dismissed comment can't be reopened or orphaned by a tab", () => {
    const first = placeComments(BODY, start(), [ask(Q3, "q3", 5)], new Date(), { minKept: 4, perBlock: 0 });
    const id = first.placed[0]!;
    const down = (put(first.file, { [id]: { status: "dismissed" } }) as { file: string }).file;
    const anchor = parseFile(first.file).block.comments[id]!.anchor;

    const reopen = put(down, { [id]: { status: "open", anchor } });
    expect(listComments(parseFile((reopen as { file: string }).file).block, "open")).toHaveLength(0);

    const orphan = put(down, { [id]: { status: "orphaned" } });
    expect(listComments(parseFile((orphan as { file: string }).file).block, "dismissed")).toHaveLength(1);
  });

  test("opening a card is recorded once, and is what protects it", () => {
    const first = placeComments(BODY, start(), [ask(REMOTE, "remote", 4)], new Date(), { minKept: 1, perBlock: 0 });
    const id = first.placed[0]!;
    const anchor = parseFile(first.file).block.comments[id]!.anchor;

    const opened = (put(first.file, { [id]: { status: "open", anchor, opened: true } }) as { file: string }).file;
    const at = parseFile(opened).block.comments[id]!.opened_at;
    expect(at).toBeString();

    // Saved again, still open: the first time the writer read it is the one that counts.
    const later = (put(opened, { [id]: { status: "open", anchor, opened: true } }) as { file: string }).file;
    expect(parseFile(later).block.comments[id]!.opened_at).toBe(at);

    const better = placeComments(BODY, later, [ask(TRUST, "trust", 9)], new Date(), { minKept: 1, perBlock: 0 });
    expect(better.placed).toHaveLength(0);
  });
});
