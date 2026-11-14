import { copyFile, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isPageId } from "../shared/ids";
import { canonical, emptyBlock, FORMAT, formatOf, mapMarkerComments, mergeBodies, parseFile, restoreSource, serializeFile, splitFrontmatter, withoutStates, withStatesFrom, type CommentsBlock } from "../shared/docfile";
import { config } from "./config";
import { hash, NewerPageError, readPage, readModifyWrite, validId, withLock, writePage } from "./files";
import { log } from "./log";
import { pagesDir, root } from "./runtime";

/**
 * The writer's project: the `.md` files they picked, each copied once into `.solipsist/` and worked on there. The repo
 * changes only at Sync, and Sync writes only text: markers and the hidden block stay in the working copy.
 *
 *   .solipsist/pages/<path>.md       the working copy, the app's own file format
 *   .solipsist/originals/<path>.md   the original's exact bytes, as of load, Reload changes or the last Sync
 *   .solipsist/images/<path>/        the images the page's agent draws
 */

const store = () => join(root(), ".solipsist");
const snapshotFile = (id: string) => join(store(), "originals", `${id}.md`);
/** The search paths the file dialog last offered files from, so a change to them opens it again. */
const offeredFile = () => join(store(), "search_paths.json");
/** Where the agent's images for page `id` wait until Sync. */
export const projectImages = (id: string) => join(store(), "images", id);
/** Files found this many or more are cut off, with a note in the dialog. */
const MAX_FILES = 5000;

/** The first launch: nothing has been copied yet. Nothing is created until the writer confirms. */
export const needsSetup = () => !existsSync(pagesDir());

/** The original of page `id`, or null when the path would lead out of the project (a symlink). */
export function originalPath(id: string): string | null {
  const top = realpathSync(root());
  const file = join(top, `${id}.md`);
  let at = file;
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  const real = realpathSync(at);
  return real === top || real.startsWith(top + sep) ? file : null;
}

const read = async (path: string): Promise<string | null> => {
  try { return await readFile(path, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
};
const readOriginal = (id: string) => { const p = originalPath(id); return p ? read(p) : Promise.resolve(null); };
const readSnapshot = (id: string) => read(snapshotFile(id));

// ------------------------------------------------------------------------------------------------ finding files

/** The glob for one `md_search_paths` entry: a folder means the `.md` files directly in it. */
function patternOf(entry: string): string {
  const clean = entry.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  try { if (statSync(join(root(), clean)).isDirectory()) return clean === "." ? "*.md" : `${clean}/*.md`; } catch {}
  return clean;
}

/** Which of `paths` git ignores; none outside a repo. */
async function ignored(paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try {
    const p = Bun.spawn(["git", "check-ignore", "-z", "--stdin"], { cwd: root(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(paths.join("\0") + "\0");
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    return new Set(out.split("\0").filter(Boolean));
  } catch { return new Set(); }
}

/** The `.md` files the search paths match, as paths from the project. Dot-paths and `node_modules` are never offered, nor what git ignores unless a pattern names its folder. */
export async function findFiles(): Promise<{ files: string[]; capped: boolean }> {
  const found = new Set<string>();
  // A pattern that starts with a name asks for that place by name, so git ignoring it doesn't hide its files.
  const named = new Set<string>();
  let capped = false;
  for (const entry of config().md_search_paths) {
    const pattern = patternOf(entry);
    const byName = !/^[*?[{!]/.test(pattern);
    for await (const raw of new Bun.Glob(pattern).scan({ cwd: root(), onlyFiles: true })) {
      const path = raw.replace(/^\.\//, "").split(sep).join("/");
      if (!path.endsWith(".md") || !isPageId(path.slice(0, -3)) || path.split("/").includes("node_modules")) continue;
      if (found.size >= MAX_FILES) { capped = true; break; }
      found.add(path);
      if (byName) named.add(path);
    }
  }
  const skip = await ignored([...found]);
  return { files: [...found].filter((f) => !skip.has(f) || named.has(f)).sort(), capped };
}

/** `changed`: the search paths aren't the ones the dialog last offered from, and they find files not added yet. */
export interface SetupView { project: boolean; needed: boolean; changed: boolean; found: string[]; searchPaths: string[]; capped: boolean }

/** Whether the search paths differ from the ones last offered (or none were recorded). */
async function pathsChanged(): Promise<boolean> {
  const before = await read(offeredFile());
  return before === null || before !== JSON.stringify(config().md_search_paths);
}
const recordPaths = () => writeFile(offeredFile(), JSON.stringify(config().md_search_paths));

/** What the file dialog shows: the files found that aren't in Solipsist yet. */
export async function setupView(): Promise<SetupView> {
  const { files, capped } = await findFiles();
  const needed = needsSetup();
  const found = files.filter((f) => !existsSync(join(pagesDir(), f)));
  const changed = !needed && found.length > 0 && (await pathsChanged());
  return { project: true, needed, changed, found, searchPaths: config().md_search_paths, capped };
}

// ------------------------------------------------------------------------------------------------ the copy

/** The working copy of `raw`, the original's bytes. Any Solipsist block already in the file is kept in the copy. */
function workingCopy(raw: string, meta?: CommentsBlock["meta"]): string {
  const { markdown, block } = parseFile(splitFrontmatter(raw).body);
  return serializeFile(canonical(markdown), { ...block, ...(meta && { meta }) });
}

async function saveSnapshot(id: string, raw: string) {
  await mkdir(dirname(snapshotFile(id)), { recursive: true });
  await writeFile(snapshotFile(id), raw);
}

async function importPage(id: string): Promise<void> {
  const raw = await readOriginal(id);
  if (raw === null) throw new Error("not found");
  await saveSnapshot(id, raw);
  await withLock(id, () => writePage(id, workingCopy(raw)));
}

async function makeStore() {
  await mkdir(pagesDir(), { recursive: true });
  await writeFile(join(store(), ".gitignore"), "*\n");
}

/**
 * Copies the files picked. A path that isn't among the files found is refused. Returns the ones that couldn't be read.
 * Records the search paths as offered, so an empty list is how the writer dismisses the dialog after they changed.
 */
export async function addFiles(paths: string[]): Promise<{ failed: string[] }> {
  const allowed = new Set((await findFiles()).files);
  await makeStore();
  await recordPaths();
  const failed: string[] = [];
  for (const path of paths) {
    try {
      if (!allowed.has(path)) throw new Error("not found by the search paths");
      await importPage(path.slice(0, -3));
    } catch (e) {
      failed.push(path);
      log("project.import_failed", { path, message: String((e as Error)?.message ?? e) });
    }
  }
  log("project.added", { files: paths.length - failed.length, failed: failed.length });
  return { failed };
}

/** A new page: its original (empty, so it has a path) and its copy. Null when the path is bad or taken. */
export async function newPage(path: string): Promise<string | null> {
  const id = path.trim().replace(/\.md$/, "");
  if (!validId(id)) return null;
  const file = originalPath(id);
  if (!file || existsSync(file) || existsSync(join(pagesDir(), `${id}.md`))) return null;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "");
  await makeStore();
  await importPage(id);
  return id;
}

// ------------------------------------------------------------------------------------------------ sync

/** The body as the repo should have it: no markers. A paragraph that held only a point marker goes with it. */
const withoutMarkers = (markdown: string) => mapMarkerComments(markdown, () => "");

const unsyncedCache = new Map<string, boolean>();
/** Whether the working copy `src` says anything its snapshot doesn't. Task bookkeeping doesn't count. */
export async function isUnsynced(id: string, src: string): Promise<boolean> {
  const snapshot = await readSnapshot(id);
  if (snapshot === null) return false;
  const key = `${id}\0${hash(src)}\0${hash(snapshot)}`;
  const known = unsyncedCache.get(key);
  if (known !== undefined) return known;
  const value = canonical(withoutMarkers(parseFile(src).markdown)) !== canonical(parseFile(splitFrontmatter(snapshot).body).markdown);
  if (unsyncedCache.size > 2000) unsyncedCache.clear();
  unsyncedCache.set(key, value);
  return value;
}

export type SyncResult =
  | { ok: true; changed: boolean; fallback: boolean }
  | { ok: false; code: "original_changed" | "original_missing" | "not_found" };

/** Copies the images the page links from the store to beside the page, where the links lead once it's in the repo. */
async function copyImages(id: string, file: string, text: string) {
  const name = basename(id);
  for (const m of text.matchAll(/!\[[^\]]*\]\(<?(images\/[^)\s>]+)/g)) {
    const rel = decodeURI(m[1]!);
    const prefix = `images/${name}/`;
    if (!rel.startsWith(prefix)) continue;
    const from = join(projectImages(id), rel.slice(prefix.length));
    if (!existsSync(from)) continue;
    const to = join(dirname(file), rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

/**
 * Writes the working copy over the original. Without `force` it won't replace anything the writer hasn't seen: an
 * original that no longer matches its snapshot is refused and nothing is written.
 */
export function syncPage(id: string, force = false): Promise<SyncResult> {
  return withLock(id, async (): Promise<SyncResult> => {
    const working = await readPage(id);
    const snapshot = await readSnapshot(id);
    const file = originalPath(id);
    // A newer build's markers may not be ones this build knows to take out: its page is never synced from here.
    if (working !== null && formatOf(working) > FORMAT) throw new NewerPageError(id, formatOf(working));
    if (working === null || snapshot === null || !file) return { ok: false, code: "not_found" };
    const check = async (): Promise<SyncResult | null> => {
      const current = await read(file);
      if (force || current === snapshot) return null;
      return { ok: false, code: current === null ? "original_missing" : "original_changed" };
    };
    const refused = await check();
    if (refused) return refused;

    const { frontmatter, body: snapshotBody } = splitFrontmatter(snapshot);
    const body = withoutMarkers(parseFile(working).markdown);
    const { text, fallback } = restoreSource(parseFile(snapshotBody).markdown, body);
    const out = frontmatter + text;
    if (fallback) log("page.source_fallback", { page: id });
    await copyImages(id, file, out);

    const mode = await stat(file).then((s) => s.mode).catch(() => null);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, out);
    if (mode !== null) await chmod(tmp, mode);
    const late = await check();
    if (late) { await rm(tmp, { force: true }); return late; }
    await rename(tmp, file);
    await saveSnapshot(id, out);
    const changed = out !== snapshot;
    log("page.sync", { page: id, changed, fallback, force });
    return { ok: true, changed, fallback };
  });
}

export type ReloadResult = { ok: true } | { ok: false; code: "conflict" | "original_missing" | "not_found" };

/**
 * Takes in the newer original. Its changes are merged with the writer's edits in the working copy, which stays
 * unsynced, so the writer reads the result before anything reaches the repo. If both changed the same text nothing
 * changes, unless `discard`, which replaces the page (its comments and tasks too) with a fresh copy of the original.
 */
export function reloadPage(id: string, discard = false): Promise<ReloadResult> {
  return withLock(id, async (): Promise<ReloadResult> => {
    const current = await readOriginal(id);
    const snapshot = await readSnapshot(id);
    if (snapshot === null) return { ok: false, code: "not_found" };
    if (current === null) return { ok: false, code: "original_missing" };
    const canon = (raw: string) => canonical(parseFile(splitFrontmatter(raw).body).markdown);
    const outcome = await readModifyWrite<ReloadResult>(id, (src) => {
      if (src === null) return { result: { ok: false, code: "not_found" } };
      const { markdown: mine, block } = parseFile(src);
      const rev = block.meta.rev + 1;
      const meta = { rev, body_rev: rev, body_by: "disk" };
      if (discard) return { file: workingCopy(current, meta), result: { ok: true } };
      const merged = mergeBodies(withoutStates(canon(snapshot)), withoutStates(mine), withoutStates(canon(current)));
      if (merged === null) return { result: { ok: false, code: "conflict" } };
      const next = withStatesFrom(merged, mine);
      if (next === mine) return { result: { ok: true } };
      return { file: serializeFile(next, { ...block, meta }), result: { ok: true } };
    });
    if (outcome.ok) await saveSnapshot(id, current);
    return outcome;
  });
}

/** The image `path` (from the project) as it is in the store: an agent's image is there until Sync. */
export function storedImage(path: string): string | null {
  const m = path.match(/^(?:(.*)\/)?images\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const file = join(projectImages(m[1] ? `${m[1]}/${m[2]}` : m[2]!), m[3]!);
  return resolve(file).startsWith(resolve(store()) + sep) && existsSync(file) ? file : null;
}
