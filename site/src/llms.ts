// The docs as plain markdown, for AI agents (llmstxt.org): each page's source with its components turned into text,
// served at <page>.md, listed in /llms.txt and concatenated in /llms-full.txt (src/pages/). A link to a docs page that
// doesn't exist fails the build.
import { getCollection, type CollectionEntry } from "astro:content";

export const SITE = "https://solipsist.work";

type Doc = CollectionEntry<"docs">;

/** The sidebar's groups, in its order (astro.config.mjs). */
export const GROUPS = [
  { dir: "start", label: "Start here" },
  { dir: "guides", label: "Guides" },
  { dir: "agents", label: "Agents" },
  { dir: "reference", label: "Reference" },
] as const;

/** Where a page's markdown is served: /docs/ → /docs/index.md, /docs/start/install/ → /docs/start/install.md. */
export const mdPath = (id: string) => (id === "docs" ? "docs/index" : id);

const pageUrl = (id: string) => `${SITE}/${id}/`;

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Every docs page, in the sidebar's order: the overview first, then each group by `sidebar.order`. */
export async function docsInOrder(): Promise<Doc[]> {
  const all = await getCollection("docs");
  const order = (d: Doc) => d.data.sidebar?.order ?? 999;
  const byGroup = GROUPS.flatMap((g) =>
    all.filter((d) => d.id.startsWith(`docs/${g.dir}/`)).sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id)),
  );
  return [...all.filter((d) => d.id === "docs"), ...byGroup];
}

/** A page's body as markdown a reader without the site's components can follow. */
export function toMarkdown(doc: Doc, ids: Set<string>): string {
  let md = (doc.body ?? "")
    .replace(/^import .*;?\s*$/gm, "")
    // A picture of the app: its description, since the image itself is drawn per theme.
    .replace(/<Shot\b[^>]*\/>/g, (tag) => {
      const caption = attr(tag, "caption");
      return `*[Picture: ${attr(tag, "alt") ?? attr(tag, "title")}]*${caption ? ` ${caption}` : ""}`;
    })
    .replace(/<StatusBarMap\b[^>]*\/>/g, (tag) => `*[Picture: ${attr(tag, "title")}, each part labelled]*`)
    // The pill pictures; the table after them says the same in words.
    .replace(/<Pills\s*\/>/g, "")
    .replace(/<Aside\b([^>]*)>([\s\S]*?)<\/Aside>/g, (_, attrs: string, body: string) => {
      const title = attr(attrs, "title");
      const lines = body.trim().split("\n");
      return lines.map((l, i) => `> ${i === 0 && title ? `**${title}:** ` : ""}${l}`).join("\n");
    })
    .replace(/^[ \t]*<LinkCard\b[^>]*\/>/gm, (tag) => `- [${attr(tag, "title")}](${attr(tag, "href")}): ${attr(tag, "description")}`)
    .replace(/<\/?CardGrid>/g, "");

  const left = md.match(/<[A-Z][A-Za-z]*\b/);
  if (left) throw new Error(`llms: ${doc.id} uses ${left[0]}>, which toMarkdown doesn't turn into text yet`);

  // Links within the site become absolute, so the markdown works wherever it's pasted.
  md = md.replace(/\]\((\/[^)\s]*)\)/g, (_, href: string) => {
    const [path] = href.split("#");
    if (path.startsWith("/docs/")) {
      const id = path.replace(/^\/|\/$/g, "");
      if (!ids.has(id)) throw new Error(`llms: ${doc.id} links to ${href}, which is not a docs page`);
    }
    return `](${SITE}${href})`;
  });

  const head = `# ${doc.data.title}\n\n${doc.data.description ? `> ${doc.data.description}\n\n` : ""}`;
  return `${head}${md.replace(/\n{3,}/g, "\n\n").trim()}\n\nSource: ${pageUrl(doc.id)}\n`;
}

export async function allMarkdown(): Promise<{ doc: Doc; md: string }[]> {
  const docs = await docsInOrder();
  const ids = new Set(docs.map((d) => d.id));
  return docs.map((doc) => ({ doc, md: toMarkdown(doc, ids) }));
}
