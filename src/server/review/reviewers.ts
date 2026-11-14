/**
 * Who reviews a page. One reviewer today; the shape is here so a second is a row in a list rather than a rewrite.
 *
 * A reviewer is a brief and, when it wants one of its own, an engine and model. Its brief is a prompt of its own
 * (`review.<id>`), so the writer edits what each reviewer looks for, in the gear, like any other prompt — which is
 * the whole point of keeping them apart: two reviewers that share a brief are one reviewer.
 *
 * What a second one will need, when it comes: `review.reviewers` to say which of them run, a turn each in
 * `PageAgents.review` (they are separate runs, and must be — one agent asked to hold two briefs holds neither), and
 * `pickBest` already does the rest, since it allocates across everything proposed whoever proposed it. The comment's
 * `thinker` is the reviewer's id, so the margin can say who asked and the writer can turn one off.
 */
export interface Reviewer {
  /** Its id, which is also its prompt's (`review.<id>`) and the `thinker` of every comment it raises. */
  id: string;
  /** What the gear calls its prompt. */
  title: string;
  /** One line about what it looks for, for the prompt's description in the settings dialog. */
  description: string;
  /** Its own `engine:model`, when it should not run on the page's. Absent: the page's choice. */
  model?: string;
}

/** The reviewer every page gets: a careful reader of a draft, who asks and never writes. */
export const REVIEWER: Reviewer = {
  id: "reviewer",
  title: "Page review: the reviewer's brief",
  description: "What the reviewer looks for and how it asks. Its own prompt, so a second reviewer later is a second brief, not a change to this one.",
};

const registered: Reviewer[] = [REVIEWER];

/** Every reviewer that may run, in order. */
export const reviewers = (): readonly Reviewer[] => registered;

/** The reviewer with this id, or undefined. */
export const reviewerById = (id: string) => registered.find((r) => r.id === id);

/** The prompt id of a reviewer's brief. */
export const briefPromptId = (id: string) => `review.${id}`;

/** For tests and, later, the writer's own reviewers: adds one, and gives back a function that removes it. */
export function registerReviewer(r: Reviewer): () => void {
  registered.push(r);
  return () => {
    const i = registered.indexOf(r);
    if (i !== -1) registered.splice(i, 1);
  };
}
