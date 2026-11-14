// /llms.txt (llmstxt.org): what Solipsist is, then a link to every docs page's markdown (src/llms.ts).
import type { APIRoute } from "astro";
import { GROUPS, SITE, docsInOrder, mdPath } from "../llms";

export const GET: APIRoute = async () => {
  const docs = await docsInOrder();
  const line = (d: (typeof docs)[number]) =>
    `- [${d.data.title}](${SITE}/${mdPath(d.id)}.md)${d.data.description ? `: ${d.data.description}` : ""}`;
  const overview = docs.filter((d) => d.id === "docs");
  const sections = GROUPS.map((g) => {
    const pages = docs.filter((d) => d.id.startsWith(`docs/${g.dir}/`));
    return pages.length ? `## ${g.label}\n\n${pages.map(line).join("\n")}` : "";
  }).filter(Boolean);

  const text = `# Solipsist

> A writing app for the markdown files in your folder. Agents suggest; they never write your page.

Solipsist is a local markdown editor that runs on a folder of \`.md\` files. You work on copies in \`.solipsist/\`, and
**Sync to file** writes back only what you changed. AI agents (Pi, built in) work on requests in the background and
every result comes back as a suggestion to accept, reject, ask again or chat about. It runs with Bun from a clone of
https://github.com/pulkitsharma07/solipsist. Every page below is also in one file: ${SITE}/llms-full.txt

## Overview

${overview.map(line).join("\n")}

${sections.join("\n\n")}

## Optional

- [Every feature](${SITE}/features.html): each part of the app, drawn with its real HTML
- [Source](https://github.com/pulkitsharma07/solipsist): the repository, with \`AGENTS.md\` for coding agents
`;
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
