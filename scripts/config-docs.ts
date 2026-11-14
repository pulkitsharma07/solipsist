// Writes CONFIGURATION.md's reference and solipsist.example.yaml from the settings table (src/server/config.ts).
// `bun scripts/config-docs.ts` writes them; `--check` only reports whether they are current (test/config.test.ts does too).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderExample, spliceReference } from "../src/server/configDocs";

const root = join(import.meta.dir, "..");
const files = [
  ["CONFIGURATION.md", spliceReference(readFileSync(join(root, "CONFIGURATION.md"), "utf8"))],
  ["solipsist.example.yaml", renderExample()],
] as const;

const check = process.argv.includes("--check");
let stale = 0;
for (const [name, text] of files) {
  const path = join(root, name);
  let have = "";
  try { have = readFileSync(path, "utf8"); } catch {}
  if (have === text) continue;
  stale++;
  if (!check) writeFileSync(path, text);
  console.log(`${check ? "stale" : "wrote"} ${name}`);
}
if (check && stale) process.exit(1);
