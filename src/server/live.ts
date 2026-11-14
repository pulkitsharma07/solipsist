import { config } from "./config";
import { hash, listPages, readPage, readModifyWrite, withLock } from "./files";
import { parseFile, docText, markdownToDoc } from "../shared/docfile";
import { placeComments, type Proposal } from "./place";
import { nextOrphanExpiry } from "../shared/docfile";
import { pruneFile } from "./put";
import { nextSuggestionExpiry } from "./suggest";
import { onPageChanged, runtime } from "./runtime";

/** Lets a burst of writes settle; the lower, the sooner a comment reaches the browser. */
const PUSH_DEBOUNCE_MS = 30;

export interface Sub { send(chunk: string): void; lastRev: number }

/** Long-lived state, kept on globalThis so `bun --hot` doesn't lose the tabs. */
interface Live {
  sweeps: Map<string, Timer>; subs: Map<string, Set<Sub>>; pushed: Map<string, string>; timers: Map<string, Timer>; mock?: Timer;
  /** Stops pushing the current runtime's writes (`startPushing`), and which runtime that is. */
  stopPush?: () => void;
  pushRuntime?: object;
}
const live: Live = ((globalThis as any).__solipLive ??= {} as Live);
// State from an earlier version of this module (a `bun --hot` reload) may lack newer fields.
live.subs ??= new Map();
live.pushed ??= new Map();
live.timers ??= new Map();
live.sweeps ??= new Map();

const frame = (event: string, data: unknown, id?: number) =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const fileFrame = (src: string) => { const rev = parseFile(src).block.meta.rev; return frame("file", { rev, file: src }, rev); };

/** Sends a file to each subscriber that hasn't already been sent that rev (or a newer one). */
export function broadcastFile(id: string, src: string) {
  const rev = parseFile(src).block.meta.rev;
  for (const s of live.subs.get(id) ?? []) {
    if (rev <= s.lastRev) continue;
    s.lastRev = rev;
    s.send(fileFrame(src));
  }
}

const keepMs = () => config().comments.orphan_keep_ms;

/** The cleanup stage: when a page has orphaned comments or decided suggestions, clear them out once they are old enough. */
function scheduleSweep(id: string, src: string) {
  clearTimeout(live.sweeps.get(id));
  live.sweeps.delete(id);
  const { block } = parseFile(src);
  const dues = [nextOrphanExpiry(block, keepMs()), nextSuggestionExpiry(block, keepMs())].filter((d): d is number => d !== null);
  if (!dues.length) return;
  const due = Math.min(...dues);
  const timer = setTimeout(() => { live.sweeps.delete(id); sweep(id).catch(console.error); }, Math.max(0, due - Date.now()) + 5);
  timer.unref?.();
  live.sweeps.set(id, timer);
}

async function sweep(id: string) {
  await withLock(id, () =>
    readModifyWrite(id, (src) => {
      if (src === null) return { result: undefined };
      const r = pruneFile(src, new Date(), keepMs());
      if (!r) scheduleSweep(id, src);
      return { file: r?.file, result: undefined }; // a written file is pushed, which schedules the next sweep
    }));
}

/** Pushes page `id` to its tabs after the writes in hand have settled, replacing a push already waiting. */
function pushLater(id: string) {
  clearTimeout(live.timers.get(id));
  live.timers.set(id, setTimeout(() => { live.timers.delete(id); push(id).catch(console.error); }, PUSH_DEBOUNCE_MS));
}

/** Page `id` was written: its tabs get the file, and its next sweep is planned. Only the server writes pages. */
async function push(id: string) {
  await withLock(id, async () => {
    const src = await readModifyWrite(id, (src) => ({ result: src }));
    if (src === null) return;
    scheduleSweep(id, src);
    if (live.pushed.get(id) === hash(src)) return;
    live.pushed.set(id, hash(src));
    broadcastFile(id, src);
  });
}

/**
 * Pushes every page the server writes to its tabs, once per runtime. A `bun --hot` reload replaces the listener, so the
 * new code handles the writes. The first call also plans the sweep of pages that already have something to clear.
 */
export function startPushing() {
  const rt = runtime();
  if (live.pushRuntime === rt) return;
  live.stopPush?.();
  live.pushRuntime = rt;
  live.stopPush = onPageChanged(pushLater);
  void listPages().then((docs) => Promise.all(docs.map(async (d) => { const src = await readPage(d.id); if (src !== null) scheduleSweep(d.id, src); }))).catch(console.error);
}

export async function events(req: Request & { params: Record<string, string> }, server: { timeout(r: Request, s: number): void }) {
  const id = req.params.id!;
  const src = await withLock(id, () => readPage(id));
  if (src === null) return Response.json({ error: { code: "not_found", message: "No such document." } }, { status: 404 });
  // One live tab per page: a second one is refused, so two tabs never fight over the body.
  if (live.subs.get(id)?.size) {
    return Response.json({ error: { code: "already_open", message: "This page is open in another tab." } }, { status: 409 });
  }
  server.timeout(req, 0);
  startPushing();
  const enc = new TextEncoder();
  let sub: Sub, ping: Timer;
  const stream = new ReadableStream({
    start(c) {
      sub = { lastRev: -1, send: (s) => { try { c.enqueue(enc.encode(s)); } catch {} } };
      const set = live.subs.get(id) ?? live.subs.set(id, new Set()).get(id)!;
      set.add(sub);
      sub.send("retry: 2000\n\n");
      const rev = parseFile(src).block.meta.rev;
      sub.lastRev = rev;
      if (req.headers.get("last-event-id") !== String(rev)) sub.send(fileFrame(src));
      ping = setInterval(() => sub.send(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        set.delete(sub);
        if (!set.size) live.subs.delete(id);
        try { c.close(); } catch {}
      });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}

/** Adds one mock comment on a random sentence of the page; the write pushes the result. */
export function addMockComment(id: string) {
  return withLock(id, () => readModifyWrite(id, (src) => {
    if (src === null) return { result: null };
    const { markdown } = parseFile(src);
    const sentences = docText(markdownToDoc(markdown)).text.split("\n")
      .flatMap((l) => l.match(/[^.!?]+[.!?]?/g) ?? []).map((s) => s.trim())
      .filter((s) => s.length >= 12 && s.split(/\s+/).length >= 3)
      .sort(() => Math.random() - 0.5);
    for (const quote of sentences) {
      const r = placeComments(markdown, src, [{ quote, title: "Mock comment", gloss: "A generated note", body: `Is "${quote.slice(0, 40)}" what you mean?`, importance: "low", thinker: "mock" }]);
      if (r.placed.length) return { file: r.file, result: r.placed[0]! };
    }
    return { result: null };
  }));
}

/** Dev only: places comments proposed from outside (a script, another model) on the page, as the job would. */
export function addComments(id: string, proposals: Omit<Proposal, "thinker">[]) {
  return withLock(id, () => readModifyWrite(id, (src) => {
    if (src === null) return { result: null };
    const { markdown } = parseFile(src);
    const r = placeComments(markdown, src, proposals.map((p) => ({ ...p, thinker: "agent" })));
    return { file: r.placed.length ? r.file : undefined, result: { placed: r.placed, dropped: r.dropped } };
  }));
}

/** `dev.mock_comments`: every `dev.mock_interval_ms`, one mock comment on each page someone is watching. */
export function startMockGenerator() {
  clearInterval(live.mock);
  if (!config().dev.mock_comments) return;
  live.mock = setInterval(() => { for (const id of live.subs.keys()) addMockComment(id).catch(console.error); }, config().dev.mock_interval_ms);
}
