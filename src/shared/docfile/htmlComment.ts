import { mergeAttributes, Node } from "@tiptap/core";

/**
 * A hand-written HTML comment in the markdown (`<!-- a note -->`), kept byte for byte. One that stands on its own
 * line(s) at the top of the page is a block; one inside a paragraph, list item or cell is inline. Each holds the whole
 * comment in `raw` and writes it back unchanged (see `dialect/htmlComments.ts`). The writer can't type one: a typed
 * `<!--` is text, written as `&lt;!--`. Marker comments of a registered kind are markers instead.
 */
export const HTML_COMMENT = "htmlComment";
export const HTML_COMMENT_INLINE = "htmlCommentInline";

const raw = {
  default: "",
  parseHTML: (el: HTMLElement) => el.getAttribute("data-html-comment") ?? "",
  renderHTML: (attrs: Record<string, any>) => ({ "data-html-comment": attrs.raw }),
};

/**
 * Not selectable, so the caret never starts on one (the first key typed would replace it): the page's start skips it
 * as it does any such atom. Backspace from the block after it still removes it, and Undo brings it back.
 */
export const HtmlComment = Node.create({
  name: HTML_COMMENT,
  group: "block",
  atom: true,
  selectable: false,
  addAttributes: () => ({ raw }),
  parseHTML: () => [{ tag: "div[data-html-comment]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { class: "html-comment" })],
});

export const HtmlCommentInline = Node.create({
  name: HTML_COMMENT_INLINE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ raw }),
  parseHTML: () => [{ tag: "span[data-html-comment]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "html-comment" })],
});

/** What a chip shows: the comment's words, without `<!--` and `-->`, cut to the first few. */
export function commentPreview(rawText: string, words = 6): string {
  const inner = rawText.replace(/^<!--/, "").replace(/-->$/, "").trim().split(/\s+/).filter(Boolean);
  return inner.length > words ? `${inner.slice(0, words).join(" ")}…` : inner.join(" ") || "comment";
}
