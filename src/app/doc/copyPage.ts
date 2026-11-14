import type { JSONContent } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { HTML_COMMENT, HTML_COMMENT_INLINE, POINT_NODE, RANGE_MARK, schema } from "../../shared/docfile";
import { serializeMarkdown } from "../../shared/docfile/dialect";

/**
 * Copy page (the top bar's Copy button): the page as the writer sees their own text, in two formats in one clipboard
 * write, so it pastes well into GitHub (a markdown textarea reads `text/plain`) and into Google Docs (rich text reads
 * `text/html`). Taken from the editor's doc, so unsaved edits are in it.
 *
 * Left out: every marker (a point disappears; a range keeps its text and loses its comments), the comment highlights
 * (the margin's comments live in the file's hidden block, never in the doc), and hand-written HTML comments (the
 * writer's private notes, shown as chips). Suggestions, previews and cards are decorations, not doc content, so they
 * are never in it to begin with.
 *
 * The pure parts (`cleanPage`, `pageMarkdown`, `pageHtml`, `pageImages`, `inlineImages`) are apart from the clipboard
 * and the network (`copyPage`, which takes them as `CopyIO`), so a test can run them without a browser.
 */

/** The total size of the images put into the HTML as `data:` URIs; past it, the rest stay links. */
export const INLINE_LIMIT_BYTES = 8 * 1024 * 1024;

const DROPPED_NODES = new Set([POINT_NODE, HTML_COMMENT, HTML_COMMENT_INLINE]);
const DROPPED_MARKS = new Set([RANGE_MARK, "comment"]);

/**
 * The page's doc without markers, comment highlights or HTML comments. A text block that held only what was dropped
 * (a paragraph that was just a `gen` marker) goes too, rather than leave an empty line where it was. Read back through
 * the schema, so the text either side of a dropped point joins up again.
 */
export function cleanPage(doc: JSONContent): JSONContent {
  const clean = (node: JSONContent): JSONContent | null => {
    if (DROPPED_NODES.has(node.type ?? "")) return null;
    const marks = node.marks?.filter((m) => !DROPPED_MARKS.has(m.type));
    const out: JSONContent = { ...node };
    if (node.marks) { if (marks!.length) out.marks = marks; else delete out.marks; }
    if (node.content) {
      const content: JSONContent[] = [];
      let dropped = false;
      for (const child of node.content) {
        const c = clean(child);
        if (!c) { dropped = true; continue; }
        // "Before <!-- gen:abc --> after." reads "Before after.", not with two spaces where the marker was.
        const prev = content.at(-1);
        if (dropped && c.type === "text" && prev?.type === "text" && /\s$/.test(prev.text ?? "") && /^\s/.test(c.text ?? "")) {
          c.text = c.text!.replace(/^\s+/, "");
          if (!c.text) continue;
        }
        dropped = false;
        content.push(c);
      }
      if (!content.length && node.content.length && schema.nodes[node.type!]?.isTextblock) return null;
      out.content = content;
    }
    return out;
  };
  const doc2 = clean(doc) ?? { type: "doc", content: [] };
  if (!doc2.content?.length) doc2.content = [{ type: "paragraph" }];
  return schema.nodeFromJSON(doc2).toJSON();
}

/**
 * `text/plain`: the page's markdown, by the app's own dialect. Image paths stay as written (`images/<id>/x.png`,
 * relative to the page's folder): that is what renders when the page's folder is in a GitHub repo, whereas this
 * server's URL (`http://localhost:…/api/assets/…`) would render nowhere but on this machine.
 */
export const pageMarkdown = (clean: JSONContent) => serializeMarkdown(clean);

/** `text/html`: the page as the editor's schema draws it, in a fragment of `doc` (any Document: the page's own, or a fake one). */
export function pageHtml(clean: JSONContent, doc: Document): HTMLElement {
  const root = doc.createElement("div");
  root.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(schema.nodeFromJSON(clean).content, { document: doc }));
  return root;
}

/** Each image's path as written in the page, once, in page order. */
export function pageImages(clean: JSONContent): string[] {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    const src = n.type === "image" ? n.attrs?.src : null;
    if (typeof src === "string" && src && !src.startsWith("data:") && !out.includes(src)) out.push(src);
    n.content?.forEach(walk);
  };
  walk(clean);
  return out;
}

/** An image as a `data:` URI ready for the HTML (PNG, JPEG or GIF; anything else converted to PNG), or null when it can't be had. */
export type ImageLoader = (url: string) => Promise<string | null>;

export interface Inlined {
  /** How many images were too many for the size limit, or failed to load, and stay links (absolute URLs). */
  linked: number;
  overLimit: boolean;
}

/**
 * Puts each image of the HTML in as a `data:` URI, in page order, while the total stays under `limit`; from the first
 * that doesn't fit, the rest keep their absolute URL (Google Docs fetches a URL it can reach; this server's it can't,
 * but a link is still better than nothing). One that fails to load keeps its URL too.
 */
export async function inlineImages(root: HTMLElement, origin: string, load: ImageLoader, limit = INLINE_LIMIT_BYTES): Promise<Inlined> {
  const imgs = [...root.querySelectorAll("img")];
  const bySrc = new Map<string, HTMLImageElement[]>();
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    bySrc.set(src, [...(bySrc.get(src) ?? []), img]);
  }
  let used = 0, linked = 0, overLimit = false;
  for (const [src, els] of bySrc) {
    const url = new URL(src, origin).href;
    const data = overLimit ? null : await load(url).catch(() => null);
    if (data && used + data.length <= limit) {
      used += data.length;
      for (const el of els) el.setAttribute("src", data);
      continue;
    }
    if (data) overLimit = true;
    linked += 1;
    for (const el of els) el.setAttribute("src", url);
  }
  return { linked, overLimit };
}

export interface CopyResult {
  /** What the button says once it has copied (its title). */
  note: string;
}

/** What `copyPage` needs from the browser; a test passes its own. */
export interface CopyIO {
  document: Document;
  origin: string;
  load: ImageLoader;
  /** One write of both formats, or null where the browser can't write HTML (then `writeText` takes the markdown). */
  write: ((items: Record<string, Promise<Blob>>) => Promise<void>) | null;
  writeText: (text: string) => Promise<void>;
}

/** The note for a copy, from what happened to its images. */
export function copyNote(images: number, inlined: Inlined | null): string {
  if (!inlined || !inlined.linked) return "Copied";
  const n = inlined.linked;
  const why = inlined.overLimit ? `over ${INLINE_LIMIT_BYTES / 1024 / 1024} MB of images` : "couldn't load";
  return `Copied (${n} of ${images} image${images === 1 ? "" : "s"} linked, not embedded: ${why})`;
}

/**
 * Copies the page. The clipboard write starts at once, with the HTML still to come (a promise), so it happens inside the
 * click that asked for it: a browser may refuse a write that comes after the images have been fetched.
 */
export async function copyPage(doc: JSONContent, io: CopyIO): Promise<CopyResult> {
  const clean = cleanPage(doc);
  const md = pageMarkdown(clean);
  const images = pageImages(clean).length;
  if (!io.write) {
    await io.writeText(md);
    return { note: "Copied (as markdown only)" };
  }
  const built = (async () => {
    const root = pageHtml(clean, io.document);
    const inlined = await inlineImages(root, io.origin, io.load);
    return { inlined, blob: new Blob([`<meta charset="utf-8">${root.innerHTML}`], { type: "text/html" }) };
  })();
  await io.write({ "text/plain": Promise.resolve(new Blob([md], { type: "text/plain" })), "text/html": built.then((b) => b.blob) });
  return { note: copyNote(images, (await built).inlined) };
}

const KEPT_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Draws an image (an SVG, a WebP…) on a canvas at its natural size and gives it back as PNG: Google Docs drops SVG. */
async function toPng(blob: Blob): Promise<string | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // An SVG with no width and height of its own has no natural size: draw it at the size a browser gives it.
    const w = img.naturalWidth || 300, h = img.naturalHeight || 150;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Fetches an image from the server and makes it a `data:` URI Google Docs keeps. */
export const loadImage: ImageLoader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  return KEPT_TYPES.has(blob.type) ? asDataUrl(blob) : toPng(blob);
};

/** The browser's own `CopyIO`. */
export function browserCopyIO(): CopyIO {
  const clip = navigator.clipboard;
  const canWrite = typeof ClipboardItem !== "undefined" && typeof clip?.write === "function";
  return {
    document,
    origin: location.origin,
    load: loadImage,
    write: canWrite ? (items) => clip.write([new ClipboardItem(items)]) : null,
    writeText: (text) => clip.writeText(text),
  };
}
