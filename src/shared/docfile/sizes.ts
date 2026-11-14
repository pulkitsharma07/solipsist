import { BLOCK_NAME } from "./file";

/** Where a file's bytes go: the body, the hidden block, and the block's biggest parts. */
export interface BlockSizes {
  total: number;
  body: number;
  /** The whole `<!-- solip-comments … -->` block (the blank line before it counts in the body). */
  hidden: number;
  /** The `comments` section. */
  comments: number;
  /** The `tasks` section (every record). */
  records: number;
  /** The `suggestion` and `edits` fields of the records: the agent's suggested text (inside `records`). */
  proposals: number;
  /** `block.agent.chat` and `block.agent.solo`: the recorded conversations' references. */
  chat: number;
  solo: number;
}

const bytes = (s: string) => Buffer.byteLength(s);
const OPEN = `<!-- ${BLOCK_NAME}\n`;

/**
 * Where a file's bytes go, read off its text by lines (the block is written by `encodeBlock`, so a section starts at a
 * line of its key at column 0 and a record's fields at four spaces): nothing is parsed again. The parts of an old or
 * hand-written block that isn't laid out that way read 0, but `total`, `body` and `hidden` always add up.
 */
export function blockSizes(src: string): BlockSizes {
  const total = bytes(src);
  const at = src.lastIndexOf(`\n${OPEN}`);
  const start = at === -1 ? (src.startsWith(OPEN) ? 0 : -1) : at + 1;
  const out: BlockSizes = { total, body: total, hidden: 0, comments: 0, records: 0, proposals: 0, chat: 0, solo: 0 };
  if (start === -1) return out;
  out.body = bytes(src.slice(0, start));
  out.hidden = total - out.body;
  let section = "";
  let field = "";
  for (const line of src.slice(start).split("\n")) {
    const n = bytes(line) + 1;
    const top = line.match(/^"([^"]*)":/);
    if (top) { section = top[1]!; field = ""; }
    if (section === "comments") out.comments += n;
    else if (section === "tasks") {
      out.records += n;
      const f = line.match(/^ {4}"([^"]*)":/);
      if (f) field = f[1]!;
      if (field === "suggestion" || field === "edits") out.proposals += n;
    } else if (section === "agent") {
      const f = line.match(/^ {2}"([^"]*)":/);
      if (f) field = f[1]!;
      if (field === "chat") out.chat += n;
      else if (field === "solo") out.solo += n;
    }
  }
  return out;
}
