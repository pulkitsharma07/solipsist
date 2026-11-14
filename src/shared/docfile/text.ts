import type { Node as PMNode } from "@tiptap/pm/model";
import { HTML_COMMENT_INLINE } from "./htmlComment";
import { POINT_NODE } from "./markers";

interface Segment { textStart: number; pos: number; len: number }

/**
 * The document text: each text block's content (paragraph, heading, list item, table cell, code block), joined with
 * "\n", with a map between text offsets and ProseMirror positions. Anchors are found and described in this text.
 */
export interface DocText {
  text: string;
  /** Each text block's range in `text`. A quote must sit inside one. */
  blocks: { start: number; end: number }[];
  /** Inline leaves (images, hard breaks, generate markers) by their offset in `text`: an image is the one character \ufffc, the others a space. */
  leaves: Map<number, PMNode>;
  toPos(offset: number): number | null;
  toOffset(pos: number): number | null;
}

export function docText(doc: PMNode): DocText {
  let text = "";
  const blocks: DocText["blocks"] = [];
  const segments: Segment[] = [];
  const leaves = new Map<number, PMNode>();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (blocks.length) text += "\n";
    const start = text.length;
    node.forEach((child, offset) => {
      const childPos = pos + 1 + offset;
      if (child.isText) {
        segments.push({ textStart: text.length, pos: childPos, len: child.text!.length });
        text += child.text;
      } else {
        // Inline leaves (hard break, image): one character, one position.
        segments.push({ textStart: text.length, pos: childPos, len: 1 });
        leaves.set(text.length, child);
        // A marker or an HTML comment is a space: the model never quotes it, and anchors around it line up.
        text += child.type.name === "hardBreak" || child.type.name === POINT_NODE || child.type.name === HTML_COMMENT_INLINE ? " " : "￼";
      }
    });
    blocks.push({ start, end: text.length });
    return false;
  });
  return {
    text,
    blocks,
    leaves,
    toPos: (offset) => {
      for (const s of segments) if (offset >= s.textStart && offset <= s.textStart + s.len) return s.pos + offset - s.textStart;
      return null;
    },
    toOffset: (pos) => {
      for (const s of segments) if (pos >= s.pos && pos <= s.pos + s.len) return s.textStart + pos - s.pos;
      return null;
    },
  };
}
