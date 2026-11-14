// A stand-in for the server's file: the server's pure functions behind a small interface, for tests. The browser side
// is `test/browser-tab.ts`.
import { emptyBlock, parseFile, serializeFile, setStatus, type CommentsBlock, type TaskAgent } from "../src/shared/docfile";
import { placeComments, type Proposal } from "../src/server/place";
import { applyPut, pruneFile, recordDiskEdit, type PutRequest, type PutResult } from "../src/server/put";
import { ackTask, finishRun } from "../src/server/suggest";

export class Server {
  src: string;
  constructor(markdown: string) {
    this.src = serializeFile(markdown, emptyBlock());
  }
  get block(): CommentsBlock {
    return parseFile(this.src).block;
  }
  get markdown(): string {
    return parseFile(this.src).markdown;
  }
  comment(id: string) {
    return this.block.comments[id]!;
  }
  put(req: PutRequest): PutResult {
    const r = applyPut(this.src, req);
    if (r.ok) this.src = r.file;
    return r;
  }
  /** A job that read `readMarkdown` and proposes comments; places them in the latest file. */
  job(readMarkdown: string, proposals: (Partial<Proposal> & { quote: string })[]) {
    const r = placeComments(readMarkdown, this.src, proposals.map((p) => ({ thinker: "challenger", title: p.quote, ...p })));
    this.src = r.file;
    return r;
  }
  /** The writer dismisses a comment (a later plan's action endpoint): the server sets the status. */
  dismiss(id: string) {
    const { markdown, block } = parseFile(this.src);
    const next = setStatus(block, id, "dismissed");
    this.src = serializeFile(markdown, { ...next, meta: { ...next.meta, rev: next.meta.rev + 1 } });
  }
  /** The cleanup stage at time `now`: removes orphaned comments older than `keepMs`. Returns the removed ids. */
  prune(now: Date, keepMs = 30_000) {
    const r = pruneFile(this.src, now, keepMs);
    if (r) this.src = r.file;
    return r?.removed ?? [];
  }
  /**
   * A run of the agent on task `id`, as the server does it: acknowledged, then its reply written as a suggestion.
   * `between` plays the writer's save while the run works.
   */
  /** `agent`: the agent kept after the run, recorded with its result (an engine that keeps conversations, Pi). */
  agentRun(id: string, reply: string, between?: () => void, agent?: TaskAgent) {
    const a = ackTask(this.src, id);
    if (!a) throw new Error(`${id} is not waiting`);
    this.src = a.file;
    const page = this.markdown;
    between?.();
    const f = finishRun(this.src, { id, taskType: a.taskType }, page, { reply, ...(agent && { agent }) });
    if (f.file) this.src = f.file;
    return f.outcome;
  }
  handEdit(edit: (markdown: string) => string) {
    const { markdown, block } = parseFile(this.src);
    this.src = recordDiskEdit(serializeFile(edit(markdown), block));
  }
}
