import {
  addComment, anchor, cleanQuote, commentCap, countMatches, deleteComment, describe, docText, listComments,
  markdownToDoc, parseFile, serializeFile, type QuoteProblem,
} from "../shared/docfile";

/** One question a review raised, before it is placed: who asked it, and what it is worth. */
export interface Proposal {
  quote: string;
  title: string;
  gloss?: string;
  body?: string;
  description?: string;
  /** A picture the reviewer drew for it, as the page writes the path (`images/<link folder>/x.svg`: the page's file name under `images/`). */
  image?: string;
  /** The `engine:model` the reviewer ran on. */
  model?: string;
  importance?: "high" | "low";
  /** 0 to 10, from `agent.curator`. Decides which comment holds a block when two want it (`pickBest`). */
  score?: number;
  thinker: string;
}

/** A question as the agent gave it, before the review says which reader it came from. */
export type CommentProposal = Omit<Proposal, "thinker">;

export type DropReason = QuoteProblem | "not-in-read-text" | "ambiguous" | "gone" | "overlaps" | "already-raised" | "cap-full";

export interface PlaceResult {
  file: string;
  placed: string[];
  dropped: { quote: string; reason: DropReason }[];
  /** Comments a better one took the place of: unread, and scoring lower than the one that replaced them. */
  replaced: string[];
}

/** The cap, and how a comment already on screen may be displaced. */
export interface PlaceLimits {
  minKept?: number;
  perBlock?: number;
}

/**
 * Adds a review's comments to the latest file (plan sections 3.4 and 6.4). Each quote is placed in two steps: found
 * in the text the review read and described there, which gives it real context, then that anchor is found in the
 * latest text. The body is never changed. One write for the whole run.
 *
 * A comment already on screen keeps its block, and its slot, unless the candidate **scores higher and the writer has
 * not opened that card** (`opened_at`): a question they have read is never taken away from them. A proposal with no
 * score of its own displaces nothing, so the mock generator and the dev route only ever add.
 */
export function placeComments(readMarkdown: string, latestSrc: string, proposals: Proposal[], now = new Date(), limits: PlaceLimits = {}): PlaceResult {
  const readDt = docText(markdownToDoc(readMarkdown));
  const { markdown, block: initial } = parseFile(latestSrc);
  const latestDoc = markdownToDoc(markdown);
  const latestDt = docText(latestDoc);
  let block = initial;
  const result: PlaceResult = { file: latestSrc, placed: [], dropped: [], replaced: [] };
  const drop = (quote: string, reason: DropReason) => result.dropped.push({ quote, reason });

  // Where the live comments are now, with what each is worth and whether it has been read.
  let held = listComments(block, "open")
    .map((c) => ({ id: c.id, score: c.score ?? 0, read: Boolean(c.opened_at), at: anchor(latestDt, c.anchor) }))
    .filter((h) => h.at !== null) as { id: string; score: number; read: boolean; at: { from: number; to: number } }[];
  // Passages the writer already dismissed a comment on, and the exact text of orphaned comments: not raised again.
  const dismissed = listComments(block, "dismissed").map((c) => anchor(latestDt, c.anchor)).filter((r) => r !== null);
  const orphanedText = new Set(listComments(block, "orphaned").map((c) => c.anchor.exact));
  const cap = commentCap(latestDoc, limits.minKept, limits.perBlock);

  /** Takes a held comment out of the file and off the list, for the candidate that beat it. */
  const evict = (id: string) => {
    block = deleteComment(block, id);
    held = held.filter((h) => h.id !== id);
    result.replaced.push(id);
    const was = result.placed.indexOf(id);
    if (was !== -1) result.placed.splice(was, 1);
  };

  for (const p of proposals) {
    const cleaned = cleanQuote(p.quote);
    if ("problem" in cleaned) { drop(p.quote, cleaned.problem); continue; }
    const { quote, images } = cleaned;

    const matches = countMatches(readDt, quote, images);
    if (matches === 0) { drop(p.quote, "not-in-read-text"); continue; }
    if (matches > 1) { drop(p.quote, "ambiguous"); continue; }
    const inRead = anchor(readDt, { exact: quote, prefix: "", suffix: "", start: 0, images })!;
    const withContext = describe(readDt, inRead.from, inRead.to);

    const inLatest = anchor(latestDt, withContext);
    if (!inLatest) { drop(p.quote, "gone"); continue; }
    const overlaps = (r: { from: number; to: number }) => inLatest.from < r.to && r.from < inLatest.to;
    if (dismissed.some(overlaps) || orphanedText.has(latestDt.text.slice(inLatest.from, inLatest.to))) { drop(p.quote, "already-raised"); continue; }

    // Whether this candidate is worth more than a comment already there. No score of its own: never.
    const beats = (h: { score: number; read: boolean }) => p.score !== undefined && !h.read && p.score > h.score;
    const clash = held.filter((h) => overlaps(h.at));
    if (clash.length && !clash.every(beats)) { drop(p.quote, "overlaps"); continue; }
    for (const h of clash) evict(h.id);

    if (held.length >= cap) {
      // Full: the weakest unread comment worth less than this one makes room, if there is one.
      const weakest = held.filter(beats).sort((a, b) => a.score - b.score)[0];
      if (!weakest) { drop(p.quote, "cap-full"); continue; }
      evict(weakest.id);
    }

    const added = addComment(block, {
      thinker: p.thinker, title: p.title, gloss: p.gloss, body: p.body, description: p.description,
      importance: p.importance, ...(p.image && { image: p.image }), ...(p.model && { model: p.model }),
      ...(p.score !== undefined && { score: p.score }),
      anchor: describe(latestDt, inLatest.from, inLatest.to),
    }, now);
    block = added.block;
    held.push({ id: added.id, score: p.score ?? 0, read: false, at: inLatest });
    result.placed.push(added.id);
  }

  if (result.placed.length || result.replaced.length) {
    block = { ...block, meta: { ...block.meta, rev: block.meta.rev + 1 } };
    result.file = serializeFile(markdown, block);
  }
  return result;
}
