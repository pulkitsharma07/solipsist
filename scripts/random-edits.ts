// Edits a page by hand, at random moments, like a second writer: appends "Random note:" paragraphs, adds words to
// them, changes a word, removes one. It only touches its own paragraphs, so the rest of the page and its comments stay.
//
//   bun scripts/random-edits.ts [file=docs/welcome.md] [minSeconds=1] [maxSeconds=5]
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseFile, serializeFile } from "../src/shared/docfile";

const [file = "docs/welcome.md", min = "1", max = "5"] = process.argv.slice(2);
const [lo, hi] = [Number(min), Number(max)];
const MARK = "Random note:";

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const subjects = ["The launch", "Finance", "The platform team", "Hiring", "The audit", "Our roadmap", "The review", "Support"];
const verbs = ["slipped to", "depends on", "was moved before", "now waits for", "no longer covers", "ships after", "was agreed with"];
const objects = ["the Q3 budget", "headcount approval", "the new pricing", "the security review", "a vendor contract", "the web rewrite", "next quarter"];
const extras = ["as discussed", "for now", "according to Sam", "pending sign-off", "which surprised everyone", "again", "in the end"];
const sentence = () => `${pick(subjects)} ${pick(verbs)} ${pick(objects)}`;

type Op = (paras: string[]) => string | null; // returns what it did, or null if it could not
const isMine = (p: string) => p.startsWith(MARK);
const mine = (paras: string[]) => paras.map((p, i) => [p, i] as const).filter(([p]) => isMine(p)).map(([, i]) => i);

const ops: Record<string, Op> = {
  add: (paras) => {
    const text = `${MARK} ${sentence()}.`;
    paras.push(text);
    return `added "${text}"`;
  },
  extend: (paras) => {
    const i = mine(paras);
    if (!i.length) return null;
    const at = pick(i);
    paras[at] = paras[at]!.replace(/\.$/, "") + `, ${pick(extras)}.`;
    return `extended paragraph ${at}`;
  },
  tweak: (paras) => {
    const i = mine(paras);
    if (!i.length) return null;
    const at = pick(i);
    const words = [...subjects, ...objects];
    const hit = words.find((w) => paras[at]!.includes(w));
    if (!hit) return null;
    paras[at] = paras[at]!.replace(hit, pick(words));
    return `changed "${hit}" in paragraph ${at}`;
  },
  remove: (paras) => {
    const i = mine(paras);
    if (i.length < 2) return null; // keep a few around
    const at = pick(i);
    const [gone] = paras.splice(at, 1);
    return `removed "${gone}"`;
  },
};

function tick() {
  const src = readFileSync(file, "utf8");
  const { markdown, block } = parseFile(src);
  const paras = markdown.split(/\n\n+/);
  // Mostly add and extend, so the page grows a little, then shrinks.
  const name = pick(["add", "add", "extend", "extend", "tweak", "remove"]);
  const did = ops[name]!(paras) ?? ops.add!(paras);
  const tmp = `${file}.tmp`; // written then renamed, so a reader never sees half a file
  writeFileSync(tmp, serializeFile(paras.join("\n\n"), block));
  renameSync(tmp, file);
  console.log(new Date().toLocaleTimeString(), did);
}

function loop() {
  const wait = (lo + Math.random() * (hi - lo)) * 1000;
  setTimeout(() => { try { tick(); } catch (e) { console.error(e); } loop(); }, wait);
}
console.log(`editing ${file} every ${lo}-${hi}s; Ctrl-C to stop`);
tick();
loop();
