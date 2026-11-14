import type { JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { fromMarkers, toMarkers } from "../markers";
import { pageExtensions } from "../schema";
import { commentsToTokens, hideComments, placeHtmlComments, tokensToComments } from "./htmlComments";
import { compatibleMarks, flagStarLists, starMarkers, trimLineIndents, withoutHighlights, wrapStrayInlines } from "./normalise";
import { markersToText, nodeRangesToText, placeMarkers, shareInstructions } from "./markerSwap";

/**
 * Our markdown dialect: everything that makes it differ from stock Tiptap, in this folder. The renderers of
 * paragraphs, code blocks, tables and images (`renderers.ts`, hooked in by `schema.ts`), the HTML rule below, the
 * load and save normalisations (`normalise.ts`), the marker swap (`markerSwap.ts`) and hand-written HTML
 * comments kept byte for byte (`htmlComments.ts`). `test/dialect.test.ts`
 * is its contract: run it on every Tiptap upgrade.
 */
const manager = new MarkdownManager({ extensions: pageExtensions() });

type HtmlToken = { text?: string; raw?: string; block?: boolean };
type Html = JSONContent | JSONContent[] | null;
interface Hooks { parseHTMLToken(t: HtmlToken): Html; htmlAsLiteralText(html: string, block: boolean): Html; encodeTextForMarkdown(text: string, node: unknown, parent: unknown): string }

/**
 * The HTML rule replaces a private method of Tiptap's MarkdownManager. If an upgrade renames or drops it, fail at once,
 * here, rather than parse HTML in the browser again (where hand-written notes would silently vanish).
 */
export function assertDialectHooks(m: unknown): void {
  const missing = (["parseHTMLToken", "htmlAsLiteralText", "encodeTextForMarkdown"] as const).filter((k) => typeof (m as Record<string, unknown>)[k] !== "function");
  if (missing.length) {
    throw new Error(`@tiptap/markdown no longer has MarkdownManager.${missing.join(" / ")}: update src/shared/docfile/dialect/index.ts (the raw HTML rule) and run test/dialect.test.ts.`);
  }
}
assertDialectHooks(manager);

// Raw HTML is always kept as literal text. Stock Tiptap does that only without a DOM: in the browser it parsed HTML
// with the schema's rules, which dropped what the schema can't hold (an HTML comment, `<details>`), so a hand-written
// note vanished on the tab's next save, and the browser and server read the same file differently.
const hooks = manager as unknown as Hooks;
hooks.parseHTMLToken = (token) => {
  const html = token.text || token.raw || "";
  return html.trim() ? hooks.htmlAsLiteralText(html, !!token.block) : null;
};

// A bare `&` is written as `&`. Tiptap writes every `&` in text as `&amp;`, so "Tea & coffee" was saved as
// "Tea &amp; coffee" (the writer's own typing and an agent's suggestion alike). Only an `&` that would read back as an
// entity (`&amp;`, `&#45;`, `&lt;` typed as text) has to stay escaped; any other reads back as itself.
const encodeText = hooks.encodeTextForMarkdown.bind(hooks);
hooks.encodeTextForMarkdown = (text, node, parent) => looserEscapes(encodeText(text, node, parent).replace(/&amp;(?!#?[a-zA-Z0-9]+;)/g, "&"), node);

/**
 * Tiptap backslash-escapes every `[`, `]`, `~` and `_` in text, so a save turned `[P]`, `[!NOTE]`, `[^1]`, `~2h` and
 * `created_date` into something other tools no longer read. Only the ones that could mean something stay escaped.
 */
function looserEscapes(escaped: string, node: unknown): string {
  let out = escaped.replace(/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "_");
  if ((out.match(/\\~/g) ?? []).length === 1) out = out.replace("\\~", "~");
  const marks = (node as { marks?: { type: unknown }[] }).marks ?? [];
  const inLink = marks.some((m) => m.type === "link" || (m.type as { name?: string })?.name === "link");
  // Text that could become a link, a link definition or a task box keeps its brackets escaped.
  const meaningful = /\\\](?:\\?\(|\\?\[)/.test(out) || /^\\\[(?!\^)[^\n]*\\\]:/m.test(out) || /^\\\[[ xX]\\\](?:\s|$)/m.test(out);
  if (!inLink && !meaningful) out = out.replace(/\\([[\]])/g, "$1");
  return out;
}

/** Markdown body → the document as JSON, every node valid for the page's schema. The comments block must already be split off. */
export function parseMarkdown(markdown: string): JSONContent {
  const { text, raws } = hideComments(toMarkers(markdown));
  return trimLineIndents(compatibleMarks(wrapStrayInlines(placeHtmlComments(shareInstructions(placeMarkers(manager.parse(text))[0]!), raws)[0]!)));
}

// Blank lines at the very end are not kept: the file drops them, and a block's key must not depend on them.
export function serializeMarkdown(doc: JSONContent): string {
  const { json, raws } = commentsToTokens(markersToText(nodeRangesToText(flagStarLists(withoutHighlights(doc)))));
  return tokensToComments(starMarkers(fromMarkers(manager.serialize(json))), raws).replace(/(?:\r?\n[ \t]*)+$/, "");
}

/** A stretch of a body: `key` is what it says in the app's own form; a gap (blank lines, a link definition) has none. */
export interface Piece { text: string; key: string | null }

const canonOf = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));

/** The top-level items of a task list, cut from its text (its tokens carry none): each starts a line at the first item's indent. */
function taskItemTexts(raw: string): string[] {
  const lines = raw.split("\n");
  const indent = raw.length - raw.trimStart().length;
  const item = new RegExp(`^ {${indent}}[-+*]\\s+\\[[ xX]\\]\\s`);
  const starts = lines.flatMap((l, i) => (item.test(l) ? [i] : []));
  return starts.map((s, k) => lines.slice(s, starts[k + 1] ?? lines.length).join("\n") + (k < starts.length - 1 ? "\n" : ""));
}

/**
 * Cuts a body into pieces that cover it exactly: a top-level block, or (`splitLists`) one item of a list. Each is keyed by its
 * canonical form, with the page's link definitions added so a reference link keys the same alone as in the page.
 */
export function lexPieces(markdown: string, splitLists = true): Piece[] {
  const { text, raws } = hideComments(markdown);
  const show = (s: string) => s.replace(/(\d+)/g, (_, n: string) => raws[Number(n)]!);
  const tokens = manager.instance.lexer(text) as unknown as { type: string; raw: string; items?: { raw: string }[] }[];
  const defs = tokens.filter((t) => t.type === "def").map((t) => show(t.raw).trim()).join("\n");
  const out: Piece[] = [];
  const add = (raw: string) => {
    const shown = show(raw);
    const body = shown.replace(/\n+$/, "");
    out.push({ text: body, key: canonOf(body + (defs ? `\n\n${defs}` : "")) });
    if (shown.length > body.length) out.push({ text: shown.slice(body.length), key: null });
  };
  for (const t of tokens) {
    if (t.type === "space" || t.type === "def") { out.push({ text: show(t.raw), key: null }); continue; }
    const items = t.type === "taskList" ? taskItemTexts(t.raw) : t.items?.map((i) => i.raw);
    if (splitLists && items && items.length > 1 && items.join("").trimEnd() === t.raw.trimEnd()) {
      items.forEach(add);
      const tail = t.raw.slice(t.raw.trimEnd().length);
      if (tail && !items.at(-1)!.endsWith("\n")) out.push({ text: tail, key: null });
    } else add(t.raw);
  }
  return out;
}
