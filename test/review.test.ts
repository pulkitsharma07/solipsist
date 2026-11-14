// The Reader: a review raises questions, places them in the margin and never touches the
// body. An in-memory engine stands in for a real one, so these hold for any engine and no test reaches a model.
// Covered: the body is byte for byte the same; the tools a review is given (no `suggest`); the in-turn check on a
// quote, a gloss that runs long, too many questions; the outcome every candidate ends with; and a review that is
// placed against the latest file after the writer kept typing.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { projectDir } from "./project-dir";
import { join } from "node:path";
import "../src/plugins";
import { resetRuntime } from "../src/server/runtime";
import { reviewPage } from "../src/server/review";
import { setEngines } from "../src/server/agent/engines";
import { callReplyTool, REVIEW_TOOLS } from "../src/server/agent/replyTools";
import type { AgentEngine, AgentSession, RunOptions, RunResult, StartOptions } from "../src/server/agent/engine";
import type { AnyReply } from "../src/server/suggest";
import { parseFile, serializeFile, emptyBlock, listComments } from "../src/shared/docfile";

const P = projectDir("solip-review-");
const docs = P.docs;
afterAll(() => P.done());
const file = (id: string) => join(docs, `${id}.md`);

const ENV = ["SOLIPSIST_REVIEW", "SOLIPSIST_REVIEW_MAX", "SOLIPSIST_REVIEW_GLOSS_WORDS", "SOLIPSIST_REVIEW_MIN_KEPT", "SOLIPSIST_REVIEW_MIN_SCORE", "SOLIPSIST_PREFERRED_MODELS"];
let saved: Record<string, string | undefined> = {};
let oldEngines: AgentEngine[] | null | undefined;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  P.enter();
  process.env.SOLIPSIST_PREFERRED_MODELS = "fake:m";
});
afterEach(() => {
  resetRuntime();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  if (oldEngines !== undefined) setEngines(oldEngines);
  oldEngines = undefined;
});

const PAGE = `# Remote work

Remote work is better for everyone, and the reason is obvious.

Trust is impossible without a shared room.
`;

/** A page on disk, body plus an empty block, as the app writes it. */
function page(id: string, body = PAGE): string {
  const src = serializeFile(body, emptyBlock());
  writeFileSync(file(id), src);
  return src;
}

type Comment = { quote: string; title: string; gloss: string; body?: string; description?: string; score?: number };

/**
 * An engine whose one agent calls `comment` with what `answers` gives it, through the real tool and the run's real
 * check — so a call this reading would refuse comes back as an error the agent sees, exactly as in a real run.
 * `attempts` records every call it made.
 */
function fakeReader(answers: (attempt: number) => Comment[]) {
  const log = { starts: [] as StartOptions[], prompts: [] as string[], errors: [] as string[], open: 0, attempts: 0 };
  const tool = REVIEW_TOOLS.find((t) => t.name === "comment")!;
  const engine: AgentEngine = {
    name: "fake", title: "Fake", models: () => [{ id: "m", title: "M" }], unavailable: () => null, replyTools: true,
    async start(opts): Promise<AgentSession> {
      log.starts.push(opts);
      log.open++;
      return {
        died: new Promise<string>(() => {}),
        async run(prompt: string, runOpts?: RunOptions): Promise<RunResult> {
          log.prompts.push(prompt);
          // Up to three tries, the way an agent fixes a refused call in the same turn.
          for (let i = 0; i < 3; i++) {
            const comments = answers(++log.attempts);
            const r = callReplyTool(tool, { comments }, runOpts?.check as ((r: AnyReply) => string | null) | undefined);
            if ("reply" in r) return { ok: true, result: "", reply: r.reply, costUsd: 0 };
            log.errors.push(r.error);
          }
          return { ok: true, result: "gave up", costUsd: 0 };
        },
        async close() { log.open--; },
      };
    },
  };
  const before = setEngines([engine]);
  if (oldEngines === undefined) oldEngines = before;
  return log;
}

const good: Comment = {
  quote: "Remote work is better for everyone, and the reason is obvious.",
  title: "What makes this obvious, and to whom?",
  gloss: "obvious to whom?",
  body: "The claim carries the argument and names no reason.",
  description: "You have framed this as self-evident, so a reader looks for the reason and finds none.",
  score: 8,
};

describe("a review", () => {
  test("places its questions in the margin and leaves the body byte for byte", async () => {
    const before = page("a");
    const log = fakeReader(() => [good]);
    const r = await reviewPage("a");

    expect(r.error).toBeUndefined();
    expect(r.placed).toHaveLength(1);
    const after = readFileSync(file("a"), "utf8");
    expect(parseFile(after).markdown).toBe(parseFile(before).markdown);

    const [c] = listComments(parseFile(after).block, "open");
    expect(c!.title).toBe(good.title);
    expect(c!.gloss).toBe(good.gloss);
    expect(c!.description).toBe(good.description);
    expect(c!.score).toBe(8);
    expect(c!.anchor.exact).toBe(good.quote);
    expect(c!.thinker).toBe("reviewer");
    expect(log.open).toBe(0); // every agent a review starts is closed
  });

  test("gets the comment tool and no way to write the page", async () => {
    page("b");
    const log = fakeReader(() => [good]);
    await reviewPage("b");

    const tools = log.starts[0]!.replyTools;
    expect(Array.isArray(tools)).toBe(true);
    const names = (tools as readonly { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["comment"]);
    expect(names).not.toContain("suggest");
  });

  test("tells the agent what it has already asked, so it isn't raised twice", async () => {
    page("c");
    fakeReader(() => [good]);
    await reviewPage("c");
    const log = fakeReader(() => [good]);
    const again = await reviewPage("c");

    expect(log.prompts[0]).toContain("already asked");
    expect(log.prompts[0]).toContain("obvious to whom?");
    // The same quote, already carrying a comment: refused rather than doubled up.
    expect(again.placed).toHaveLength(0);
    expect(again.judged.map((j) => j.outcome)).toContain("overlaps");
  });
});

describe("the check while the run is going", () => {
  test("a quote that isn't in the page comes back for fixing, in the same turn", async () => {
    page("d");
    const log = fakeReader((n) => [n === 1 ? { ...good, quote: "Remote work is better for everybody" } : good]);
    const r = await reviewPage("d");

    expect(log.errors[0]).toContain("not in the page word for word");
    expect(log.attempts).toBe(2);
    expect(r.placed).toHaveLength(1); // the second call stood
  });

  test("a runaway number of questions is refused, a few over the cap is trimmed instead", async () => {
    page("e");
    process.env.SOLIPSIST_REVIEW_MAX = "1";
    const many = Array.from({ length: 11 }, (_, i) => ({ ...good, gloss: `note ${i}` }));
    const log = fakeReader((n) => (n === 1 ? many : [good]));
    const r = await reviewPage("e");

    expect(log.errors[0]).toContain("raise at most 1");
    expect(r.placed).toHaveLength(1);
  });

  test("a review that never calls comment says so and writes nothing", async () => {
    const before = page("f");
    fakeReader(() => [{ ...good, quote: "nowhere in the page" }]);
    const r = await reviewPage("f");

    expect(r.placed).toHaveLength(0);
    expect(r.error).toContain("without calling");
    expect(readFileSync(file("f"), "utf8")).toBe(before);
  });
});

describe("the free stages", () => {
  test("a margin note that runs long is dropped before it is scored", async () => {
    page("g");
    process.env.SOLIPSIST_REVIEW_GLOSS_WORDS = "4";
    fakeReader(() => [{ ...good, gloss: "this note is far too long to be a pencil note" }]);
    const r = await reviewPage("g");

    expect(r.placed).toHaveLength(0);
    expect(r.judged.map((j) => j.outcome)).toEqual(["too-long"]);
  });

  test("below the threshold is dropped, and says so", async () => {
    page("h");
    process.env.SOLIPSIST_REVIEW_MIN_SCORE = "7";
    fakeReader(() => [{ ...good, score: 3 }]);
    const r = await reviewPage("h");

    expect(r.placed).toHaveLength(0);
    expect(r.judged.map((j) => j.outcome)).toEqual(["under-threshold"]);
  });

  test("the best come first and the rest are no-room", async () => {
    page("i");
    process.env.SOLIPSIST_REVIEW_MAX = "1";
    const weak = { ...good, quote: "Trust is impossible without a shared room.", gloss: "why impossible?", score: 2 };
    // Given in the weaker order on purpose: the better question is the one that gets the slot.
    fakeReader(() => [weak, good]);
    const r = await reviewPage("i");

    expect(r.placed).toHaveLength(1);
    const [c] = listComments(parseFile(readFileSync(file("i"), "utf8")).block, "open");
    expect(c!.gloss).toBe(good.gloss);
    expect(r.judged.find((j) => j.outcome === "no-room")?.gloss).toBe(weak.gloss);
  });

  test("every candidate ends with exactly one outcome", async () => {
    page("j");
    process.env.SOLIPSIST_REVIEW_GLOSS_WORDS = "4";
    const long = { ...good, quote: "Trust is impossible without a shared room.", gloss: "a gloss that is much too long" };
    fakeReader(() => [good, long]);
    const r = await reviewPage("j");

    expect(r.judged).toHaveLength(2);
    expect(r.judged.map((j) => j.outcome).sort()).toEqual(["shown", "too-long"]);
  });
});

describe("the page moved on while the agent read it", () => {
  test("a question whose passage went while the run was in flight is dropped, not misplaced", async () => {
    page("k");
    // The quote is in the page the agent read, so the in-turn check passes; the writer deletes that sentence before
    // the reply is placed. Placement anchors against the latest file, so there is nowhere to put it.
    const log = fakeReader(() => {
      const block = parseFile(readFileSync(file("k"), "utf8")).block;
      writeFileSync(file("k"), serializeFile("# Remote work\n\nSomething else entirely.\n", block));
      return [good];
    });
    const r = await reviewPage("k");

    expect(log.errors).toEqual([]); // the quote was fine when the agent made the call
    expect(r.placed).toHaveLength(0);
    expect(r.judged.map((j) => j.outcome)).toEqual(["gone"]);
    // Nothing of the writer's own text was touched on the way.
    expect(parseFile(readFileSync(file("k"), "utf8")).markdown).toBe("# Remote work\n\nSomething else entirely.");
  });

  test("a question still placed after an unrelated edit", async () => {
    page("m");
    const log = fakeReader(() => {
      const { block } = parseFile(readFileSync(file("m"), "utf8"));
      writeFileSync(file("m"), serializeFile(`${PAGE}\nA new paragraph the writer just typed.\n`, block));
      return [good];
    });
    const r = await reviewPage("m");

    expect(log.errors).toEqual([]);
    expect(r.placed).toHaveLength(1);
    const [c] = listComments(parseFile(readFileSync(file("m"), "utf8")).block, "open");
    expect(c!.anchor.exact).toBe(good.quote);
  });
});

describe("off", () => {
  test("no reading happens, and nothing is started", async () => {
    const before = page("l");
    process.env.SOLIPSIST_REVIEW = "0";
    const log = fakeReader(() => [good]);
    const r = await reviewPage("l");

    expect(r.error).toContain("off");
    expect(log.starts).toHaveLength(0);
    expect(readFileSync(file("l"), "utf8")).toBe(before);
  });
});
