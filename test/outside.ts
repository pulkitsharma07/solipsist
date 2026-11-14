// A write to a page that isn't the server's, in tests. Nothing watches the pages (only the server writes them), so a
// test that plays someone else writing one says so, the way the server's own writes do. Any other file is just written.
import { writeFileSync as write } from "node:fs";
import { basename } from "node:path";
import { pageChanged } from "../src/server/runtime";

export function writeFileSync(path: string, text: string) {
  write(path, text);
  if (path.endsWith(".md")) pageChanged(basename(path, ".md"));
}
