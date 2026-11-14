import type { Node as PMNode } from "@tiptap/pm/model";
import { commentPreview, HtmlComment, HtmlCommentInline } from "../../shared/docfile";

/** A hand-written HTML comment as the writer sees it: a small chip with its first words, the whole comment as a tooltip. */
const chip = (tag: "div" | "span") => ({ node }: { node: PMNode }) => {
  const dom = document.createElement(tag);
  dom.className = "html-comment";
  dom.contentEditable = "false";
  dom.dataset.htmlComment = node.attrs.raw;
  dom.title = node.attrs.raw;
  const label = document.createElement("span");
  label.className = "html-comment-chip";
  label.textContent = commentPreview(node.attrs.raw);
  dom.append(label);
  return { dom, ignoreMutation: () => true };
};

export const HtmlCommentChip = HtmlComment.extend({ addNodeView: () => chip("div") });
export const HtmlCommentInlineChip = HtmlCommentInline.extend({ addNodeView: () => chip("span") });
