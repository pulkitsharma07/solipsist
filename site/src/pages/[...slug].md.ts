// Every docs page as markdown, at <page>.md (src/llms.ts).
import type { APIRoute, GetStaticPaths } from "astro";
import { allMarkdown, mdPath } from "../llms";

export const getStaticPaths: GetStaticPaths = async () =>
  (await allMarkdown()).map(({ doc, md }) => ({ params: { slug: mdPath(doc.id) }, props: { md } }));

export const GET: APIRoute = ({ props }) =>
  new Response(props.md as string, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
