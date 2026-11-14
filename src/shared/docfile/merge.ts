import { canonicalBody } from "./file";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { schema } from "./schema";
import { mergeDocs } from "./treeMerge";

/**
 * A three-way merge of page bodies. `base` is the body both writers started from, `mine` the writer's current text,
 * `theirs` the body someone else saved (a hand edit on disk, the agent, another tab). Returns the merged body, or null
 * when the two changed the same text block differently: the caller then asks the writer. The merge works on the
 * document's structure (`treeMerge.ts`), and the result is written canonically.
 */
export function mergeBodies(base: string, mine: string, theirs: string): string | null {
  const [b, m, t] = [canonicalBody(base), canonicalBody(mine), canonicalBody(theirs)];
  if (m === b) return t; // nothing of mine to keep
  if (t === b || t === m) return m; // nothing of theirs to add, or we already agree
  const merged = mergeDocs(markdownToDoc(b).toJSON(), markdownToDoc(m).toJSON(), markdownToDoc(t).toJSON());
  return merged && docToMarkdown(schema.nodeFromJSON(merged));
}
