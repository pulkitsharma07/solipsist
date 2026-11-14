import { Type, type Static } from "@earendil-works/pi-ai";
import type { AnyReply } from "../suggest";

/**
 * The reply tools: an agent gives its result by calling one, instead of writing the
 * text envelope (the `protocol.envelope` prompt) at the end of its reply. Each call is checked against the page when it is made, so
 * one that can't be used gets its error back in the same turn and the agent can fix it; one that can ends the run.
 * Engine-neutral: a name, a description, a JSON schema (TypeBox) and what the call means as a `Reply`. An engine
 * offers them when `StartOptions.replyTools` is set (Pi, `engines/pi.ts`). The envelope still works without them.
 */

const Edit = Type.Object({
  before: Type.String({ description: "Whole top-level blocks of the page as they are now, copied exactly from the file, appearing once; never the blocks that hold your marker." }),
  after: Type.String({ description: "The markdown that replaces them; empty to delete them." }),
});

const suggestParams = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("at"), Type.Literal("replace"), Type.Literal("after")], { description: "Where the result goes: `at` a point, `replace` a range's text, or `after` it. Leave out with `markdown` when only `edits` change the page." })),
  place: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("blocks")], { description: "`inline`: text inside the line, one paragraph at most. `blocks`: whole blocks." })),
  markdown: Type.Optional(Type.String({ description: "The markdown to put there, exactly as it should appear in the page, no fence around it. Empty with `replace` deletes the range's text." })),
  edits: Type.Optional(Type.Array(Edit, { description: "Changes to other top-level blocks of the page, applied with the result when the writer accepts it." })),
  note: Type.Optional(Type.String({ description: "One short line for the writer: what you did." })),
});
const answerParams = Type.Object({
  answer: Type.String({ description: "Your answer to the writer's question about the text, in markdown. Nothing goes in the page." }),
  note: Type.Optional(Type.String({ description: "One short line for the writer." })),
});
const declineParams = Type.Object({
  reason: Type.String({ description: "Why you won't or can't, in one short line for the writer: shown beside the task. Say what stopped you, and what they could add for you to do it." }),
});

const Comment = Type.Object({
  quote: Type.String({ description: "The passage this question is about, copied word for word from one block of the page: one paragraph, list item, heading or table cell. Never paraphrased, never spanning two blocks." }),
  title: Type.String({ description: "The question itself, as a whole sentence of at least six words, e.g. \"What does 'significant' mean here?\". Never a label or a single word." }),
  gloss: Type.String({ description: "The same point as a margin note of two to five words, the way a reader pencils it beside the passage, e.g. \"what lives in 'almost'?\". Lowercase, no full stop." }),
  body: Type.Optional(Type.String({ description: "The point in fewer than 20 words." })),
  // Required in the schema, which is what the model reads, but not in `toReply`: a weak model that leaves it out
  // still gets its question through rather than looping on a retry.
  description: Type.String({ description: "Why you think this: the reasoning behind it, in two to four sentences, in your own voice, addressed to the writer. Say what made you ask, not what they should write." }),
  importance: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("low")], { description: "Whether the writer should see this before the others." })),
  image: Type.Optional(Type.String({ description: "A picture for this question, when one says it better than the words do: a diagram of the structure you are describing, the shape of an argument, two options side by side, a timeline that shows the gap. Draw it as an SVG in the image folder your prompt names, follow the image guide, and give the path here as the page would write it — `images/<page id>/<short-kebab-name>.svg`. It may animate (SMIL or CSS inside the SVG; no scripts), which is worth it only to show a change or a sequence. Leave it out unless the picture genuinely adds something: most questions do not need one." })),
  score: Type.Optional(Type.Number({ description: "How worth the writer's attention this is, 0 (not worth raising) to 10 (they should see it before anything else)." })),
});
const commentParams = Type.Object({
  comments: Type.Array(Comment, { description: "The questions you are raising, most important first. An empty list means the page raised nothing worth asking about." }),
});

export interface ReplyTool<P = any> {
  name: string;
  label: string;
  description: string;
  parameters: any;
  /** What a call with these arguments says, or why it says nothing usable. */
  toReply(params: P): AnyReply | { error: string };
}

const suggest: ReplyTool<Static<typeof suggestParams>> = {
  name: "suggest",
  label: "Suggest",
  description: "Give your result for your task: the markdown and where it goes, changes to other blocks, or both. The writer sees it as a suggestion to accept or reject. Call it once you're done; it ends your turn. If it returns an error, fix the call and make it again.",
  parameters: suggestParams,
  toReply: (p) => {
    const edits = p.edits?.length ? p.edits : undefined;
    if (p.markdown === undefined && !edits) return { error: "Give `markdown` (with `mode` and `place`), `edits`, or both." };
    if (p.markdown !== undefined && (!p.mode || !p.place)) return { error: "`markdown` needs a `mode` and a `place`." };
    return {
      kind: "suggestion",
      ...(p.markdown !== undefined && { mode: p.mode!, place: p.place!, suggestion: p.markdown }),
      ...(edits && { edits }),
      ...(p.note?.trim() && { note: p.note.trim() }),
    };
  },
};
const answer: ReplyTool<Static<typeof answerParams>> = {
  name: "answer",
  label: "Answer",
  description: "Answer the writer's question about the text, instead of changing it: shown beside the text, put in nothing. It ends your turn.",
  parameters: answerParams,
  toReply: (p) => (p.answer.trim() ? { kind: "answer", answer: p.answer.trim(), ...(p.note?.trim() && { note: p.note.trim() }) } : { error: "The answer is empty." }),
};
const decline: ReplyTool<Static<typeof declineParams>> = {
  name: "decline",
  label: "Decline",
  description: "Decline your task, with the reason. Not for a request about other blocks: use `suggest` with `edits`. It ends your turn.",
  parameters: declineParams,
  toReply: (p) => (p.reason.trim() ? { kind: "decline", note: p.reason.trim() } : { error: "Give a reason." }),
};

/**
 * Page Review's only tool: it raises questions about the page and has no `suggest`, so it
 * cannot put text in the page at all. One call carries every question of the review and ends the turn, the way
 * `suggest` does; the run's `check` validates all the quotes at once, so bad ones come back for fixing in the same turn.
 */
const comment: ReplyTool<Static<typeof commentParams>> = {
  name: "comment",
  label: "Comment",
  description: "Raise your questions about the writer's page: each one quotes the passage it is about. They appear in the margin beside those passages; nothing you say goes into the page. Call it once, with every question you are raising; it ends your turn. If it returns an error, fix the call and make it again.",
  parameters: commentParams,
  toReply: (p) => {
    const comments = (p.comments ?? []).map((c) => ({
      ...c,
      quote: c.quote?.trim() ?? "",
      title: c.title?.trim() ?? "",
      gloss: c.gloss?.trim() ?? "",
      body: c.body?.trim() || undefined,
      description: c.description?.trim() || undefined,
    }));
    const bad = comments.findIndex((c) => !c.quote || !c.title || !c.gloss);
    if (bad !== -1) return { error: `Comment ${bad + 1} is missing a quote, a title or a gloss.` };
    return { kind: "comments", comments };
  },
};

/** The tools a task's run gives its result with. */
export const REPLY_TOOLS: readonly ReplyTool[] = [suggest, answer, decline];
/** The tools a review gets instead: questions only, and no way to write the page. */
export const REVIEW_TOOLS: readonly ReplyTool[] = [comment];
/** Every tool any run may offer, for the engines that recognise their own calls in a stream. */
export const ALL_TOOLS: readonly ReplyTool[] = [...REPLY_TOOLS, ...REVIEW_TOOLS];

/** The set a run asked for (`StartOptions.replyTools`): `true` means the task tools. */
export const toolsOf = (want: boolean | readonly ReplyTool[] | undefined): readonly ReplyTool[] | undefined =>
  want === true ? REPLY_TOOLS : want || undefined;

/** What an engine's reply tools share with the run in flight: its check, and the reply the last call that counted gave. */
export interface Turn { check?: (r: AnyReply) => string | null; reply?: AnyReply }

/**
 * A call to a reply tool, checked: the `Reply`, or the error the agent should see. `check` is the run's own check
 * (against the page it read); without one, every well-formed call counts.
 */
export function callReplyTool(tool: ReplyTool, params: unknown, check?: (r: AnyReply) => string | null): { reply: AnyReply } | { error: string } {
  const r = tool.toReply(params);
  if ("error" in r) return r;
  const why = check?.(r);
  return why ? { error: why } : { reply: r };
}
