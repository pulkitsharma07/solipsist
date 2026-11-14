import type { CommentProposal, DropReason } from "../place";

/**
 * Why a candidate did not reach the margin. The free stages own the first three; the rest are `placeComments`'s own
 * `DropReason`s. Every candidate of a review ends with exactly one outcome, which is what makes a bad reading
 * answerable: the question the writer needed either was never raised, or was dropped by a stage that says so.
 */
export type Outcome = "shown" | "too-long" | "under-threshold" | "no-room" | DropReason;

export interface Judged extends CommentProposal {
  outcome: Outcome;
}

/** A candidate's margin note is its own summary: one that runs long was not the two-to-five-word note we asked for. */
export const glossWords = (gloss: string | undefined) => (gloss?.trim() ? gloss.trim().split(/\s+/).length : 0);

/**
 * The free stages around the curator: what the review proposed, in and out.
 *
 * `filter` is before the curator on purpose — a long gloss costs nothing to spot and a score costs a call.
 * `pickBest` is what is left, best first, capped. Which block each one lands on, and whether it displaces a comment
 * already there, is `placeComments`'s to decide: it has the real anchors, so it enforces one comment per passage
 * better than a line key could.
 */
export function filterCandidates(candidates: CommentProposal[], maxGlossWords: number): { kept: CommentProposal[]; out: Judged[] } {
  const kept: CommentProposal[] = [];
  const out: Judged[] = [];
  for (const c of candidates) {
    if (glossWords(c.gloss) > maxGlossWords) out.push({ ...c, outcome: "too-long" });
    else kept.push(c);
  }
  return { kept, out };
}

/** Over the threshold, best first, at most `keep`. Ties go to the earlier candidate, so a review is repeatable. */
export function pickBest(scored: CommentProposal[], keep: number, threshold: number): { kept: CommentProposal[]; out: Judged[] } {
  const out: Judged[] = [];
  const over: { c: CommentProposal; order: number }[] = [];
  scored.forEach((c, order) => {
    if ((c.score ?? 0) < threshold) out.push({ ...c, outcome: "under-threshold" });
    else over.push({ c, order });
  });
  over.sort((a, b) => (b.c.score ?? 0) - (a.c.score ?? 0) || a.order - b.order);
  const kept = over.slice(0, Math.max(0, keep)).map((x) => x.c);
  for (const x of over.slice(Math.max(0, keep))) out.push({ ...x.c, outcome: "no-room" });
  return { kept, out };
}
