import { isPageId } from "../shared/ids";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { blockSizes, emptyBlock, FORMAT, formatOf, parseFile, serializeFile, type CommentsBlock } from "../shared/docfile";
import { recordDiskEdit } from "./put";
import { config } from "./config";
import { log } from "./log";
import { pagesDir, pageChanged } from "./runtime";

export const validId = isPageId;

const pathOf = (id: string) => join(pagesDir(), `${id}.md`);

/**
 * One per process, not one per copy of this module, so kept on globalThis: `bun --hot` runs this file again, while a
 * page's agents built before the reload go on calling the old copy. With a map each, every write by one copy reads as an
 * outside edit to the other, which records it and writes, and the two never stop.
 */
interface Kept {
  /** The last hash this process wrote per document, so a hand edit can be told from our own write. */
  written: Map<string, string>;
  /** The last comments block per document that read fine, so a broken one can be replaced by it rather than by nothing. */
  goodBlocks: Map<string, CommentsBlock>;
  /** How many times each document's block was found broken and replaced: the agent reports a run that broke it. */
  repairs: Map<string, number>;
  /** Per-document promise chain around every read-modify-write. */
  chains: Map<string, Promise<unknown>>;
}
const kept: Kept = ((globalThis as any).__solipFiles ??= { written: new Map(), goodBlocks: new Map(), repairs: new Map(), chains: new Map() });
export const { written, repairs } = kept;
const { goodBlocks, chains } = kept;
export const hash = (src: string) => Bun.hash(src).toString(36);

export async function readPage(id: string): Promise<string | null> {
  try {
    return await readFile(pathOf(id), "utf8");
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Tests only: runs between writing the temp file and the rename, to play an outside writer racing the server. */
export const testHooks: { beforeRename?: (id: string) => void | Promise<void> } = {};

/**
 * Temp file + rename, so a crash leaves the old file or the new one, never a torn one. With `expected` (null: no file),
 * the file must still hold what the caller read just before the rename; otherwise nothing is written and the result is
 * false. Use `readModifyWrite`, which retries.
 */
export async function writePage(id: string, src: string, expected?: string | null): Promise<boolean> {
  await mkdir(dirname(pathOf(id)), { recursive: true });
  const tmp = `${pathOf(id)}.${process.pid}.tmp`;
  await writeFile(tmp, src);
  await testHooks.beforeRename?.(id);
  if (expected !== undefined && (await readPage(id)) !== expected) {
    await rm(tmp, { force: true });
    return false;
  }
  written.set(id, hash(src));
  const { block, problem } = parseFile(src);
  if (!problem) goodBlocks.set(id, block);
  await rename(tmp, pathOf(id));
  // Said at once: the watcher would say it too, a moment later (and only while it runs).
  pageChanged(id);
  return true;
}

/**
 * A broken comments block: keeps the original aside as `<id>.md.bad-block` and returns its body with the last good
 * block this server saw for the page (an empty one if it saw none). Writes nothing else: the caller writes the result.
 */
export async function repairBadBlock(id: string, src: string): Promise<string> {
  const parsed = parseFile(src);
  if (parsed.problem !== "bad-block") {
    goodBlocks.set(id, parsed.block);
    return src;
  }
  await writeFile(`${pathOf(id)}.bad-block`, src);
  repairs.set(id, (repairs.get(id) ?? 0) + 1);
  log("page.bad_block", { page: id, kept: `${id}.md.bad-block` });
  return serializeFile(parsed.markdown, goodBlocks.get(id) ?? emptyBlock());
}

/**
 * The file as the server builds on it: as read when this process wrote it last; otherwise someone outside wrote it (the
 * agent, a hand edit, or it predates this process), so its block is repaired and it is recorded as a body change by
 * "disk" before anything is built on it. Waiting for the watcher would leave a window in which a save overwrites it.
 */
async function adoptOutsideEdit(id: string, raw: string): Promise<string> {
  if (hash(raw) === written.get(id)) return raw;
  const adopted = recordDiskEdit(await repairBadBlock(id, raw));
  if (adopted !== raw) log("page.outside_edit", { page: id });
  return adopted;
}

const MAX_ATTEMPTS = 5;

/**
 * A write to a page saved by a newer Solipsist (`FORMAT`): refused, so a build that doesn't know its format never
 * rewrites it. The routes answer it with 423 and this message (`routes.ts`); the page shows it read-only.
 */
export class NewerPageError extends Error {
  constructor(readonly page: string, readonly format: number) {
    super(`This page was saved by a newer Solipsist (page format ${Number.isFinite(format) ? format : "unknown"}; this one knows up to ${FORMAT}). Update Solipsist to edit it.`);
  }
}

/**
 * A read-modify-write that never overwrites an edit it didn't read. Writers outside the server (the agent, a hand edit)
 * don't take the lock, so one may write before the read, or between the read and the rename. The first is recorded
 * before `fn` runs (`adoptOutsideEdit`); for the second the write is dropped and `fn` runs again on the new file. Call
 * inside `withLock`.
 *
 * `fn` gets the file (null: none) and returns the file to write, if any, and its result.
 */
export async function readModifyWrite<T>(
  id: string,
  fn: (src: string | null) => { file?: string; result: T } | Promise<{ file?: string; result: T }>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const raw = await readPage(id);
    // A newer build's page is read as it is (no repair, no outside edit recorded) and never written.
    if (raw !== null && formatOf(raw) > FORMAT) {
      const { file, result } = await fn(raw);
      if (file !== undefined && file !== raw) {
        log("page.newer_refused", { page: id, format: formatOf(raw) });
        throw new NewerPageError(id, formatOf(raw));
      }
      return result;
    }
    const src = raw === null ? null : await adoptOutsideEdit(id, raw);
    const { file, result } = await fn(src);
    // A repaired block or a recorded outside edit is written even when `fn` changes nothing.
    const next = file ?? (src !== raw ? src : null);
    if (next === null || next === raw) return result;
    if (await writePage(id, next, raw)) {
      log("file.size", { page: id, ...blockSizes(next) });
      return result;
    }
    if (attempt === MAX_ATTEMPTS) throw new Error(`${id}.md kept changing while it was being written`);
  }
}

/** The first line of a page, for a page known by its text. */
const titleOf = (src: string) => (parseFile(src).markdown.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim() || "Untitled";

export async function listPages() {
  const names = await readdir(pagesDir(), { recursive: true }).catch((e: any): string[] => { if (e.code === "ENOENT") return []; throw e; });
  const out: { id: string; title: string; mtime: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3).split(sep).join("/");
    if (!validId(id)) continue;
    const file = join(pagesDir(), name);
    const st = await stat(file);
    out.push({ id, title: `${id}.md`, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(id) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(id, tail);
  tail.then(() => chains.get(id) === tail && chains.delete(id));
  return run;
}
