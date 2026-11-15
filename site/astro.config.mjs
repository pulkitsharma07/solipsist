// The website: the landing page at / (src/landing.html, built by `bun run site` at the repo root) and the
// documentation at /docs/ (src/content/docs/docs/). GitHub Pages serves dist/ (.github/workflows/pages.yml).
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://solipsist.sh",
  integrations: [
    starlight({
      title: "Solipsist",
      description: "Think and work with AI agents in your markdown docs. They suggest; you decide.",
      logo: { light: "./src/assets/logo.svg", dark: "./src/assets/logo-dark.svg", replacesTitle: true },
      favicon: "/favicon.svg",
      // The card a link to any docs page shows: the landing page's (`bun run site:og` draws it).
      head: [
        { tag: "meta", attrs: { property: "og:image", content: "https://solipsist.sh/og.png" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1280" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "640" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "Solipsist: think and work with AI agents in your markdown docs" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://solipsist.sh/og.png" } },
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/pulkitsharma07/solipsist" }],
      editLink: { baseUrl: "https://github.com/pulkitsharma07/solipsist/edit/main/site/" },
      customCss: ["./src/styles/docs.css"],
      components: { PageTitle: "./src/components/PageTitle.astro", Footer: "./src/components/Footer.astro" },
      sidebar: [
        { label: "Overview", link: "/docs/" },
        { label: "Start here", items: [{ autogenerate: { directory: "docs/start" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
        { label: "Agents", items: [{ autogenerate: { directory: "docs/agents" } }] },
        { label: "Engines", items: [{ autogenerate: { directory: "docs/engines" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
      ],
    }),
  ],
});
