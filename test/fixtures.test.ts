// Every page in test/fixtures/ (real pages that once broke something) must open, and survive a save and reload.
// Add a page here when one fails to open: `cp docs/<id>.md test/fixtures/<what-was-odd>.md`.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { docToMarkdown, markdownToDoc } from "../src/shared/docfile";
import { Server, Tab } from "./browser-tab";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const dir = `${import.meta.dir}/fixtures`;
const names = readdirSync(dir).filter((f) => f.endsWith(".md"));

test("there are fixtures", () => expect(names.length).toBeGreaterThan(0));

function check(path: string, roundTrip: typeof test) {
  const md = readFileSync(path, "utf8");

  test("parses into a valid document", () => {
    expect(() => markdownToDoc(md)).not.toThrow();
  });
  roundTrip("opens in the editor, saves, and comes back the same", async () => {
    const server = new Server(md);
    const tab = new Tab(server.src);
    await tab.save(server);
    const once = tab.markdown;
    expect(markdownToDoc(once).eq(markdownToDoc(md))).toBe(true); // what is saved reads as the page that was opened
    expect(docToMarkdown(markdownToDoc(once))).toBe(once); // and saving again changes nothing
  });
}

describe.each(names)("%s", (name) => check(`${dir}/${name}`, test));

// Pages that still change when they are saved. `test.failing` passes while the bug is there and fails once it is
// fixed: then move the page up into test/fixtures/.
const known = (existsSync(`${dir}/known-bugs`) ? readdirSync(`${dir}/known-bugs`) : []).filter((f) => f.endsWith(".md"));
if (known.length) describe.each(known)("known bug: %s", (name) => check(`${dir}/known-bugs/${name}`, test.failing as typeof test));
