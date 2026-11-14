import { Extension, type Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export type LinkTarget =
  | { kind: "external"; url: string }
  /** A heading on this page. */
  | { kind: "anchor"; hash: string }
  /** A page or any other path in the project; what isn't a page ends at "No such page". */
  | { kind: "page"; id: string; hash: string }
  /** Above the project's folder: nothing to go to. */
  | { kind: "outside" };

/** Where a link in page `fromId` leads. Relative paths are from the page's folder, a leading `/` from the project's. */
export function resolveLink(fromId: string, href: string): LinkTarget {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return { kind: "external", url: href };
  if (href.startsWith("#")) return { kind: "anchor", hash: href.slice(1) };
  const [path = "", hash = ""] = href.split(/#(.*)/s);
  let decoded = path;
  try { decoded = decodeURI(path); } catch {}
  const at = decoded.startsWith("/") ? [] : fromId.split("/").slice(0, -1);
  for (const s of decoded.split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") { if (!at.length) return { kind: "outside" }; at.pop(); }
    else at.push(s);
  }
  return { kind: "page", id: at.join("/").replace(/\.md$/, ""), hash };
}

/** A heading's anchor, the way GitHub makes it. */
export const headingSlug = (text: string) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

/** Puts the caret on the heading `hash` names, and brings it into view. False when the page has none. */
export function scrollToHeading(editor: Editor, hash: string): boolean {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === "heading" && headingSlug(node.textContent) === hash) found = pos + 1;
    return found < 0;
  });
  if (found < 0) return false;
  editor.chain().setTextSelection(found).scrollIntoView().run();
  return true;
}

/** Hands a click on a link to the page, which knows where the page is and how to go there. */
export const links = Extension.create<{ onLink: (href: string, newTab: boolean) => void }>({
  name: "links",
  addOptions: () => ({ onLink: () => {} }),
  addProseMirrorPlugins() {
    const { onLink } = this.options;
    return [new Plugin({
      props: {
        handleClick(view, _pos, event) {
          const a = (event.target as HTMLElement).closest?.("a[href]");
          if (!a || !view.dom.contains(a)) return false;
          event.preventDefault();
          onLink(a.getAttribute("href")!, event.metaKey || event.ctrlKey);
          return true;
        },
      },
    })];
  },
});
