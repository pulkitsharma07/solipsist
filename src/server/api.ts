import { resolve, sep } from "node:path";
import { addFiles, isUnsynced, newPage, reloadPage, setupView, storedImage, syncPage } from "./project";
import { emptyBlock, parseFile, serializeFile } from "../shared/docfile";
import { listPages as list, NewerPageError, readPage, readModifyWrite, validId, withLock, writePage } from "./files";
import { addComments as addLiveComments, addMockComment } from "./live";
import { applyPut, type PutRequest } from "./put";
import { config, configView } from "./config";
import { pagesDir, pageChanged, root as projectRoot } from "./runtime";
import { log, why } from "./log";
import { getPrompt, listPrompts, PromptError, resetPrompt, savePrompt } from "./prompts";
import { answer as answerSupport, noteSave, supportView } from "./support";
import { reviewPage, type Judged } from "./review";
import { pageAgents } from "./agent/pageAgents";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

type Req = Request & { params: Record<string, string> };

export const listPages = async () => {
  const docs = await list();
  return json(await Promise.all(docs.map(async (d) => ({ ...d, unsynced: await isUnsynced(d.id, (await readPage(d.id)) ?? "") }))));
};

export const getSetup = async () => json(await setupView());

export async function postSetup(req: Request) {
  const body = (await req.json().catch(() => null)) as { paths?: unknown } | null;
  if (!Array.isArray(body?.paths) || body.paths.some((p) => typeof p !== "string")) return fail(400, "bad_request", "paths are required.");
  return json(await addFiles(body.paths as string[]));
}

export async function getSync(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const src = await readPage(id);
  if (src === null) return fail(404, "not_found", "No such document.");
  return json({ unsynced: await isUnsynced(id, src) });
}

export async function postSync(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const force = !!((await req.json().catch(() => null)) as { force?: unknown } | null)?.force;
  const r = await syncPage(id, force);
  return r.ok ? json(r) : fail(r.code === "not_found" ? 404 : 409, r.code, "The page wasn't synced.");
}

export async function postReload(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const discard = !!((await req.json().catch(() => null)) as { discard?: unknown } | null)?.discard;
  const r = await reloadPage(id, discard);
  return r.ok ? json(r) : fail(r.code === "not_found" ? 404 : 409, r.code, "The page wasn't reloaded.");
}

/** A new page is a new `.md` in the project, at the path the writer gave: there is nowhere else for it to go. */
export async function createPage(req?: Request) {
  const path = ((await req?.json().catch(() => null)) as { path?: unknown } | null)?.path;
  const made = typeof path === "string" ? await newPage(path) : null;
  if (!made) return fail(400, "bad_path", "That path can't be used for a new page.");
  log("page.create", { page: made });
  return json({ id: made }, 201);
}

export async function getPage(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const src = await withLock(id, () => readModifyWrite(id, (src) => ({ result: src })));
  if (src === null) return fail(404, "not_found", "No such document.");
  return json({ rev: parseFile(src).block.meta.rev, file: src, path: `${id}.md` });
}

export async function putPage(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  let body: PutRequest;
  try {
    body = (await req.json()) as PutRequest;
  } catch {
    return fail(400, "bad_json", "Body is not JSON.");
  }
  if (typeof body?.client_id !== "string" || typeof body.base_rev !== "number" || typeof body.markdown !== "string") {
    return fail(400, "bad_request", "client_id, base_rev and markdown are required.");
  }
  body.comments ??= {};
  let result: ReturnType<typeof applyPut> | null;
  try {
    result = await withLock(id, () =>
      readModifyWrite(id, (src) => {
        if (src === null) return { result: null };
        const r = applyPut(src, body);
        return { file: r.ok ? r.file : undefined, result: r };
      }));
  } catch (e) {
    if (e instanceof NewerPageError) throw e; // the routes say so (423): retrying wouldn't help
    // The file couldn't be written (a full disk, no permission, or it kept changing under the write): the tab retries.
    log("page.save_failed", { page: id, base: body.base_rev, message: why(e) });
    return fail(500, "write_failed", `The page couldn't be saved: ${why(e)}`);
  }
  if (result === null) return fail(404, "not_found", "No such document.");
  if (!result.ok) {
    log("page.save_refused", { page: id, base: body.base_rev, rev: result.rev, code: result.code });
    return json({ error: { code: result.code, message: "The page was changed elsewhere." }, rev: result.rev, file: result.file }, 409);
  }
  noteSave();
  const decisions = Object.keys(body.decisions ?? {});
  log("page.save", { page: id, rev: result.rev, base: body.base_rev, chars: body.markdown.length, ...(decisions.length && { decisions: body.decisions }) });
  return json({ rev: result.rev, file: result.file });
}

/** For the browser tests, which write a page from another process: says that it changed. */
export function pageTouched(req: Req) {
  pageChanged(req.params.id!);
  return new Response(null, { status: 204 });
}

/**
 * One review of the page: the agent raises questions, which become margin comments. Nothing is written into the
 * body, so there is no suggestion to accept.
 *
 * The page's own agents do the work (`PageAgents.read`), so the review is in their stream — the writer watches it
 * step by step in the agent panel — and under their limits and their stop. A page nobody has open has no agents, so
 * there is nothing to show it in and nothing to stop it: that one is read by an agent of its own.
 */
export async function startReview(req: Req) {
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const page = pageAgents(id);
  const r = page ? await page.read() : await reviewPage(id);
  if (r.error && !r.placed.length) return fail(502, "read_failed", r.error);
  return json({ placed: r.placed, replaced: r.replaced, dropped: r.judged.map((j: Judged) => ({ quote: j.quote, outcome: j.outcome })), costUsd: r.costUsd });
}

export async function mockComment(req: Req) {
  if (process.env.NODE_ENV === "production") return fail(404, "not_found", "Dev only.");
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const placed = await addMockComment(id);
  return placed ? json({ id: placed }) : fail(404, "nothing_placed", "No such document, or nowhere to put a comment.");
}

/** Dev only. Body: `{ comments: [{ quote, title, gloss?, body?, importance? }] }`. Same placement rules as the job. */
export async function addComments(req: Req) {
  if (process.env.NODE_ENV === "production") return fail(404, "not_found", "Dev only.");
  const { id } = req.params;
  if (!validId(id)) return fail(400, "bad_id", "Invalid document id.");
  const body = (await req.json().catch(() => null)) as { comments?: { quote?: unknown; title?: unknown }[] } | null;
  const list = body?.comments;
  if (!Array.isArray(list) || !list.every((c) => typeof c?.quote === "string" && typeof c.title === "string")) {
    return fail(400, "bad_request", "Expected { comments: [{ quote, title, gloss?, body?, importance? }] }.");
  }
  const result = await addLiveComments(id, list as never);
  return result ? json(result) : fail(404, "not_found", "No such document.");
}

/** Whoever can change a prompt steers agents that run commands: only a request from this machine may. */
type Peer = { requestIP(req: Request): { address: string } | null };
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const notLocal = (req: Request, srv?: Peer) => (LOOPBACK.has(srv?.requestIP(req)?.address ?? "") ? null : fail(403, "local_only", "Prompts can be read and changed only from the machine the server runs on."));

/** The settings in effect, for the settings dialog (a secret is only ever "set"). Local only: it shows paths. */
export const getConfig = (req: Request, srv?: Peer) => notLocal(req, srv) ?? json(configView(config()));

/** The prompts: each with its text now, its default, its slots, and whether the writer has changed it. */
export const getPrompts = (req: Request, srv?: Peer) => notLocal(req, srv) ?? json({ dir: config().prompts.dir, prompts: listPrompts() });

export async function putPrompt(req: Req, srv?: Peer) {
  const refused = notLocal(req, srv);
  if (refused) return refused;
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "bad_body", "Body must be JSON."); }
  try {
    const p = savePrompt(req.params.id!, body?.text);
    log("prompt.save", { id: p.id, custom: p.custom });
    return json(p);
  } catch (e) {
    if (e instanceof PromptError) return fail(e.status, e.status === 404 ? "not_found" : "bad_prompt", e.message);
    throw e;
  }
}

export function resetPromptRoute(req: Req, srv?: Peer) {
  const refused = notLocal(req, srv);
  if (refused) return refused;
  if (!getPrompt(req.params.id!)) return fail(404, "not_found", `There is no prompt "${req.params.id}".`);
  const p = resetPrompt(req.params.id!);
  log("prompt.reset", { id: p.id });
  return json(p);
}

export const getSupport = () => json(supportView());

/** Body `{ action: "later" | "paid" }`: the writer's answer to the strip. */
export async function postSupport(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (body?.action !== "later" && body?.action !== "paid") return fail(400, "bad_request", 'Expected { action: "later" | "paid" }.');
  answerSupport(body.action);
  log("support.answer", { action: body.action });
  return json(supportView());
}

export const notImplemented = () => fail(501, "not_implemented", "Not implemented yet.");



/** What a page may show. A project's folder holds its secrets too, so nothing else is served from it. */
const ASSET_TYPES = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|mp4|webm|mov|pdf)$/i;

/**
 * Sent with every asset. An SVG is a document that can hold scripts: in an `<img>` they never run, but opened on its
 * own it would be a page on the app's origin, able to use every route. `sandbox` gives it an origin of its own and no
 * scripts, `default-src 'none'` lets it load nothing, and `nosniff` keeps a file to the type its name says.
 */
const ASSET_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
};

/** The images a page links to, relative to it: never a page, a dot-path or anything outside the folder. */
export const assetFile = async (req: Request) => {
  const path = decodeURIComponent(new URL(req.url).pathname.replace(/^\/api\/assets\//, ""));
  const base = resolve(projectRoot());
  const inside = resolve(base, path);
  if (!inside.startsWith(base + sep) || !ASSET_TYPES.test(path) || path.split("/").some((s) => s.startsWith("."))) return fail(400, "bad_path", "Bad path.");
  const f = Bun.file(storedImage(path) || inside);
  return (await f.exists()) ? new Response(f, { headers: ASSET_HEADERS }) : fail(404, "not_found", "No such file.");
};
