import type { CommentProposal } from "../place";

/**
 * Stage two of a review: every candidate gets a score out of 10, and may be dropped.
 *
 * It is an interface and not a flag because the model curator that comes later has three rules a flag could not
 * carry: it must run in a **different session** from the proposer (otherwise the model grades its own homework),
 * the candidate's own `score` must not reach it, and it needs `StartOptions.tools: "none"` so the judge is not a
 * sandboxed agent with Bash. Adding it means one more `Curator` and one more `agent.curator` value: `propose`,
 * `filter`, `pickBest` and `placeComments` do not change.
 */
export interface Curator {
  readonly name: string;
  /** A candidate scoring below this is dropped as `under-threshold`. */
  readonly threshold: number;
  /** Scores every candidate, in the order given. Each result's `score` is 0 to 10. */
  score(page: string, candidates: CommentProposal[]): Promise<CommentProposal[]>;
}

/**
 * The curator that costs nothing: the score the proposer gave itself, no call and no threshold. A self-score is the
 * agent's opinion of its own work, so it ranks worse than a judge would — see the plan's §4 on `specificity`, the
 * metric nothing here approximates.
 */
export const selfCurator: Curator = {
  name: "self",
  threshold: 0,
  score: async (_page, candidates) => candidates.map((c) => ({ ...c, score: clamp(c.score ?? 5) })),
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 5);

/** The curator `agent.curator` names. `model` is not built yet and falls back with a note in the log. */
export function curatorFor(name: string): { curator: Curator; fellBack?: string } {
  if (name === "self") return { curator: selfCurator };
  return { curator: selfCurator, fellBack: `agent.curator is "${name}", which isn't built yet: scoring by the reviewer's own scores.` };
}
