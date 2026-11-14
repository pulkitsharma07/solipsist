// Random pages from a small grammar, for the property tests (`test/fuzz.test.ts`). Seeded: a seed always gives the
// same page. Every leaf (a paragraph, heading, list item's paragraph, table cell, code block) starts with its own token
// `L<n>z`, so the edit runner can find it both in the editor and in the markdown.

import { escapeInstruction } from "../../src/shared/docfile";

/** A small deterministic random number generator (mulberry32). */
export function rng(seed: number) {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(xs: readonly T[]) => xs[int(xs.length)]!, chance: (p: number) => next() < p };
}
export type Rand = ReturnType<typeof rng>;

/** Marker ids YAML could read as numbers, booleans or null if they weren't quoted. */
export const TRICKY_IDS = ["012", "1e5", "0x1", "nan", "inf", "yes", "off", "nul", "123", "7e0"] as const;

export interface Page {
  /** The top-level blocks, as markdown; the page is them joined by blank lines. */
  blocks: string[];
  /** Leaf tokens, in page order, with what kind of leaf each is. */
  leaves: { token: string; kind: "paragraph" | "heading" | "item" | "cell" | "code" | "quote" }[];
}
export const pageMarkdown = (p: Pick<Page, "blocks">) => p.blocks.join("\n\n");

const WORDS = ["plan", "launch", "budget", "review", "team", "date", "risk", "owner", "draft", "note", "scope", "vendor"];

export function generatePage(seed: number, opts: { maxBlocks?: number } = {}): Page {
  const r = rng(seed);
  const leaves: Page["leaves"] = [];
  const ids = new Set<string>();
  let n = 0;
  const leaf = (kind: Page["leaves"][number]["kind"]) => { const token = `L${n++}z`; leaves.push({ token, kind }); return token; };
  const id = () => {
    for (;;) {
      const x = r.chance(0.3) ? r.pick(TRICKY_IDS) : Array.from({ length: 3 }, () => r.pick([..."abcdefghijklmnopqrstuvwxyz0123456789"])).join("");
      // `abc` is the id the markers in code use; the edit runner finds markers by id, so it stays theirs.
      if (!ids.has(x) && x !== "abc") { ids.add(x); return x; }
    }
  };
  const words = (k = 1 + r.int(4)) => Array.from({ length: k }, () => r.pick(WORDS)).join(" ");
  const state = () => r.pick(["", "", ":ack", ":sug", ":done", ":btn"]);
  /** None, or a quoted instruction, escaped as the file holds it, with characters that must not end the comment or read as markdown. */
  const instruction = () => (r.chance(0.5) ? "" : ` "${escapeInstruction(r.pick([words(), `${words()} "quoted" & <b>`, `*${words(1)}* \`x\` [a](b) --> -- ---`, `é ✓ ${words(1)}\\`]))}"`);

  /** A run of inline content: words, marks, code, links, images, comments, markers. `table`: no hard breaks. */
  const inline = (where: "block" | "table" = "block"): string => {
    const parts: string[] = [words()];
    for (let k = r.int(4); k > 0; k--) {
      const w = words(1 + r.int(2));
      parts.push(r.pick([
        () => `**${w}**`,
        () => `*${w}*`,
        () => `\`${w}\``,
        () => `[${w}](https://example.com/${r.pick(WORDS)})`,
        () => `![${w}](/img/${r.pick(WORDS)}.png)`,
        () => `<!-- ${w} -->`,
        () => `<!-- gen:${id()}${state()} -->`,
        () => { const i = id(), s = state(); return `<!-- sel:${i}${s}${instruction()} -->${w}<!-- /sel:${i}${s} -->`; },
        () => (where === "table" ? `a \\| ${w}` : `${w}  \n${words(1)}`),
        () => w,
      ])());
    }
    return parts.join(" ");
  };
  /** Text that would start a block if it weren't escaped. */
  const markdownLooking = () => r.pick(["\\# not a heading", "1\\. not a list", "\\- not a list", "\\> not a quote", "\\+ not a list", "\\* not a list"]);
  const paragraph = () => `${leaf("paragraph")} ${r.chance(0.15) ? markdownLooking() : inline()}`;

  const list = (depth: number): string => {
    const kind = r.pick(["bullet", "ordered", "task"] as const);
    const start = 1 + r.int(9);
    const items: string[] = [];
    const count = 1 + r.int(3);
    for (let i = 0; i < count; i++) {
      const marker = kind === "bullet" ? "- " : kind === "task" ? `- [${r.chance(0.5) ? "x" : " "}] ` : `${start + i}. `;
      // A task's checkbox is part of its content: its children sit under the text after `- `, not after `[x] `.
      const pad = " ".repeat(kind === "task" ? 2 : marker.length);
      let item = `${marker}${leaf("item")} ${inline()}`;
      if (depth < 2 && r.chance(0.25)) item += `\n${list(depth + 1).split("\n").map((l) => (l ? pad + l : l)).join("\n")}`;
      items.push(item);
    }
    return items.join("\n");
  };
  const table = () => {
    const cols = 1 + r.int(3);
    const cell = () => (r.chance(0.15) ? "" : `${leaf("cell")} ${inline("table")}`);
    const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const head = row(Array.from({ length: cols }, () => `${leaf("cell")} ${words(1)}`));
    const rows = Array.from({ length: 1 + r.int(3) }, () => row(Array.from({ length: cols }, cell)));
    return [head, row(Array.from({ length: cols }, () => "---")), ...rows].join("\n");
  };
  const code = () => {
    const lines = [`${leaf("code")} ${words()}`];
    for (let k = r.int(3); k > 0; k--) lines.push(r.pick([words(), "```inside", "<!-- in code -->", "<!-- gen:abc -->", "# not a heading", "| a | b |", ""]));
    const fence = lines.some((l) => l.startsWith("```")) ? "````" : "```";
    return `${fence}${r.pick(["", "js", "md"])}\n${lines.join("\n").replace(/\n+$/, "")}\n${fence}`;
  };
  const quote = () => {
    const inner = [`${leaf("quote")} ${inline()}`];
    if (r.chance(0.3)) inner.push(`- ${leaf("item")} ${words()}`);
    return inner.map((b) => b.split("\n").map((l) => `> ${l}`).join("\n")).join("\n>\n");
  };

  const blocks: string[] = [];
  const count = 1 + r.int(opts.maxBlocks ?? 8);
  let lastWasList = false;
  for (let i = 0; i < count; i++) {
    const kind = r.pick(["paragraph", "paragraph", "heading", "list", "table", "code", "quote", "comment", "hr"] as const);
    // Two lists in a row may merge into one: a known gap, so the generator keeps them apart.
    if (kind === "list" && lastWasList) { blocks.push(paragraph()); lastWasList = false; continue; }
    lastWasList = kind === "list";
    if (kind === "paragraph") blocks.push(paragraph());
    else if (kind === "heading") blocks.push(`${"#".repeat(1 + r.int(6))} ${leaf("heading")} ${words()}`);
    else if (kind === "list") blocks.push(list(0));
    else if (kind === "table") blocks.push(table());
    else if (kind === "code") blocks.push(code());
    else if (kind === "quote") blocks.push(quote());
    else if (kind === "comment") blocks.push(r.chance(0.5) ? `<!-- ${words()} -->` : `<!--\n${words()}\n${words()}\n-->`);
    else blocks.push("---");
  }
  return { blocks, leaves };
}
