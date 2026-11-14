// Where each page's bytes go: body, hidden comments block, and the block's biggest parts, largest page first.
// `bun scripts/block-sizes.ts` in a project (the pages are its `.solipsist/pages`). Same numbers as the server's
// `file.size` log line (`blockSizes`, src/shared/docfile/sizes.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockSizes } from "../src/shared/docfile";
import { pagesDir } from "../src/server/runtime";

const dir = pagesDir();
const rows = readdirSync(dir)
  .filter((n) => n.endsWith(".md"))
  .map((n) => ({ page: n.slice(0, -3), ...blockSizes(readFileSync(join(dir, n), "utf8")) }))
  .sort((a, b) => b.total - a.total);

const cols = ["page", "total", "body", "hidden", "comments", "records", "proposals", "chat", "solo"] as const;
const width = (c: (typeof cols)[number]) => Math.max(c.length, ...rows.map((r) => String(r[c]).length));
const line = (f: (c: (typeof cols)[number]) => string) => cols.map((c) => (c === "page" ? f(c).padEnd(width(c)) : f(c).padStart(width(c)))).join("  ");
console.log(`${dir} (bytes; proposals are inside records)`);
console.log(line((c) => c));
for (const r of rows) console.log(line((c) => String(r[c])));
