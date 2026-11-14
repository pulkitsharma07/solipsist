// Property tests: random pages (`test/fuzz/gen.ts`) and random edit sequences on them, against invariants that must
// hold for any page. A failure prints its seed and a shrunk case; that case then becomes a named test elsewhere.
// `FUZZ_RUNS=10000 bun test test/fuzz.test.ts` runs longer.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docText, docToMarkdown, emptyBlock, markdownToDoc, parseFile, serializeFile, type CommentsBlock } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";
import { generatePage, pageMarkdown, rng, TRICKY_IDS, type Page } from "./fuzz/gen";

/** The page made of these lines, with the leaves still in them. */
const withLines = (page: Page, lines: string[]): Page => {
  const md = lines.join("\n");
  return { blocks: [md], leaves: page.leaves.filter((l) => new RegExp(`${l.token}(?!\\d)`).test(md)) };
};
import { runs, shrink } from "./fuzz/shrink";
import { generateOps, runOps, type Op } from "./fuzz/edits";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const once = (md: string) => docToMarkdown(markdownToDoc(md));
/** The page's text, as a reader sees it: leading spaces and trailing blank lines aside. */
const textOf = (md: string) => docText(markdownToDoc(md)).text.split("\n").map((l) => l.trimStart()).join("\n").replace(/\n+$/, "");
const htmlComments = (md: string) => (md.match(/<!--[\s\S]*?-->/g) ?? []).sort();

/** The first invariant a page breaks, or null. */
function pageProblem(md: string): string | null {
  const one = once(md);
  if (once(one) !== one) return `not stable after one save:\n${JSON.stringify(one)}\n${JSON.stringify(once(one))}`;
  if (textOf(one) !== textOf(md)) return `text changed by a save:\n${JSON.stringify(textOf(md))}\n${JSON.stringify(textOf(one))}`;
  if (JSON.stringify(htmlComments(one)) !== JSON.stringify(htmlComments(md))) return `HTML comments changed by a save:\n${htmlComments(md).join(" ")}\n${htmlComments(one).join(" ")}`;
  const block = yamlBlock(md);
  const src = serializeFile(one, block);
  const back = parseFile(src);
  if (back.markdown !== one) return `the body changed through the file:\n${JSON.stringify(one)}\n${JSON.stringify(back.markdown)}`;
  if (JSON.stringify(back.block) !== JSON.stringify(block)) return `the block changed through the file:\n${JSON.stringify(block)}\n${JSON.stringify(back.block)}`;
  if (serializeFile(back.markdown, back.block) !== src) return "the file is not byte for byte after a round trip";
  return null;
}

/** The kind of leaf the text block at `$pos` is: what the generator calls it. */
function leafKind(doc: ReturnType<typeof markdownToDoc>, pos: number): string {
  const $pos = doc.resolve(pos);
  const names = Array.from({ length: $pos.depth + 1 }, (_, d) => $pos.node(d).type.name);
  if (names.includes("codeBlock")) return "code";
  if (names.includes("tableCell") || names.includes("tableHeader")) return "cell";
  if (names.includes("listItem") || names.includes("taskItem")) return "item";
  if (names.includes("blockquote")) return "quote";
  if (names.includes("heading")) return "heading";
  return "paragraph";
}

/** Every leaf the generator wrote is read as what it was written as: no marker lost, no item read as text. */
function leafProblem(page: Page): string | null {
  const md = pageMarkdown(page);
  const doc = markdownToDoc(md);
  const found = new Map<string, string>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    for (const m of node.textContent.matchAll(/L\d+z/g)) found.set(m[0], leafKind(doc, pos + 1));
    return false;
  });
  for (const { token, kind } of page.leaves) {
    if (found.get(token) !== kind) return `${token} was written as a ${kind}, read as ${found.get(token) ?? "nothing"}`;
  }
  return null;
}

/** A comments block with a record for every marker on the page, and comments keyed by ids YAML could misread. */
function yamlBlock(md: string): CommentsBlock {
  const block = emptyBlock();
  const placeholders: NonNullable<CommentsBlock["tasks"]> = {};
  for (const m of md.matchAll(/<!-- (gen|sel):([a-z0-9]{3,6})(?::(ack|sug|done))?(?: "[^"]*")? -->/g)) {
    placeholders[m[2]!] = { type: m[1]!, created_by: "writer", created: "2026-10-25T10:00:00.000Z", status: m[3] === "ack" ? "ack" : m[3] === "sug" ? "suggested" : m[3] === "done" ? "accepted" : "pending" };
  }
  if (Object.keys(placeholders).length) block.tasks = placeholders;
  for (const id of TRICKY_IDS.slice(0, 3)) {
    block.comments[id] = {
      id, thinker: "challenger", title: `t ${id}`, status: "open", created: "2026-10-25T10:00:00.000Z", created_rev: 1,
      anchor: { exact: "plan", prefix: "", suffix: "", start: 0 },
    };
  }
  return block;
}

/** Runs `problem` on `runs` seeds; on a failure, shrinks the page's blocks and fails with the seed and the small case. */
function forEachPage(name: string, count: number, problem: (md: string) => string | null) {
  test(`${name} (${count} pages)`, () => {
    for (let seed = 1; seed <= count; seed++) {
      const page = generatePage(seed);
      const found = problem(pageMarkdown(page));
      if (!found) continue;
      // Whole blocks first, then single lines (a list item, a table row, a line of code).
      const blocks = shrink(page.blocks, (bs) => problem(pageMarkdown({ blocks: bs })) !== null);
      const md = shrink(pageMarkdown({ blocks }).split("\n"), (ls) => problem(ls.join("\n")) !== null).join("\n");
      throw new Error(`seed ${seed}: ${problem(md)}\n--- shrunk page ---\n${JSON.stringify(md)}`);
    }
  }, 5000 + count * 80);
}

describe("every generated page", () => {
  forEachPage("survives a save and the file round trip", runs(200), pageProblem);

  test(`is read as it was written: every leaf is the kind of block it was written as (${runs(200)} pages)`, () => {
    for (let seed = 1; seed <= runs(200); seed++) {
      const page = generatePage(seed);
      const first = leafProblem(page);
      if (!first) continue;
      // Shrink by lines (the leaves are the tokens still on the page), keeping the same failure: written as X, read
      // as Y. Dropping a parent line can make an indented item into code, which is a different story.
      const story = first.replace(/^L\d+z /, "");
      const fails = (ls: string[]) => leafProblem(withLines(page, ls))?.replace(/^L\d+z /, "") === story;
      const lines = shrink(pageMarkdown(page).split("\n"), fails);
      throw new Error(`seed ${seed}: ${leafProblem(withLines(page, lines))}\n--- shrunk page ---\n${JSON.stringify(lines.join("\n"))}`);
    }
  }, 5000 + runs(200) * 5);

  forEachPage("with comments placed by the job, a fresh tab shows the same highlights", runs(20), (md) => {
    const server = new Server(md);
    const r = rng(md.length);
    const text = docText(markdownToDoc(server.markdown)).text;
    // A leaf's token and the words after it: in the page once, and long enough for the job to place.
    const quotes = (text.match(/L\d+z [a-z]+ [a-z]+ [a-z]+/g) ?? []).filter(() => r.chance(0.5)).slice(0, 4);
    const want: Record<string, string> = {};
    for (const quote of quotes) {
      const { placed, dropped } = server.job(server.markdown, [{ quote }]);
      if (dropped.length) return `the job couldn't place ${JSON.stringify(quote)}: ${dropped[0]!.reason}`;
      want[placed[0]!] = quote;
    }
    for (const fresh of [new Tab(server.src), new Tab(server.src)]) {
      // (`highlighted` shows a hard break as a newline; the job's quote, like the page text, as a space.)
      const got = Object.fromEntries(Object.keys(want).map((id) => [id, fresh.highlighted(id)?.replaceAll("\n", " ")]));
      if (JSON.stringify(got) !== JSON.stringify(want)) return `highlights differ:\n${JSON.stringify(want)}\n${JSON.stringify(got)}`;
    }
    return null;
  });
});

describe("the YAML block", () => {
  test("ids YAML could read as numbers or booleans stay strings", () => {
    const block = yamlBlock(TRICKY_IDS.map((id) => `<!-- gen:${id} -->`).join(" "));
    const back = parseFile(serializeFile("Text.", block)).block;
    expect(Object.keys(back.tasks!).sort()).toEqual([...TRICKY_IDS].sort()); // (JS lists integer-like keys first)
    expect(Object.keys(back.comments)).toEqual(Object.keys(block.comments));
    for (const c of Object.values(back.comments)) expect(typeof c.id).toBe("string");
  });
});

describe("random edit sequences", () => {
  // The writer types, saves and receives late; hand edits, agent turns and job runs change the file meanwhile.
  test(`no text lost, no conflict, the file valid, the tab and the file agree (${runs(25)} runs)`, async () => {
    for (let seed = 1; seed <= runs(25); seed++) {
      const page = generatePage(seed, { maxBlocks: 6 });
      const ops = generateOps(seed, page);
      let ended = "";
      const first = await runOps(page, ops, (md) => { ended = md; });
      if (!first && seed % 5 === 0) {
        // The same run again ends with the same file: merging, placing and saving are deterministic.
        let again = "";
        await runOps(page, ops, (md) => { again = md; });
        expect({ seed, again }).toEqual({ seed, again: ended });
      }
      if (!first) continue;
      const story = first.replace(/^op \d+ \([^)]*\)|L\d+z|[WHAF]\d+[whaf]/g, "…").slice(0, 60);
      const small: Op[] = [];
      // Greedy, async: drop each op in turn while the same kind of failure remains.
      let cur = ops;
      for (let i = cur.length - 1; i >= 0; i--) {
        const next = [...cur.slice(0, i), ...cur.slice(i + 1)];
        const got = await runOps(page, next).catch((e) => String(e));
        if (got && got.replace(/^op \d+ \([^)]*\)|L\d+z|[WHAF]\d+[whaf]/g, "…").slice(0, 60) === story) cur = next;
      }
      small.push(...cur);
      throw new Error(`seed ${seed}: ${await runOps(page, small)}\n--- page ---\n${JSON.stringify(pageMarkdown(page))}\n--- ops ---\n${small.map((o) => JSON.stringify(o)).join("\n")}`);
    }
  }, 10_000 + runs(25) * 400);
});
