import type { JSONContent } from "@tiptap/core";
import { Node as PMNode, type Schema } from "@tiptap/pm/model";
import { parseMarkdown, serializeMarkdown } from "./dialect";
import { HTML_COMMENT } from "./htmlComment";
import { withoutStates } from "./markers";
import { schema } from "./schema";

/** Markdown body → ProseMirror document. The comments block must already be split off (raw HTML becomes text). */
export function markdownToDoc(markdown: string): PMNode {
  const json = parseMarkdown(markdown);
  // An empty page (a new one) still needs one block, and a page that ends in a comment a place to type after it. An
  // empty last paragraph is not written to the markdown.
  if (!json.content?.length) json.content = [{ type: "paragraph" }];
  if (json.content.at(-1)?.type === HTML_COMMENT) json.content.push({ type: "paragraph" });
  const doc = PMNode.fromJSON(schema, json);
  doc.check();
  return doc;
}

/** ProseMirror document → markdown body. Comment marks write nothing; markers are written as their comments. */
export function docToMarkdown(doc: PMNode): string {
  return serializeMarkdown(doc.toJSON());
}

/**
 * What a top-level block says once written to markdown, ignoring what markdown can't hold (trailing spaces, a line
 * break at the very end of a block): two blocks with the same key are the same on disk.
 */
export function blockKey(block: JSONContent): string {
  // How far a marker has got (`:ack`, `:done`) is not part of what a block says: moving it on is not a change to review.
  return withoutStates(serializeMarkdown({ type: "doc", content: [block] })).replace(/(\\|\s)+$/, "");
}

/**
 * Markdown body → a document in the given schema (the editor's own). The shared library's `schema` is a different
 * instance from the editor's: a node built with it and inserted into the editor is silently dropped.
 */
export function toEditorDoc(editorSchema: Schema, markdown: string): PMNode {
  const doc = editorSchema.nodeFromJSON(markdownToDoc(markdown).toJSON());
  doc.check();
  return doc;
}
