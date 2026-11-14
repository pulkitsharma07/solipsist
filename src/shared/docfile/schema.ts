import { getSchema, Mark, mergeAttributes, type AnyExtension } from "@tiptap/core";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import Image from "@tiptap/extension-image";
import Paragraph from "@tiptap/extension-paragraph";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableKit } from "@tiptap/extension-table";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";
import { linkTarget, renderCodeBlock, renderImage, renderParagraph, renderTable } from "./dialect/renderers";
import { taskListTokenizer } from "./dialect/taskItems";
import { HtmlComment, HtmlCommentInline } from "./htmlComment";
import { MarkerPoint, MarkerRange } from "./markerNodes";

/**
 * A comment's highlight. It lives only in the editor: it serializes to nothing in the markdown, because comments are
 * stored in the comments block at the end of the file (see `file.ts`).
 */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false, // typing at the edge of a highlight doesn't extend it
  excludes: "", // comments may overlap each other and any formatting
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment"),
        renderHTML: (attrs) => ({ "data-comment": attrs.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-comment]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "hl" }), 0];
  },
  renderMarkdown: (node, h) => h.renderChildren(node),
});

/** Where the server serves the files that sit next to the pages (their images). */
export const ASSET_PREFIX = "/api/assets/";
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/|#)/i;
/** A path as written in the markdown → the URL to load it from. Web addresses, data: URLs and rooted paths stay as they are. */
/** The page's folder in the project, ending in `/` (empty otherwise): what its relative images are relative to. One page per tab. */
let assetBase = "";
export const setAssetBase = (base: string) => { assetBase = base; };
export const assetUrl = (src: string) => (ABSOLUTE.test(src) ? src : ASSET_PREFIX + assetBase + src.replace(/^\.\//, ""));
export const assetPath = (src: string | null) => (src?.startsWith(ASSET_PREFIX + assetBase) ? src.slice((ASSET_PREFIX + assetBase).length) : src);

/**
 * What a page can hold: shared by the editor and the server. All of StarterKit is in, so ordinary markdown from disk
 * survives a save; two overrides let comments sit on code, which stock Tiptap silently refuses. The markdown
 * renderers of paragraphs, code blocks, images and tables are the dialect's (`dialect/renderers.ts`), so every page
 * reads back as itself.
 */
export const pageExtensions = (): AnyExtension[] => [
  StarterKit.configure({ code: false, codeBlock: false, paragraph: false, link: false }),
  Link.extend({
    renderMarkdown: (node, h) => {
      const { href, title } = (node.attrs ?? {}) as { href?: string; title?: string };
      return `[${h.renderChildren(node)}](${linkTarget(href ?? "")}${title ? ` "${title}"` : ""})`;
    },
  }).configure({ openOnClick: false }),
  Paragraph.extend({
    renderMarkdown(node, h, ctx) {
      return renderParagraph(this.parent!(node, h, ctx));
    },
  }),
  // Stock `Code` excludes every other mark ("_"); keep excluding formatting, but allow comments.
  Code.extend({ excludes: "bold italic strike underline link" }),
  // Stock `CodeBlock` allows no marks at all.
  CodeBlock.extend({
    marks: "comment",
    renderMarkdown: renderCodeBlock,
  }),
  // Stock task items keep only their first line as text (`dialect/taskItems.ts`).
  TaskList.extend({ markdownTokenizer: taskListTokenizer }),
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: false }),
  Table.extend({ renderMarkdown: renderTable }),
  // Inline, so `![a](b)` inside a paragraph is valid; an image on its own line is wrapped in a paragraph on load.
  Image.configure({ inline: true }).extend({
    renderMarkdown: renderImage,
    // The markdown keeps the path as written (`images/a.svg`, relative to the page's folder); the browser is given the
    // URL the server serves it from, and the path is recovered when an image is pasted or dragged back in.
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: (el) => assetPath(el.getAttribute("src")),
          renderHTML: (attrs) => (attrs.src ? { src: assetUrl(attrs.src) } : {}),
        },
      };
    },
  }),
  CommentMark,
  MarkerPoint,
  MarkerRange,
  HtmlComment,
  HtmlCommentInline,
];

export const schema = getSchema(pageExtensions());
