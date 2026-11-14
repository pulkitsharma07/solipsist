import { parseIndentedBlocks, type MarkdownLexerConfiguration, type MarkdownToken } from "@tiptap/core";

/**
 * Task lists, read the way markdown reads any list item. Stock Tiptap takes only an item's first line as its text and
 * parses the lines after it as blocks of their own, so a task whose text wraps (`- [ ] a **b` / `  c**`) split into two
 * paragraphs, lost the bold, and was saved with the `**` escaped. Here the text lines that follow an item's first
 * line (indented, or lazy: not indented, not starting a block) are part of its paragraph, as for `- a`.
 */
const ITEM_RE = /^(\s*)([-+*])\s+\[([ xX])\]\s+(.*)$/;
/** A line that starts a block, so it can't continue the item's text. */
const BLOCK_START_RE = /^\s*(?:[-+*]\s|\d{1,9}[.)](?:\s|$)|#{1,6}(?:\s|$)|>|```|~~~|\||<!--|(?:[-*_]\s*){3,}$)/;
/** Stands for a line break inside an item's first line, while the lines of its text are joined into it. */
const JOIN = "\uE00A";

/**
 * Lines rearranged so `parseIndentedBlocks` reads them as markdown does. It takes an item's first line as its text,
 * every line indented deeper than the item as the item's blocks, and cuts a fixed two columns off those:
 * - the lines the item's text wraps onto (indented or lazy, not starting a block) are joined onto its first line, so
 *   they are its text, and what follows them is read as blocks (a list after them, as after a bullet item's text);
 * - a line indented by less than the item's text (` - b` under `- [x] t`) is not the item's, and losing two columns cut
 *   off its `-`: it is moved out to the item's own column, which ends the item, as for any list.
 * `spans[i]`: how many source lines output line i stands for.
 */
function normaliseLines(lines: string[]): { lines: string[]; spans: number[] } {
  const out: string[] = [];
  const spans: number[] = [];
  const items: number[] = []; // the indents of the items the line may be inside, innermost last
  let inText = false; // the line before is an item's text, which the next line may continue
  for (const line of lines) {
    const item = line.match(ITEM_RE);
    const indent = line.length - line.trimStart().length;
    if (item) {
      while (items.length && items[items.length - 1]! >= indent) items.pop();
      items.push(indent);
      out.push(line);
      spans.push(1);
      inText = true;
      continue;
    }
    if (inText && line.trim() && !BLOCK_START_RE.test(line)) {
      out[out.length - 1] += JOIN + line.trimStart();
      spans[spans.length - 1]!++;
      continue;
    }
    inText = false;
    spans.push(1);
    if (!line.trim()) { out.push(line); continue; }
    while (items.length && items[items.length - 1]! >= indent) items.pop();
    const inside = items[items.length - 1];
    if (inside !== undefined && indent < inside + 2) {
      items.pop();
      out.push(" ".repeat(inside) + line.trimStart());
      continue;
    }
    out.push(line);
  }
  return { lines: out, spans };
}

function parseItems(src: string, lexer: MarkdownLexerConfiguration) {
  const lines = src.split("\n");
  const norm = normaliseLines(lines);
  const result = parseIndentedBlocks(norm.lines.join("\n"), {
    itemPattern: ITEM_RE,
    extractItemData: (m) => ({ indentLevel: m[1]!.length, mainContent: m[4]!.replaceAll(JOIN, "\n"), checked: m[3]!.toLowerCase() === "x" }),
    createToken: (data, nested) => ({
      type: "taskItem", raw: "", mainContent: data.mainContent, indentLevel: data.indentLevel, checked: data.checked, text: data.mainContent,
      tokens: lexer.inlineTokens(data.mainContent),
      // Inside a list item the lexer gives a paragraph as a block-level `text` token, whose text isn't parsed inline.
      nestedTokens: nested?.map((t) => (t.type === "text" ? { ...t, type: "paragraph", tokens: lexer.inlineTokens(t.text ?? "") } : t)),
    }),
    customNestedParser: (content) => {
      const nested = parseItems(content, lexer);
      if (!nested) return lexer.blockTokens(content);
      const remainder = content.slice(nested.raw.length);
      return remainder.trim() ? [nested.token, ...lexer.blockTokens(remainder)] : [nested.token];
    },
  }, lexer);
  if (!result) return undefined;
  // The raw text is the source lines the items took, not the rearranged ones: the lexer moves on by its length.
  const taken = result.raw.split("\n").length - 1;
  const count = norm.spans.slice(0, taken).reduce((a, b) => a + b, 0);
  const raw = lines.slice(0, count).join("\n") + (count < lines.length ? "\n" : "");
  return { raw, token: { type: "taskList", raw, items: result.items } as MarkdownToken };
}

export const taskListTokenizer = {
  name: "taskList",
  level: "block" as const,
  start: (src: string) => src.match(/^\s*[-+*]\s+\[([ xX])\]\s+/)?.index ?? -1,
  tokenize: (src: string, _tokens: MarkdownToken[], lexer: MarkdownLexerConfiguration) => parseItems(src, lexer)?.token,
};
