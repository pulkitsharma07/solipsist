import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listComments, parseFile } from "../../shared/docfile";
import { config } from "../config";
import { readModifyWrite, withLock } from "../files";
import { log, why } from "../log";
import { placeComments, type CommentProposal, type PlaceResult } from "../place";
import { promptPath, promptText, renderPrompt } from "../prompts";
import { runOnce } from "../agent/runOnce";
import { imagesDir, pageFile } from "../agent/page";
import { root } from "../runtime";
import { parseChoice, defaultChoice } from "../agent/engines";
import { REVIEW_TOOLS } from "../agent/replyTools";
import { briefPromptId, REVIEWER, type Reviewer } from "./reviewers";
import { readSettings } from "../agent/settings";
import { overBudget } from "../agent/budget";
import type { AgentSession, AgentStep, StartOptions } from "../agent/engine";
import type { AnyReply } from "../suggest";
import { curatorFor } from "./curate";
import { filterCandidates, pickBest, type Judged, type Outcome } from "./pick";

/**
 * A review: the page goes to an agent that has only the `comment` tool, so the one thing
 * it cannot do is write the page. What comes back is filtered, scored, ordered and placed in the margin.
 *
 * The pipeline is `propose → filter → curate → allocate → place`. Only `propose` calls a model here; `curate` is a
 * seam (`curate.ts`) with the no-model curator behind it. Every candidate ends with exactly one `Outcome`, so a
 * reading that raised nothing useful says which stage dropped what.
 */

export interface ReviewResult {
  /** The comments now in the margin. */
  placed: string[];
  /** Comments a better question took the place of. */
  replaced: string[];
  /** Every candidate that did not reach the margin, and the stage that dropped it. */
  judged: Judged[];
  /** What the run cost, when the engine says. */
  costUsd?: number;
  /** Why there was no reading at all. */
  error?: string;
}

/** The questions already on this page, so a review does not raise them twice. */
function alreadyRaised(src: string): string {
  const { block } = parseFile(src);
  const asked = listComments(block)
    .map((c) => `- “${c.anchor.exact.slice(0, 60)}” — ${c.gloss || c.title}`)
    .slice(0, 40);
  return asked.length ? `You have already asked these about this page. Do not raise them again:\n${asked.join("\n")}` : "";
}

/** The review's own instructions: its system prompt, and the one tool it gets. */

/** How far over `review.max_per_review` a call may go before it is sent back rather than trimmed. */
const HARD_SLACK = 9;

/** The images a page's comments may point at: SVG, and the still formats a browser shows in an `<img>`. */
const COMMENT_IMAGE = /^images\/[A-Za-z0-9._/-]+\.(svg|png|gif|webp|jpe?g)$/;

/**
 * Checks a `comment` call while the run is still going, so something the agent got wrong comes back for fixing in
 * the same turn instead of being dropped after the fact: a quote that is not in the page, and a picture that is not
 * where it says it is. Whether a question is any good is the curator's business, and where it goes is
 * `placeComments`'s.
 */
function checkReview(id: string, readSrc: string, max: number) {
  const { markdown } = parseFile(readSrc);
  const folder = imagesDir(id);
  return (reply: AnyReply): string | null => {
    if (reply.kind !== "comments") return "Use the `comment` tool.";
    // Only a runaway is refused. A few over the cap is not worth a round trip: `pickBest` keeps the best `max` and
    // the rest end as `no-room`, which is a better outcome than bouncing a good question for arriving fourth.
    if (reply.comments.length > max + HARD_SLACK) return `That is ${reply.comments.length} questions; raise at most ${max}, the most important ones.`;
    const bad = reply.comments.filter((c) => !markdown.includes(c.quote));
    if (bad.length) {
      return `These quotes are not in the page word for word — copy them exactly from one block, or ask about something else: ${bad.map((c) => `“${c.quote.slice(0, 60)}”`).join(", ")}`;
    }
    // A picture has to be a file you actually wrote, in the one folder you may write in, named the way the page
    // writes it. Checked here so you can fix the path or draw the file, in this turn.
    for (const c of reply.comments) {
      if (!c.image) continue;
      // The page's folder is what its links are relative to, so the folder part is the page's file name, not its whole id.
      if (!COMMENT_IMAGE.test(c.image) || !c.image.startsWith(`images/${basename(id)}/`)) return `“${c.image}” is not a path this page can show: write it as \`images/${basename(id)}/<short-kebab-name>.svg\`, in the image folder your prompt names.`;
      if (!existsSync(join(folder, basename(c.image)))) return `There is no file at “${c.image}”: draw the SVG in ${folder} first, then give its path, or leave \`image\` out.`;
    }
    return null;
  };
}

/**
 * What a review needs run for it: the prompt, the in-turn check, and the instructions the agent starts with. The
 * reading itself does not run anything — whoever owns the page's agents does (`PageAgents.read`), so a review is
 * one of the page agent's jobs: its steps go to the page's stream, it takes a run slot, and stopping the page's
 * agents stops it. `runReview` below is the standalone driver, for the smoke script and the tests.
 */
export interface ReviewSpec {
  prompt(): string;
  check(reply: AnyReply): string | null;
  start: Pick<StartOptions, "system" | "replyTools"> & Pick<Partial<StartOptions>, "readable">;
  timeoutMs: number;
}

/** What a driver gives back: the agent's reply, or why there was none. */
export interface ReviewRun { ok: boolean; reply?: AnyReply; costUsd?: number; error?: string; /** The `engine:model` it ran on, for the questions to record. */ model?: string }
export type ReviewDriver = (id: string, spec: ReviewSpec) => Promise<ReviewRun>;

/** The review's spec for this page, as it is right now. */
export function reviewSpec(id: string, src: string, max: number, reviewer: Reviewer = REVIEWER): ReviewSpec {
  const { markdown } = parseFile(src);
  return {
    start: { system: promptText(briefPromptId(reviewer.id)), replyTools: REVIEW_TOOLS, readable: [promptPath("images")] },
    prompt: () => renderPrompt("review", { id, file: pageFile(id), images: imagesDir(id), imageLink: basename(id), page: markdown, max: String(max), raised: alreadyRaised(src) }),
    check: checkReview(id, src, max),
    timeoutMs: config().agent.run_timeout_ms,
  };
}

/**
 * The standalone driver: one agent of its own, started and closed for this reading. Used where there is no page
 * agent to hand the job to — `scripts/review-smoke.ts` and the tests.
 */
export const runReview: ReviewDriver = async (id, spec) => {
  const choice = parseChoice(readSettings(id).model) ?? parseChoice(defaultChoice());
  if (!choice) return { ok: false, error: "No engine can run now." };
  const unavailable = choice.engine.unavailable();
  if (unavailable) return { ok: false, error: unavailable };

  const scratch = mkdtempSync(join(tmpdir(), "solip-read-"));
  const steps: AgentStep[] = [];
  // `runOnce` drops an agent it won't keep but leaves closing it to whoever asked: a review keeps none, so every
  // agent it starts is closed here, exactly once.
  let started: AgentSession | undefined;
  try {
    const report = await runOnce({
      id,
      choice: { engine: choice.engine, model: choice.model },
      start: spec.start,
      prompt: spec.prompt,
      workspace: () => ({ file: pageFile(id), images: imagesDir(id), root: root(), scratch }),
      timeoutMs: spec.timeoutMs,
      check: spec.check,
      onStep: (s) => { steps.push(s); },
      onPhase: (p) => { if (p.at === "started") started = p.session; return null; },
      stopped: () => false,
    });
    await started?.close().catch(() => {});
    return { ...reviewRunOf(report.res, steps), model: choice.choice };
  } catch (e: any) {
    return { ok: false, error: why(e) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** A run's result as a review reads it: the questions, or why there were none. Shared by both drivers. */
export function reviewRunOf(res: { ok: boolean; reply?: AnyReply; result?: string; costUsd?: number; error?: string }, steps: AgentStep[] = []): ReviewRun {
  if (!res.ok) return { ok: false, costUsd: res.costUsd, error: res.error ?? "The review failed." };
  if (!res.reply || res.reply.kind !== "comments") {
    const said = steps.filter((s) => s.kind === "error").map((s) => s.text).join("; ");
    return { ok: false, costUsd: res.costUsd, error: said || "The review ended without calling `comment`." };
  }
  return { ok: true, reply: res.reply, costUsd: res.costUsd };
}

/**
 * One review of one page, start to finish: the gates, the model call through `drive`, then the free stages and
 * placement. `drive` is normally the page agent's (`PageAgents.read`), which is what puts the review in the page's
 * stream and under its limits; it falls back to a standalone agent where there is no page agent to ask.
 */
export async function reviewPage(id: string, drive: ReviewDriver = runReview, reviewer: Reviewer = REVIEWER): Promise<ReviewResult> {
  const cfg = config().review;
  const out: Judged[] = [];
  const done = (r: Partial<ReviewResult>): ReviewResult => ({ placed: [], replaced: [], judged: out, ...r });

  if (!cfg.on) return done({ error: "Page review is off (`review.on`)." });
  if (overBudget()) return done({ error: "The cost limit has been reached: no new runs." });

  let src: string;
  try { src = readFileSync(pageFile(id), "utf8"); } catch { return done({ error: "No such page." }); }

  const asked = await drive(id, reviewSpec(id, src, cfg.max_per_review, reviewer));
  if (!asked.ok || !asked.reply) return done({ costUsd: asked.costUsd, error: asked.error ?? "The review failed." });
  const candidates = asked.reply.kind === "comments" ? asked.reply.comments : [];
  log("review.proposed", { page: id, comments: candidates.length, costUsd: asked.costUsd });

  // Free checks before the one that costs: a long gloss is not the note we asked for.
  const filtered = filterCandidates(candidates, cfg.max_gloss_words);
  out.push(...filtered.out);

  const { curator, fellBack } = curatorFor(cfg.curator);
  if (fellBack) log("review.curator", { page: id, note: fellBack });
  const scored = await curator.score(parseFile(src).markdown, filtered.kept);

  const picked = pickBest(scored, cfg.max_per_review, Math.max(cfg.min_score, curator.threshold));
  out.push(...picked.out);

  if (!picked.kept.length) {
    log("review.done", { page: id, placed: 0, outcomes: tally(out) });
    return done({ costUsd: asked.costUsd });
  }

  // The page may have moved on while the agent was reading: placement anchors against the latest file, inside the lock.
  const proposals = picked.kept.map((c) => ({ ...c, thinker: reviewer.id, ...(asked.model && { model: asked.model }) }));
  const result = await withLock(id, () => readModifyWrite(id, (latest) => {
    if (latest === null) return { result: null as PlaceResult | null };
    const r = placeComments(src, latest, proposals, new Date(), { minKept: cfg.min_kept, perBlock: cfg.kept_per_block });
    return { file: r.placed.length || r.replaced.length ? r.file : undefined, result: r };
  })).catch((e: any) => { log("review.failed", { page: id, error: why(e) }); return null; });

  if (!result) return done({ costUsd: asked.costUsd, error: "The page couldn't be written." });

  // `placeComments` takes the proposals in order, so each one was either dropped with a reason or is the next id placed.
  let next = 0;
  for (const c of proposals) {
    const dropped = result.dropped.find((d) => d.quote === c.quote);
    if (dropped) out.push({ ...c, outcome: dropped.reason });
    else { next++; out.push({ ...c, outcome: "shown" }); }
  }
  if (next !== result.placed.length) log("review.mismatch", { page: id, counted: next, placed: result.placed.length });
  log("review.done", { page: id, placed: result.placed.length, replaced: result.replaced.length, outcomes: tally(out), costUsd: asked.costUsd });
  return done({ placed: result.placed, replaced: result.replaced, costUsd: asked.costUsd });
}

const tally = (judged: Judged[]) =>
  judged.reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.outcome]: (acc[j.outcome] ?? 0) + 1 }), {});

export type { Judged, Outcome };
