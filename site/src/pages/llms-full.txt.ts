// /llms-full.txt (llmstxt.org): every docs page's markdown in one file, in the sidebar's order (src/llms.ts).
import type { APIRoute } from "astro";
import { allMarkdown } from "../llms";

export const GET: APIRoute = async () => {
  const pages = (await allMarkdown()).map(({ md }) => md);
  return new Response(pages.join("\n---\n\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
