import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "../src/server/api";
import { testHooks } from "../src/server/files";
import { addComments } from "../src/server/live";
import { parseFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

// Writers outside the server (the agent's Edit tool, a hand edit) don't take the server's lock. One may write between
// the server's read and its rename: that edit must not be overwritten.

const P = projectDir("solip-safe-");
const dir = P.docs;
beforeAll(() => P.enter());
afterEach(() => void (testHooks.beforeRename = undefined));
afterAll(() => P.done());

const file = (id: string) => join(dir, `${id}.md`);
const call = (fn: (r: any) => Promise<Response>, id: string, body?: unknown, method = "PUT") =>
  fn(Object.assign(new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id } }));
const put = (id: string, o: object) => call(api.putPage, id, { client_id: "a", base_rev: 0, markdown: "# Hi", comments: {}, ...o });

/** Makes one outside write happen right before the server's next rename. */
function editOnce(id: string, edit: (src: string) => string) {
  let done = false;
  testHooks.beforeRename = (which) => {
    if (done || which !== id) return;
    done = true;
    writeFileSync(file(id), edit(readFileSync(file(id), "utf8")));
  };
}

/** A new page is a new `.md` in the project, so it is made at a path: there is no random-id page any more. */
let made = 0;
const newDoc = () => api.createPage(new Request("http://x/", { method: "POST", body: JSON.stringify({ path: `page-${++made}.md` }) }));

test("after a hot reload the old code and the new share what was written and the lock", async () => {
  // `bun --hot` runs files.ts again, but a page's agents built before it keep calling the old copy.
  const old = await import("../src/server/files");
  const spec = "../src/server/files.ts?hot-reload";
  const reloaded: typeof old = await import(spec);
  expect(reloaded.withLock).not.toBe(old.withLock);

  const { id } = await (await newDoc()).json();
  const read = (copy: typeof old) => copy.withLock(id, () => copy.readModifyWrite(id, (src) => ({ result: src! })));
  await read(old); // the file predates nothing now: this copy has adopted it
  const src = (await reloaded.readPage(id))!;

  await old.withLock(id, () => old.writePage(id, `${src}`));
  expect(await read(reloaded)).toBe(src); // not an outside edit: no rev bump, no write
  await reloaded.withLock(id, () => reloaded.writePage(id, `${src}`));
  expect(await read(old)).toBe(src);

  const order: string[] = [];
  const first = old.withLock(id, async () => { await Bun.sleep(20); order.push("old"); });
  const second = reloaded.withLock(id, async () => { order.push("new"); });
  await Promise.all([first, second]);
  expect(order).toEqual(["old", "new"]);
});

test("an outside edit made while a save is being written is kept, and the save gets a 409", async () => {
  const { id } = await (await newDoc()).json();
  await put(id, { markdown: "# T\n\nFirst." });
  editOnce(id, (src) => src.replace("First.", "First. Added by the agent."));
  const r = await put(id, { base_rev: 1, markdown: "# T\n\nFirst, typed." });
  expect(r.status).toBe(409);
  const body = await r.json();
  expect(parseFile(body.file).markdown).toBe("# T\n\nFirst. Added by the agent.");
  const disk = parseFile(readFileSync(file(id), "utf8"));
  expect(disk.markdown).toBe("# T\n\nFirst. Added by the agent.");
  expect(disk.block.meta.body_by).toBe("disk");
});

test("an outside edit made while comments are being placed is kept, and the comments still land", async () => {
  const { id } = await (await newDoc()).json();
  await put(id, { markdown: "# T\n\nThe launch slipped to the end of Q3 again." });
  editOnce(id, (src) => src.replace("again.", "again.\n\nA new paragraph."));
  const r = await addComments(id, [{ quote: "slipped to the end of Q3", title: "When?" }]);
  expect(r?.placed.length).toBe(1);
  const disk = parseFile(readFileSync(file(id), "utf8"));
  expect(disk.markdown).toContain("A new paragraph.");
  expect(Object.keys(disk.block.comments)).toEqual(r!.placed);
});

test("a broken comments block keeps the last good one: comments and records survive, the body edit is kept", async () => {
  const { id } = await (await newDoc()).json();
  await put(id, { markdown: "# T\n\nThe launch slipped to the end of Q3 again. <!-- gen:abc -->" });
  const placed = (await addComments(id, [{ quote: "slipped to the end of Q3", title: "When?" }]))!.placed;
  const good = readFileSync(file(id), "utf8");
  // The agent edits the body and breaks the YAML in the same save.
  writeFileSync(file(id), good.replace("again.", "again. More.").replace('"meta":', '"meta": [oops'));
  const r = await call(api.getPage, id, undefined, "GET");
  const got = parseFile((await r.json()).file);
  expect(got.problem).toBeUndefined();
  expect(got.markdown).toContain("again. More.");
  expect(Object.keys(got.block.comments)).toEqual(placed);
  expect(got.block.tasks?.abc?.type).toBe("gen");
  expect(readFileSync(`${file(id)}.bad-block`, "utf8")).toContain("[oops");
});

test("an outside edit the watcher hasn't recorded yet is recorded before a save builds on it", async () => {
  const { id } = await (await newDoc()).json();
  await put(id, { markdown: "# T\n\nFirst." });
  // The agent writes, and the tab's save arrives before the watcher has looked (no watcher runs in this file).
  writeFileSync(file(id), readFileSync(file(id), "utf8").replace("First.", "First. Added by the agent."));
  const r = await put(id, { base_rev: 1, markdown: "# T\n\nFirst, typed." });
  expect(r.status).toBe(409);
  const disk = parseFile(readFileSync(file(id), "utf8"));
  expect(disk.markdown).toBe("# T\n\nFirst. Added by the agent.");
  expect(disk.block.meta.body_by).toBe("disk");
});
