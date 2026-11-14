// Whole sessions at random, end to end in a fake DOM: the writer types, asks, accepts and rejects, leaves and comes
// back, turns the agents off and on, while the file changes from outside and the (scripted) agent answers at random
// speeds, sometimes failing, declining or answering instead. Then what must always hold is checked: the file is the
// editor, nothing the writer typed is lost or doubled, a decision lands once, no run is left hanging, nothing leaks.
//
// A failure names its seed: `DOM_FUZZ_SEEDS=<seed> bun test ./test/e2e-dom/fuzz.dom.tsx` plays it again, with each
// step printed (`DOM_FUZZ_LOG=1`). `DOM_FUZZ_RUNS=n` plays n more seeds, `DOM_FUZZ_STEPS` sets their length.
import "./platform"; // first: see platform.ts
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { TextSelection } from "@tiptap/pm/state";
import { writeFileSync } from "node:fs";
import { pageChanged } from "../../src/server/runtime";
import { join } from "node:path";
import { startApp, type App, type PageView } from "./app";

setDefaultTimeout(120_000);
let app: App;
beforeAll(async () => { app = await startApp({ AGENT_CONCURRENCY: "2", AGENT_MAX_FAILURES: "2" }); });
afterAll(() => app.close());

/** A small seeded generator (mulberry32), so a failing session plays again from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

const STEPS = Number(process.env.DOM_FUZZ_STEPS ?? 28);
const seeds = process.env.DOM_FUZZ_SEEDS
  ? process.env.DOM_FUZZ_SEEDS.split(",").map(Number)
  : [11, 23, 37, ...Array.from({ length: Number(process.env.DOM_FUZZ_RUNS ?? 0) }, (_, i) => 1000 + i)];
let steps: string[] = [];
const say = (...a: unknown[]) => { const line = a.join(" "); steps.push(line); if (process.env.DOM_FUZZ_LOG) console.log(line); };

for (const seed of seeds) {
  test(`a random session (seed ${seed})`, async () => {
    // The writer's steps and the agent's answers draw from their own sequences, so a replay takes the writer's path
    // again whatever order the runs end in.
    const r = rng(seed);
    const m = rng(seed * 7919 + 1);
    steps = [];
    const id = `f${seed}`;
    const paras = ["W0:", "W1:", "W2:"];
    app.write(id, `# Fuzz\n\n${paras.join("\n\n")}\n\nT: 0\n`);
    app.model.runs = [];
    // The agent: a random pause, then mostly a suggestion (a word no one else writes), sometimes something else.
    const proposals = new Map<string, string>(); // placeholder -> the proposal it was given
    app.model.script = async (run) => {
      await Bun.sleep(m.int(4) * 60);
      const roll = m.next();
      if (roll < 0.12) return { fail: "flaky model" };
      if (roll < 0.2) return { kind: "decline", note: "No." };
      if (roll < 0.27) return { kind: "answer", answer: "Because." };
      const word = ` a${run.n}.`;
      proposals.set(run.task, word);
      return { kind: "suggestion", mode: "at", place: "inline", suggestion: word };
    };
    let p: PageView = await app.open(id);
    const typed: string[] = [];
    let theirs = 0;
    let agentsOn = true;
    const accepted: string[] = [];
    const rejected: string[] = [];
    let k = 0;

    const toggleAgents = async () => {
      const b = p.button(agentsOn ? /background agent is running/ : /background agent is stopped/);
      if (!b) return;
      p.click(b);
      agentsOn = !agentsOn;
      await p.until(`agents ${agentsOn ? "on" : "off"}`, () => !!p.button(agentsOn ? /background agent is running/ : /background agent is stopped/));
    };
    /** The suggestions the page shows now, with what they propose. */
    const shown = () => {
      const out: { task: string; pos: number }[] = [];
      p.editor.state.doc.descendants((n, pos) => { if (n.type.name === "markerPoint" && n.attrs.state === "sug" && proposals.has(String(n.attrs.id))) out.push({ task: String(n.attrs.id), pos }); });
      return out.filter((s) => app.records(id)[s.task]?.status === "suggested" && !!app.records(id)[s.task]?.suggestion);
    };

    for (let step = 0; step < STEPS; step++) {
      const roll = r.next();
      if (roll < 0.34) {
        const word = `w${++k}`;
        const para = r.pick(paras);
        say(step, "type", word, "in", para);
        // At the end of the paragraph, wherever its words and asks are.
        const $start = p.editor.state.doc.resolve(findPara(p, para));
        p.editor.view.dispatch(p.editor.state.tr.setSelection(TextSelection.create(p.editor.state.doc, $start.end())));
        p.type(` ${word}`);
        typed.push(word);
      } else if (roll < 0.48) {
        const para = r.pick(paras);
        say(step, "ask in", para);
        const $start = p.editor.state.doc.resolve(findPara(p, para));
        p.editor.view.dispatch(p.editor.state.tr.setSelection(TextSelection.create(p.editor.state.doc, $start.end())));
        p.press("Mod-.");
      } else if (roll < 0.62) {
        const s = shown();
        if (!s.length) continue;
        const pick = r.pick(s);
        const yes = r.next() < 0.6;
        say(step, yes ? "accept" : "reject", pick.task, proposals.get(pick.task));
        // Just after its marker, where the app's own keys put the caret (`goToSuggestion`): just before it is also the
        // end of a marker right beside it, and the keys take that one.
        p.editor.view.dispatch(p.editor.state.tr.setSelection(TextSelection.create(p.editor.state.doc, pick.pos + 1)));
        p.press(yes ? "Mod-Alt-y" : "Mod-Alt-n");
        (yes ? accepted : rejected).push(proposals.get(pick.task)!.trim());
      } else if (roll < 0.76) {
        theirs++;
        say(step, "outside: T:", theirs);
        const src = app.file(id);
        const at = src.indexOf("<!-- solip-comments");
        const b = at < 0 ? src : src.slice(0, at);
        writeFileSync(join(app.docs, `${id}.md`), b.replace(/T: \d+/, `T: ${theirs}`) + (at < 0 ? "" : src.slice(at)));
        pageChanged(id);
      } else if (roll < 0.88) {
        const ms = r.int(5) * 50;
        say(step, "pause", ms);
        await Bun.sleep(ms);
      } else if (roll < 0.94) {
        say(step, "leave and come back");
        await p.close();
        await Bun.sleep(r.int(3) * 40);
        p = await app.open(id);
      } else {
        say(step, "agents", agentsOn ? "off" : "on");
        await toggleAgents();
      }
      await Bun.sleep(r.int(3) * 15);
    }

    // Settle: the agents on, every run over, the page saved and current.
    if (!agentsOn) await toggleAgents();
    // Saved first: a task has its record (and its run) only once the page that made it was saved.
    await p.saved();
    const done = () => {
      const recs = app.records(id);
      const inBody = [...app.body(id).matchAll(/<!-- gen:([a-z0-9]+)/g)].map((x) => x[1]!);
      return inBody.every((task) => recs[task] && recs[task].status !== "pending" && recs[task].status !== "ack") && app.model.runs.every((x) => x.ended);
    };
    await p.until("every run to finish", done, 30_000);
    await p.until("the page to show the last outside edit and every suggestion", () => p.text.includes(`T: ${theirs}`) && !p.markdown.match(/gen:[a-z0-9]+(:ack)? -->/), 8000);
    await p.saved();

    const body = app.body(id);
    const where = `seed ${seed}\nsteps:\n${steps.join("\n")}\nbody:\n${body}\nrecords: ${JSON.stringify(app.records(id))}`;
    // The file is the editor.
    expect(p.markdown.trimEnd(), where).toBe(body.trimEnd());
    // Nothing the writer typed is lost or doubled.
    for (const w of typed) expect(body.split(new RegExp(`\\b${w}\\b`)).length - 1, `${w} once\n${where}`).toBe(1);
    // Their last edit is there, once.
    expect(body.match(/T: \d+/g), where).toEqual([`T: ${theirs}`]);
    // A decision lands once; a rejected or undecided suggestion is not in the text.
    for (const a of accepted) expect(body.split(a).length - 1, `accepted ${a}\n${where}`).toBe(1);
    for (const x of rejected) expect(body.includes(x), `rejected ${x}\n${where}`).toBe(false);
    const decided = new Set([...accepted, ...rejected]);
    for (const [, word] of proposals) if (!decided.has(word.trim())) expect(body.includes(word.trim()), `undecided ${word}\n${where}`).toBe(false);
    // Every task in the text has a record, and none is left waiting or working.
    const records = app.records(id);
    for (const m of body.matchAll(/<!-- gen:([a-z0-9]+)(?::(\w+))? -->/g)) {
      expect(records[m[1]!], `record for ${m[1]}\n${where}`).toBeDefined();
      expect(m[2], `${m[1]} settled\n${where}`).toBe("sug");
    }
    // No conflict: their edits never touched the writer's lines.
    expect(p.banners, where).toEqual([]);
    await p.close();
    const { stopAllPages } = await import("../../src/server/agent/pageAgents");
    await stopAllPages("fuzz over");
    expect(app.model.open, `agents left open\n${where}`).toBe(0);
  });
}

/** Where paragraph `label` (its first words) starts, inside it. */
function findPara(p: PageView, label: string): number {
  let at = -1;
  p.editor.state.doc.forEach((n, pos) => { if (at < 0 && n.textContent.startsWith(label)) at = pos + 1; });
  if (at < 0) throw new Error(`no paragraph ${label}`);
  return at;
}
