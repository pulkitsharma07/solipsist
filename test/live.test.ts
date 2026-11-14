import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "../src/server/api";
import { events, startPushing } from "../src/server/live";
import { pageChanged } from "../src/server/runtime";
import { parseFile } from "../src/shared/docfile";
import { projectDir } from "./project-dir";

const P = projectDir("solip-live-");
const dir = P.docs;
beforeAll(() => { P.enter(); startPushing(); });
afterAll(() => P.done());

const withParams = (url: string, id: string, init?: RequestInit) => Object.assign(new Request(url, init), { params: { id } });

/** Reads SSE frames until `n` `file` events have arrived. */
async function files(id: string, n: number, act: () => Promise<unknown>) {
  const ac = new AbortController();
  const res = await events(withParams("http://x/", id, { signal: ac.signal }), { timeout() {} });
  const reader = res.body!.getReader();
  const out: any[] = [];
  let buf = "";
  const done = (async () => {
    while (out.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
        const f = buf.slice(0, i); buf = buf.slice(i + 2);
        if (f.includes("event: file")) out.push(JSON.parse(f.split("data: ")[1]!));
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  await act();
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000))]);
  ac.abort();
  return out;
}

/** A new page is a new `.md` in the project, so it is made at a path: there is no random-id page any more. */
let made = 0;
const newDoc = () => api.createPage(new Request("http://x/", { method: "POST", body: JSON.stringify({ path: `page-${++made}.md` }) }));

test("connect sends the file; a PUT sends the next one once", async () => {
  const { id } = await (await newDoc()).json();
  const got = await files(id, 2, () =>
    api.putPage(withParams("http://x/", id, { method: "PUT", body: JSON.stringify({ client_id: "a", base_rev: 0, markdown: "# Hi" }) })));
  expect(got.map((g) => g.rev)).toEqual([0, 1]);
});

test("a hand edit is recorded as a body change by disk", async () => {
  const { id } = await (await newDoc()).json();
  const got = await files(id, 2, async () => {
    writeFileSync(join(dir, `${id}.md`), "# By hand\n");
    pageChanged(id);
  });
  const last = parseFile(got[1].file);
  expect(last.block.meta.body_by).toBe("disk");
  expect(last.markdown).toBe("# By hand");
  expect(parseFile(readFileSync(join(dir, `${id}.md`), "utf8")).block.meta.rev).toBe(got[1].rev);
});

test("a mock comment reaches the stream and leaves the body alone", async () => {
  const { id } = await (await newDoc()).json();
  await api.putPage(withParams("http://x/", id, { method: "PUT", body: JSON.stringify({ client_id: "a", base_rev: 0, markdown: "# T\n\nThe launch slipped to the end of Q3 again." }) }));
  const got = await files(id, 2, () => api.mockComment(withParams("http://x/", id, { method: "POST" })));
  const f = parseFile(got[1].file);
  expect(Object.keys(f.block.comments)).toHaveLength(1);
  expect(f.markdown).toBe("# T\n\nThe launch slipped to the end of Q3 again.");
});

test("a second stream on the same page is refused until the first closes", async () => {
  const { id } = await (await newDoc()).json();
  const ac = new AbortController();
  const first = await events(withParams("http://x/", id, { signal: ac.signal }), { timeout() {} });
  expect(first.status).toBe(200);
  const second = await events(withParams("http://x/", id), { timeout() {} });
  expect(second.status).toBe(409);
  expect((await second.json()).error.code).toBe("already_open");
  ac.abort();
  const third = await events(withParams("http://x/", id), { timeout() {} });
  expect(third.status).toBe(200);
  await third.body!.cancel();
});

test("comments posted from outside are placed like the job's, and bad ones are reported", async () => {
  const { id } = await (await newDoc()).json();
  await api.putPage(withParams("http://x/", id, { method: "PUT", body: JSON.stringify({ client_id: "a", base_rev: 0, markdown: "# T\n\nThe launch is in May. The budget closes in April, before the launch." }) }));
  const post = (body: unknown) => api.addComments(withParams("http://x/", id, { method: "POST", body: JSON.stringify(body) }));
  const r = await (await post({ comments: [{ quote: "The launch is in May", title: "May or April?" }, { quote: "not on the page at all", title: "x" }] })).json();
  expect(r.placed).toHaveLength(1);
  expect(r.dropped.map((d: any) => d.reason)).toEqual(["not-in-read-text"]);
  const f = parseFile(readFileSync(join(dir, `${id}.md`), "utf8"));
  expect(Object.values(f.block.comments)[0]!.title).toBe("May or April?");
  expect((await post({ comments: [{ quote: 1 }] })).status).toBe(400);
});

test("an orphaned comment is removed from the file after the keep time, and the open stream gets the cleaned file", async () => {
  process.env.ORPHAN_KEEP_MS = "150";
  try {
    const { id } = await (await newDoc()).json();
    const comment = (cid: string, status: string, orphaned_at?: string) => ({
      id: cid, status, thinker: "t", title: cid, anchor: { exact: "x", prefix: "", suffix: "", start: 0 }, created: "x", created_rev: 1, ...(orphaned_at && { orphaned_at }),
    });
    const block = { meta: { rev: 5, body_rev: 5, body_by: "t_a" }, comments: { keep: comment("keep", "open"), gone: comment("gone", "orphaned", new Date().toISOString()) } };
    // Wait for the second file frame (the cleaned one) after writing the file with an orphan in it.
    const got = await files(id, 3, async () => {
      writeFileSync(join(dir, `${id}.md`), `# T\n\nBody.\n\n<!-- solip-comments\n${JSON.stringify(block)}\n-->\n`);
      pageChanged(id);
    });
    const last = parseFile(got[got.length - 1].file);
    expect(Object.keys(last.block.comments)).toEqual(["keep"]);
    expect(last.markdown).toBe("# T\n\nBody.");
    expect(Object.keys(parseFile(readFileSync(join(dir, `${id}.md`), "utf8")).block.comments)).toEqual(["keep"]);
  } finally {
    delete process.env.ORPHAN_KEEP_MS;
  }
});

test("text added below the comments block by hand is the end of the body, and the file keeps one block", async () => {
  const { id } = await (await newDoc()).json();
  const path = join(dir, `${id}.md`);
  const got = await files(id, 2, async () => {
    writeFileSync(path, readFileSync(path, "utf8") + "\nAppended line.\n");
    pageChanged(id);
  });
  // A new page in a project starts empty (`newPage`), so the appended line is the whole body.
  expect(parseFile(got[1].file).markdown).toBe("Appended line.");
  expect(readFileSync(path, "utf8").split("<!-- solip-comments").length).toBe(2);
});
