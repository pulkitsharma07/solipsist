// A live check of the Reader against a real model, by hand. Not a test: `bun test` never reaches a provider.
//
//   bun scripts/review-smoke.ts                                   # the default model, the sample page
//   bun scripts/review-smoke.ts pi:openrouter/deepseek/deepseek-v4-flash
//   bun scripts/review-smoke.ts <model> path/to/page.md           # your own page
//
// It makes a scratch docs folder, puts the page in it, runs one reading, and prints what the reader asked, what was
// dropped and where, and what the page looked like before and after — the body must come out byte for byte the same.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/plugins";
import { emptyBlock, listComments, parseFile, serializeFile } from "../src/shared/docfile";

const SAMPLE = `# Why we are moving to Pi

Research shows the Pi harness has the same or better planning and research capabilities, so the switch costs us
nothing in quality.

We moved for stability. Our old harness shipped 244 releases this year, and more than three quarters of them changed
the system prompt or a tool description. Every one of those is a chance for the model to start ignoring our own
instructions.

The second reason is the token overhead. The default Bash tool description is nearly 3,000 tokens, almost all of it
advice about git and pull requests that the model already knows.

Most users will not notice any of this. Those of us who run the thing all day will.
`;

const [choice = "pi:openrouter/deepseek/deepseek-v4-flash", pagePath] = process.argv.slice(2);
const body = pagePath ? readFileSync(pagePath, "utf8") : SAMPLE;

const dir = mkdtempSync(join(tmpdir(), "solip-review-smoke-"));
const docs = join(dir, ".solipsist", "pages");
mkdirSync(docs, { recursive: true });
const id = "smoke";
const file = join(docs, `${id}.md`);
const before = serializeFile(body, emptyBlock());
writeFileSync(file, before);

process.env.SOLIPSIST_PROJECT_ROOT = dir;
process.env.SOLIPSIST_PREFERRED_MODELS = choice;
process.env.SOLIPSIST_LOG = "off";
process.env.SOLIPSIST_TUI = "0";

// Imported after the environment is set: the settings are read when the module is first used.
const { reviewPage } = await import("../src/server/review");
const { warmEngines } = await import("../src/server/agent/engines");

console.log(`model   ${choice}`);
console.log(`page    ${file}  (${body.length} chars)\n`);

await warmEngines();
const started = Date.now();
const r = await reviewPage(id);
const took = ((Date.now() - started) / 1000).toFixed(1);

if (r.error) console.log(`error   ${r.error}\n`);
console.log(`${took}s, cost ${r.costUsd === undefined ? "not reported" : `$${r.costUsd.toFixed(4)}`}\n`);

const after = readFileSync(file, "utf8");
for (const c of listComments(parseFile(after).block, "open")) {
  console.log(`— “${c.gloss}”  (score ${c.score ?? "?"})`);
  console.log(`  ${c.title}`);
  if (c.body) console.log(`  ${c.body}`);
  if (c.description) console.log(`  why: ${c.description}`);
  console.log(`  on: “${c.anchor.exact.slice(0, 90)}”\n`);
}

const dropped = r.judged.filter((j) => j.outcome !== "shown");
if (dropped.length) {
  console.log("dropped:");
  for (const j of dropped) console.log(`  ${j.outcome.padEnd(18)} “${j.gloss ?? j.quote.slice(0, 50)}”`);
  console.log();
}

const same = parseFile(after).markdown === parseFile(before).markdown;
console.log(`the body is ${same ? "byte for byte the same" : "DIFFERENT — the Reader must never write the page"}`);
console.log(`\nthe file: ${file}`);
if (!process.argv.includes("--keep")) { rmSync(dir, { recursive: true, force: true }); console.log("(scratch folder removed; --keep to look at it)"); }
process.exit(same ? 0 : 1);
