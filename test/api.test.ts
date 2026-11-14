import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "../src/server/api";
import { parseFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-api-");
const dir = P.docs;
beforeAll(() => P.enter());
afterAll(() => P.done());

/** A new page is a new `.md` in the project, so it is made at a path: there is no random-id page any more. */
let made = 0;
const create = () => api.createPage(new Request("http://x/", { method: "POST", body: JSON.stringify({ path: `page-${++made}.md` }) }));

const call = (fn: (r: any) => Promise<Response>, id: string, body?: unknown, method = "PUT") =>
  fn(Object.assign(new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id } }));
const put = (id: string, o: object) => call(api.putPage, id, { client_id: "a", base_rev: 0, markdown: "# Hi", comments: {}, ...o });

test("create, get, put, list", async () => {
  const { id } = await (await create()).json();
  expect((await call(api.getPage, id, undefined, "GET")).status).toBe(200);
  const r = await put(id, { markdown: "# Title\n\nHello" });
  expect(r.status).toBe(200);
  expect((await r.json()).rev).toBe(1);
  expect(readFileSync(join(dir, `${id}.md`), "utf8")).toContain("Hello");
  // A page is one of the project's files, so the list names it by its path, not by its first line.
  expect((await (await api.listPages()).json()).map((d: { title: string }) => d.title)).toContain(`${id}.md`);
});

test("bad id, missing doc, bad body", async () => {
  expect((await put("../x", {})).status).toBe(400);
  expect((await put("nope", {})).status).toBe(404);
  const { id } = await (await create()).json();
  expect((await call(api.putPage, id, { markdown: 1 })).status).toBe(400);
});

test("a second writer gets 409 and nothing is written", async () => {
  const { id } = await (await create()).json();
  await put(id, { client_id: "a", markdown: "# A" });
  const before = readFileSync(join(dir, `${id}.md`), "utf8");
  const r = await put(id, { client_id: "b", base_rev: 0, markdown: "# B" });
  expect(r.status).toBe(409);
  expect(readFileSync(join(dir, `${id}.md`), "utf8")).toBe(before);
});

test("concurrent PUTs are serialised by the lock", async () => {
  const { id } = await (await create()).json();
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => put(id, { markdown: `# ${i}` })));
  expect(rs.every((r) => r.status === 200)).toBe(true);
  expect(parseFile(readFileSync(join(dir, `${id}.md`), "utf8")).block.meta.rev).toBe(10);
});

test("a broken comments block is moved aside", async () => {
  writeFileSync(join(dir, "broken.md"), "# Keep me\n\n<!-- solip-comments\n{nope\n-->\n");
  const r = await call(api.getPage, "broken", undefined, "GET");
  expect(r.status).toBe(200);
  expect(readFileSync(join(dir, "broken.md.bad-block"), "utf8")).toContain("{nope");
  expect(parseFile(readFileSync(join(dir, "broken.md"), "utf8")).markdown).toBe("# Keep me");
});
