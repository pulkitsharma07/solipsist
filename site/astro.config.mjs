// The website: the landing page at / (src/landing.html, built by `bun run site` at the repo root) and the
// documentation at /docs/ (src/content/docs/docs/). GitHub Pages serves dist/ (.github/workflows/pages.yml).
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://solipsist.work",
  integrations: [
    starlight({
      title: "Solipsist",
      description: "A markdown editor for the files in a folder, with agents that suggest and never write the page themselves.",
      logo: { light: "./src/assets/logo.svg", dark: "./src/assets/logo-dark.svg", replacesTitle: true },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/pulkitsharma07/solipsist" }],
      editLink: { baseUrl: "https://github.com/pulkitsharma07/solipsist/edit/main/site/" },
      customCss: ["./src/styles/docs.css"],
      components: { PageTitle: "./src/components/PageTitle.astro", Footer: "./src/components/Footer.astro" },
      sidebar: [
        { label: "Overview", link: "/docs/" },
        { label: "Start here", items: [{ autogenerate: { directory: "docs/start" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
        { label: "Agents", items: [{ autogenerate: { directory: "docs/agents" } }] },
        { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
      ],
    }),
  ],
});
