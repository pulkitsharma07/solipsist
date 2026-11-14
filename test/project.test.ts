// A project: the files the writer picks are copied into `.solipsist/`, and the repo changes only at Sync.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyBlock, parseFile, serializeFile } from "../src/shared/docfile";
import * as api from "../src/server/api";
import { addFiles, findFiles, isUnsynced, needsSetup, newPage, originalPath, reloadPage, setupView, syncPage } from "../src/server/project";

const cwd = process.cwd();
const wasProject = process.env.SOLIPSIST_PROJECT_ROOT!;
const paths = process.env.SOLIPSIST_SEARCH_PATHS;
let dir = "";

const put = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const working = (id: string) => `.solipsist/pages/${id}.md`;
/** The writer's edit: what a save does to the working copy. */
const edit = (id: string, f: (body: string) => string) => {
  const { markdown, block } = parseFile(read(working(id)));
  const rev = block.meta.rev + 1;
  put(working(id), serializeFile(f(markdown), { ...block, meta: { rev, body_rev: rev, body_by: "t_a" } }));
};
const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).stdout.toString();
const search = (...p: string[]) => { process.env.SOLIPSIST_SEARCH_PATHS = p.join(","); };

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "solip-project-")));
  process.chdir(dir);
  // The project is named, not just entered: that is what the server reads (`test/setup.ts` names one for every file).
  process.env.SOLIPSIST_PROJECT_ROOT = dir;
  delete process.env.SOLIPSIST_SEARCH_PATHS;
});
afterEach(() => {
  process.chdir(cwd);
  process.env.SOLIPSIST_PROJECT_ROOT = wasProject;
  rmSync(dir, { recursive: true, force: true });
  if (paths === undefined) delete process.env.SOLIPSIST_SEARCH_PATHS; else process.env.SOLIPSIST_SEARCH_PATHS = paths;
});

test("the default offers only the files in this folder", async () => {
  put("README.md", "# R\n");
  put("docs/a.md", "# A\n");
  expect((await findFiles()).files).toEqual(["README.md"]);
});

test("a folder, a file and a ** pattern; dot-folders and node_modules are never offered", async () => {
  for (const f of ["docs/a.md", "docs/sub/b.md", "specs/1/spec.md", "ROADMAP.md", ".github/t.md", "docs/.hidden/c.md", "docs/node_modules/d.md", "docs/notes.txt"]) put(f, "x\n");
  search("docs/**/*.md");
  expect((await findFiles()).files).toEqual(["docs/a.md", "docs/sub/b.md"]);
  search("docs", "ROADMAP.md", "./specs/**/*.md", "nothing/*.md");
  expect((await findFiles()).files).toEqual(["ROADMAP.md", "docs/a.md", "specs/1/spec.md"]);
});

test("what git ignores isn't offered", async () => {
  git("init", "-q");
  put(".gitignore", "secret.md\nout/\n");
  for (const f of ["kept.md", "secret.md"]) put(f, "x\n");
  put("out/gone.md", "x\n");
  search("**/*.md");
  expect((await findFiles()).files).toEqual(["kept.md"]);
  // Naming the folder asks for it, whatever git says about it.
  search("*.md", "out/*.md");
  expect((await findFiles()).files).toEqual(["kept.md", "out/gone.md"]);
});

test("launching creates nothing until the writer confirms", async () => {
  put("README.md", "# R\n");
  expect(needsSetup()).toBe(true);
  expect(await setupView()).toEqual({ project: true, needed: true, changed: false, found: ["README.md"], searchPaths: ["*.md"], capped: false });
  await api.listPages();
  expect(existsSync(join(dir, ".solipsist"))).toBe(false);
});

test("only the files picked are copied; the rest are never touched; git sees nothing", async () => {
  git("init", "-q");
  put("a.md", "---\nstatus: draft\n---\n\n# A\n");
  put("b.md", "# B\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-qm", "base");
  expect(await addFiles(["a.md"])).toEqual({ failed: [] });
  expect(needsSetup()).toBe(false);
  expect(existsSync(join(dir, working("a")))).toBe(true);
  expect(existsSync(join(dir, working("b")))).toBe(false);
  expect(git("status", "--short")).toBe("");
  expect((await setupView()).found).toEqual(["b.md"]);
  expect((await (await api.listPages()).json()).map((d: { id: string }) => d.id)).toEqual(["a"]);
});

test("changing md_search_paths after the first launch opens the dialog again, until it is answered", async () => {
  put("a.md", "# A\n");
  put("notes/b.md", "# B\n");
  await addFiles(["a.md"]);
  expect((await setupView()).changed).toBe(false);
  // The restart with a new search path: the new folder's file is offered without asking for it.
  search("*.md", "notes/*.md");
  expect(await setupView()).toMatchObject({ needed: false, changed: true, found: ["notes/b.md"] });
  // Cancel answers it with no files; the file is still there under Add files.
  await addFiles([]);
  expect(await setupView()).toMatchObject({ changed: false, found: ["notes/b.md"] });
  // A change that finds nothing new doesn't ask.
  search("*.md", "notes/*.md", "empty/*.md");
  await addFiles(["notes/b.md"]);
  search("*.md", "notes/*.md", "other/*.md");
  expect(await setupView()).toMatchObject({ changed: false, found: [] });
});

test("a path the search paths don't cover can't be added", async () => {
  put("docs/a.md", "x\n");
  put("../outside.md", "x\n");
  expect((await addFiles(["docs/a.md", "../outside.md"])).failed).toEqual(["docs/a.md", "../outside.md"]);
  rmSync(join(dir, "..", "outside.md"));
});

test("frontmatter stays out of the page", async () => {
  put("a.md", "---\nstatus: draft\n---\n\n# A\n");
  await addFiles(["a.md"]);
  expect(parseFile(read(working("a"))).markdown).toBe("# A");
});

test("nested paths, spaces and capitals work as pages", async () => {
  put("backlog/tasks/Task 12 - Sync.md", "# T\n");
  search("backlog/**/*.md");
  await addFiles(["backlog/tasks/Task 12 - Sync.md"]);
  const req = Object.assign(new Request("http://x/"), { params: { id: "backlog/tasks/Task 12 - Sync" } });
  const got = await (await api.getPage(req)).json();
  expect(got.path).toBe("backlog/tasks/Task 12 - Sync.md");
  expect(parseFile(got.file).markdown).toBe("# T");
});

test("Sync: one edit changes one line of the original", async () => {
  const page = "---\nstatus: draft\n---\n\n# A\n\n* one\n* two\n\n_Keep_ this.\n";
  put("a.md", page);
  await addFiles(["a.md"]);
  expect(await isUnsynced("a", read(working("a")))).toBe(false);
  edit("a", (b) => b.replace("Keep", "Kept"));
  expect(await isUnsynced("a", read(working("a")))).toBe(true);
  expect(await syncPage("a")).toEqual({ ok: true, changed: true, fallback: false });
  expect(read("a.md")).toBe(page.replace("_Keep_ this.", "*Kept* this."));
  expect(await isUnsynced("a", read(working("a")))).toBe(false);
});

test("Sync writes text only: no marker and no block", async () => {
  put("a.md", "# A\n\nText.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => `${b} <!-- gen:abc:sug -->`);
  await syncPage("a");
  expect(read("a.md")).not.toContain("<!--");
});

test("hand-written comments do reach the repo", async () => {
  put("a.md", "# A\n\n<!-- a note -->\n\nText.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => b.replace("Text.", "Text, more."));
  await syncPage("a");
  expect(read("a.md")).toContain("<!-- a note -->");
});

test("a task on a page isn't a change to sync", async () => {
  put("a.md", "# A\n\nText.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => b.replace("Text.", "Text.<!-- gen:abc -->"));
  expect(await isUnsynced("a", read(working("a")))).toBe(false);
});

test("Sync refuses a changed original, writes nothing, and force overwrites it", async () => {
  put("a.md", "# A\n\nOne.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => b.replace("One.", "Mine."));
  put("a.md", "# A\n\nTheirs.\n");
  expect(await syncPage("a")).toEqual({ ok: false, code: "original_changed" });
  expect(read("a.md")).toBe("# A\n\nTheirs.\n");
  expect((await syncPage("a", true)).ok).toBe(true);
  expect(read("a.md")).toBe("# A\n\nMine.\n");
});

test("Sync refuses a deleted original, and force makes it again", async () => {
  put("d/a.md", "# A\n");
  search("d");
  await addFiles(["d/a.md"]);
  rmSync(join(dir, "d"), { recursive: true });
  expect(await syncPage("d/a")).toEqual({ ok: false, code: "original_missing" });
  expect((await syncPage("d/a", true)).ok).toBe(true);
  expect(read("d/a.md")).toBe("# A\n");
});

test("Reload changes merges the original with the edits, and then Sync passes", async () => {
  put("a.md", "# A\n\nOne.\n\nTwo.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => b.replace("One.", "Mine."));
  put("a.md", "# A\n\nOne.\n\nTheirs.\n");
  expect(await reloadPage("a")).toEqual({ ok: true });
  expect(read("a.md")).toBe("# A\n\nOne.\n\nTheirs.\n"); // nothing reached the repo
  const { markdown, block } = parseFile(read(working("a")));
  expect(markdown).toBe("# A\n\nMine.\n\nTheirs.");
  expect(block.meta.body_by).toBe("disk");
  expect((await syncPage("a")).ok).toBe(true);
  expect(read("a.md")).toBe("# A\n\nMine.\n\nTheirs.\n");
});

test("Reload changes with both sides on the same text changes nothing; discard takes the original", async () => {
  put("a.md", "# A\n\nOne.\n");
  await addFiles(["a.md"]);
  edit("a", (b) => b.replace("One.", "Mine."));
  put("a.md", "# A\n\nTheirs.\n");
  expect(await reloadPage("a")).toEqual({ ok: false, code: "conflict" });
  expect(parseFile(read(working("a"))).markdown).toBe("# A\n\nMine.");
  expect(await syncPage("a")).toEqual({ ok: false, code: "original_changed" }); // the snapshot didn't move
  expect(await reloadPage("a", true)).toEqual({ ok: true });
  expect(parseFile(read(working("a"))).markdown).toBe("# A\n\nTheirs.");
  expect(await isUnsynced("a", read(working("a")))).toBe(false);
});

test("an open page hears about a reload: its rev moves on", async () => {
  put("a.md", "# A\n\nOne.\n");
  await addFiles(["a.md"]);
  put("a.md", "# A\n\nNewer.\n");
  const rev = parseFile(read(working("a"))).block.meta.rev;
  await reloadPage("a");
  expect(parseFile(read(working("a"))).block.meta.rev).toBeGreaterThan(rev);
});

test("the agent's images reach the repo at Sync, beside the page", async () => {
  put("docs/a.md", "# A\n");
  search("docs");
  await addFiles(["docs/a.md"]);
  put(".solipsist/images/docs/a/chart.svg", "<svg/>");
  put(".solipsist/images/docs/a/unused.svg", "<svg/>");
  edit("docs/a", (b) => `${b}\n\n![Chart](images/a/chart.svg)`);
  await syncPage("docs/a");
  expect(read("docs/images/a/chart.svg")).toBe("<svg/>");
  expect(existsSync(join(dir, "docs/images/a/unused.svg"))).toBe(false);
});

test("a symlink out of the folder is refused", async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "solip-outside-")));
  writeFileSync(join(outside, "x.md"), "# secret\n");
  symlinkSync(outside, join(dir, "link"));
  expect(originalPath("link/x")).toBeNull();
  expect(originalPath("ok")).toBe(join(dir, "ok.md"));
  rmSync(outside, { recursive: true });
});

test("a new page has an original at once; a taken or bad path is refused", async () => {
  put("a.md", "# A\n");
  await addFiles(["a.md"]);
  expect(await newPage("docs/notes.md")).toBe("docs/notes");
  expect(read("docs/notes.md")).toBe("");
  expect(existsSync(join(dir, working("docs/notes")))).toBe(true);
  expect(await newPage("a.md")).toBeNull();
  expect(await newPage("../x.md")).toBeNull();
  expect(await newPage(".hidden/x.md")).toBeNull();
});

test("the API routes: Sync's refusal is a 409 and the page's state is readable", async () => {
  put("a.md", "# A\n");
  await addFiles(["a.md"]);
  const req = (body?: unknown) => Object.assign(new Request("http://x/", { method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) }), { params: { id: "a" } });
  expect(await (await api.getSync(req())).json()).toEqual({ unsynced: false });
  put("a.md", "# Changed\n");
  const r = await api.postSync(req({ force: false }));
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("original_changed");
});

test("assets: only media, never a dot-path, and an agent's image from the store", async () => {
  put("a.md", "# A\n");
  await addFiles(["a.md"]);
  put(".env", "SECRET=1\n");
  put("config.json", "{}");
  put("logo.png", "png");
  put(".solipsist/images/a/chart.svg", "<svg/>");
  const get = (p: string) => api.assetFile(new Request(`http://localhost/api/assets/${p}`));
  expect((await get(".env")).status).toBe(400);
  expect((await get("config.json")).status).toBe(400);
  expect((await get("a.md")).status).toBe(400);
  expect((await get("%2e%2e/x.png")).status).toBe(400);
  expect((await get("logo.png")).status).toBe(200);
  expect(await (await get("images/a/chart.svg")).text()).toBe("<svg/>");
});

