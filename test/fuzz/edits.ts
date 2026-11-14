// Random edit sequences for the property tests: the writer in a real `DocSession` (`test/browser-tab.ts`), hand edits,
// agent turns and job runs on the file (`test/sim.ts`), on a generated page. Ops are plain data, so a failing run can be
// replayed and shrunk by dropping ops.
import { docText, markdownToDoc, parseFile, markersIn } from "../../src/shared/docfile";
import { Server, Tab } from "../browser-tab";
import { pageMarkdown, rng, type Page } from "./gen";

export type Op =
  | { t: "type"; leaf: string; text: string } // the writer types right after a leaf's token
  | { t: "hand"; leaf: string; text: string } // a hand edit adds a word right after a leaf's token
  | { t: "append"; text: string } // a hand edit adds a paragraph at the end
  | { t: "ack"; pick: number } // the agent acks one pending placeholder
  | { t: "fill"; pick: number; text: string; followUp: boolean } // the agent finishes one, maybe adding a follow-up
  | { t: "job"; pick: number } // the job places a comment on a leaf
  | { t: "save" }
  | { t: "receive" } // the tab gets the latest file (SSE)
  | { t: "pause" };

/**
 * The ops of one run. Leaves alternate between the writer and the hand edits, so the two never touch the same
 * leaf: any conflict is a bug (the tree merge keeps different leaves apart, and a marker fill splices in).
 */
export function generateOps(seed: number, page: Page, count = 25): Op[] {
  const r = rng(seed * 7919 + 1);
  const writer = page.leaves.filter((_, i) => i % 2 === 0).map((l) => l.token);
  const hand = page.leaves.filter((_, i) => i % 2 === 1).map((l) => l.token);
  const ops: Op[] = [];
  let n = 0;
  for (let i = 0; i < count; i++) {
    const x = r.next();
    if (x < 0.25 && writer.length) ops.push({ t: "type", leaf: r.pick(writer), text: `W${n++}w` });
    else if (x < 0.38 && hand.length) ops.push({ t: "hand", leaf: r.pick(hand), text: `H${n++}h` });
    else if (x < 0.43) ops.push({ t: "append", text: `A${n++}a` });
    else if (x < 0.51) ops.push({ t: "ack", pick: r.int(1000) });
    else if (x < 0.6) ops.push({ t: "fill", pick: r.int(1000), text: `F${n++}f`, followUp: r.chance(0.3) });
    else if (x < 0.65) ops.push({ t: "job", pick: r.int(1000) });
    else if (x < 0.8) ops.push({ t: "save" });
    else if (x < 0.96) ops.push({ t: "receive" });
    else ops.push({ t: "pause" });
  }
  return ops;
}

const ORDER = { pending: 0, ack: 1, sug: 2, done: 3, btn: 4 } as const;
/** The markers on the page (not in code) and how far each is: a range's furthest comment counts. */
const taskStates = (md: string) => {
  const out = new Map<string, keyof typeof ORDER>();
  for (const p of markersIn(markdownToDoc(md))) {
    const s = p.state as keyof typeof ORDER;
    if (!out.has(p.id) || ORDER[s] > ORDER[out.get(p.id)!]) out.set(p.id, s);
  }
  return out;
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plays `ops` on `page`. Returns the first broken invariant, or null. `end` receives the file as it ends up. */
export async function runOps(page: Page, ops: Op[], end?: (src: string) => void): Promise<string | null> {
  const server = new Server(pageMarkdown(page));
  const tab = new Tab(server.src);
  await tab.save(server); // the file is canonical from here, as after a page's first load
  const typed: string[] = [];
  const added: string[] = []; // by hand and by the agent
  const seen = new Map<string, number>(); // the furthest state each placeholder reached in the file
  let followUps = 0;

  const check = (where: string): string | null => {
    const file = parseFile(server.src);
    if (file.problem) return `${where}: the file's block is unreadable`;
    if ((server.src.match(/<!-- solip-comments/g) ?? []).length !== 1) return `${where}: not exactly one comments block`;
    for (const [id, state] of taskStates(file.markdown)) {
      const was = seen.get(id) ?? 0;
      if (ORDER[state] < was) return `${where}: placeholder ${id} went back to ${state}`;
      seen.set(id, ORDER[state]);
    }
    if (tab.conflict) return `${where}: a conflict, though the two sides edited different leaves`;
    return null;
  };

  for (const [i, op] of ops.entries()) {
    const where = `op ${i} (${JSON.stringify(op)})`;
    switch (op.t) {
      case "type":
        tab.typeAfter(op.leaf, ` ${op.text}`);
        typed.push(op.text);
        break;
      case "hand":
        if (!server.markdown.includes(op.leaf)) break;
        server.handEdit((md) => md.replace(new RegExp(`${escapeRe(op.leaf)}(?!\\d)`), `${op.leaf} ${op.text}`));
        added.push(op.text);
        break;
      case "append":
        server.handEdit((md) => `${md}\n\n${op.text} by hand.`);
        added.push(op.text);
        break;
      case "ack": {
        const pending = [...taskStates(server.markdown)].filter(([, s]) => s === "pending");
        if (!pending.length) break;
        const [id] = pending[op.pick % pending.length]!;
        server.handEdit((md) => md.replace(new RegExp(`<!-- (/?[a-z]+):${id}( "[^"]*")? -->`, "g"), `<!-- $1:${id}:ack$2 -->`));
        break;
      }
      case "fill": {
        const open = [...taskStates(server.markdown)].filter(([, s]) => s !== "done" && s !== "sug" && s !== "btn");
        if (!open.length) break;
        const [id] = open[op.pick % open.length]!;
        const result = op.followUp ? `${op.text} <!-- gen:f${String(followUps++ % 100).padStart(2, "0")} -->` : op.text;
        server.handEdit((md) => md
          // a point: the marker becomes the result; a range: its comments go, and the result follows the text
          .replace(new RegExp(`<!-- [a-z]+:${id}(?::ack)? -->(?![\\s\\S]*<!-- /[a-z]+:${id})`), result)
          .replace(new RegExp(`<!-- [a-z]+:${id}(?::ack)?(?: "[^"]*")? -->([\\s\\S]*?)<!-- /[a-z]+:${id}(?::ack)? -->`), `$1 ${result}`));
        added.push(op.text);
        break;
      }
      case "job": {
        const quotes = docText(markdownToDoc(server.markdown)).text.match(/L\d+z [a-z]+ [a-z]+ [a-z]+/g) ?? [];
        if (quotes.length) server.job(server.markdown, [{ quote: quotes[op.pick % quotes.length]! }]);
        break;
      }
      case "save":
        await tab.save(server);
        break;
      case "receive":
        tab.receive(server.src);
        break;
      case "pause":
        tab.pause();
        break;
    }
    const problem = check(where);
    if (problem) return problem;
  }

  // Settle: the tab takes in the latest file and saves until there is nothing left to save.
  for (let k = 0; k < 4; k++) {
    tab.receive(server.src);
    const problem = check("settling");
    if (problem) return problem;
    await tab.save(server);
  }
  tab.receive(server.src);
  if (tab.markdown !== server.markdown) return `the tab and the file disagree after the last save:\n${JSON.stringify(tab.markdown)}\n${JSON.stringify(server.markdown)}`;
  const text = docText(markdownToDoc(server.markdown)).text;
  for (const t of [...typed, ...added]) if (!text.includes(t)) return `${t} is lost (${typed.includes(t) ? "typed by the writer" : "added outside"})`;
  end?.(server.markdown);
  return null;
}
