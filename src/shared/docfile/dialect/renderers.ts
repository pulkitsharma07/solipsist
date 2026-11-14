import { renderTableToMarkdown } from "@tiptap/extension-table";
import type { JSONContent, MarkdownRendererHelpers } from "@tiptap/core";

// Markdown renderers that write a page so it reads back as itself. `schema.ts` hooks each into its node; the rest of
// the dialect is in `index.ts`.

/**
 * Text at the start of a line that markdown would read as a block: a heading, quote, list item, rule or setext
 * underline. Stock Tiptap only escapes inline syntax, so "# x" typed into a paragraph came back as a heading.
 */
const BLOCK_START_RE = /^( {0,3})(#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t]|$)|(?:=+|-+)(?=[ \t]*$)|\d{1,9}(?=[.)](?:[ \t]|$)))/;
export const escapeBlockStarts = (md: string) =>
  md.split("\n").map((line) => line.replace(BLOCK_START_RE, (_, sp: string, s: string) => (/^\d/.test(s) ? `${sp}${s}\\` : `${sp}\\${s}`))).join("\n");

/** A fence longer than any run of backticks in the code, so a ``` line inside it can't end the block. */
export const fenceFor = (code: string) => "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/** A link's or image's target, in angle brackets when markdown wouldn't read it otherwise (a space, say). */
export const linkTarget = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/</g, "%3C").replace(/>/g, "%3E")}>` : url);

/** `![alt](src "title")` that survives spaces, brackets and quotes in any part. */
export function imageMarkdown(attrs: Record<string, unknown> | undefined) {
  // The parser unescapes brackets in alt text but not backslashes, so only brackets are escaped.
  const alt = String(attrs?.alt ?? "").replace(/[[\]]/g, "\\$&");
  const rawSrc = String(attrs?.src ?? "");
  const src = linkTarget(rawSrc);
  const title = attrs?.title ? ` "${String(attrs.title).replace(/[\\"]/g, "\\$&")}"` : "";
  return `![${alt}](${src}${title})`;
}

/**
 * Tables without column padding: padding made one cell edit rewrite every row, so a line merge saw a change to the
 * whole table and conflicted with any other edit in it. Cell text has no trailing spaces, and every bare `|` in a
 * row is a delimiter (pipes in cells are escaped), so spaces before a `|` are padding.
 */
export function unpaddedTable(md: string) {
  return md.split("\n").map((line) => {
    if (/^\|(?: *:?-+:? *\|)+$/.test(line)) return line.replace(/(:?)-+(:?)/g, "$1---$2").replace(/ +\|/g, " |").replace(/\| +/g, "| ");
    return line.startsWith("|") ? line.replace(/ {2,}\|/g, " |") : line;
  }).join("\n");
}


export const renderParagraph = (markdown: string) => escapeBlockStarts(markdown);

export function renderCodeBlock(node: JSONContent, h: MarkdownRendererHelpers) {
  const code = node.content ? h.renderChildren(node.content) : "";
  const fence = fenceFor(code);
  return `${fence}${node.attrs?.language || ""}\n${code}\n${fence}`;
}

// The stock renderer starts the table with a blank line; two tables in a row then read back with an empty paragraph between them.
export const renderTable = (node: JSONContent, h: MarkdownRendererHelpers) => unpaddedTable(renderTableToMarkdown(node, h)).replace(/^\n+|\n+$/g, "");

export const renderImage = (node: JSONContent) => imageMarkdown(node.attrs);
