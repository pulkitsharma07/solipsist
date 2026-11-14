import type { JSONContent } from "@tiptap/core";
import { HTML_COMMENT, HTML_COMMENT_INLINE } from "../htmlComment";

// Hand-written HTML comments travel through the markdown parser and serializer as private-use tokens that index a
// table of their raw text, so neither can change a byte of them. Marker comments are swapped before this runs
// (`toMarkers`), so what is left here is every other comment.

const OPEN = "\uE003";
const CLOSE = "\uE004";
const TOKEN_RE = /\uE003(\d+)\uE004/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const token = (raws: string[], rawText: string) => `${OPEN}${raws.push(rawText) - 1}${CLOSE}`;

/** Markdown source → the same with each comment swapped for a token, and the raw texts by token number. */
export function hideComments(markdown: string): { text: string; raws: string[] } {
  const raws: string[] = [];
  return { text: markdown.replace(COMMENT_RE, (c) => token(raws, c)), raws };
}

/**
 * After parsing: tokens become comment nodes. In code they are the comment's text again. A top-level paragraph that is
 * only a comment becomes the block node; any other comment is inline, keeping the marks of the text around it.
 */
export function placeHtmlComments(node: JSONContent, raws: string[], inCode = false, topLevel = false): JSONContent[] {
  if (node.type === "text") {
    if (!node.text?.includes(OPEN)) return [node];
    if (inCode || node.marks?.some((m) => m.type === "code")) return [{ ...node, text: node.text.replace(TOKEN_RE, (_, n: string) => raws[Number(n)]!) }];
    const out: JSONContent[] = [];
    let at = 0;
    for (const m of node.text.matchAll(TOKEN_RE)) {
      if (m.index! > at) out.push({ ...node, text: node.text.slice(at, m.index) });
      out.push({ type: HTML_COMMENT_INLINE, attrs: { raw: raws[Number(m[1])] }, ...(node.marks?.length && { marks: node.marks }) });
      at = m.index! + m[0].length;
    }
    if (at < node.text.length) out.push({ ...node, text: node.text.slice(at) });
    return out;
  }
  if (!node.content) return [node];
  const code = inCode || node.type === "codeBlock";
  const content = node.content.flatMap((c) => placeHtmlComments(c, raws, code, node.type === "doc"));
  const only = content.length === 1 ? content[0]! : null;
  if (topLevel && node.type === "paragraph" && only?.type === HTML_COMMENT_INLINE && !only.marks?.length) return [{ type: HTML_COMMENT, attrs: only.attrs }];
  return [{ ...node, content }];
}

/** Before serializing: comment nodes become tokens (a block one, a paragraph of its token), with their raw texts. */
export function commentsToTokens(json: JSONContent): { json: JSONContent; raws: string[] } {
  const raws: string[] = [];
  const walk = (node: JSONContent): JSONContent => {
    if (node.type === HTML_COMMENT) return { type: "paragraph", content: [{ type: "text", text: token(raws, node.attrs?.raw ?? "") }] };
    if (node.type === HTML_COMMENT_INLINE) return { type: "text", text: token(raws, node.attrs?.raw ?? ""), ...(node.marks?.length && { marks: node.marks }) };
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return { json: walk(json), raws };
}

/** After serializing: tokens become the comments' raw text again. */
export const tokensToComments = (markdown: string, raws: string[]) => markdown.replace(TOKEN_RE, (_, n: string) => raws[Number(n)] ?? "");
