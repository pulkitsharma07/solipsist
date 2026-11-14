// First: FEATURES.html is published, so it is built on none of this machine's settings, prompt edits, logins or paths.
import "../../test/sandbox";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeatures, uncovered } from "./build";

// `bun run features`: writes FEATURES.html at the repository root.
const html = await buildFeatures();
// `FEATURES_OUT` writes it elsewhere (the test does: it runs this in a process of its own, clear of the module mocks other tests leave).
const out = process.env.FEATURES_OUT ?? join(import.meta.dir, "..", "..", "FEATURES.html");
writeFileSync(out, html);
console.log(`FEATURES.html: ${(html.length / 1024).toFixed(0)} KB`);
const missing = await uncovered();
if (missing.length) console.warn(`Not in the catalog: ${missing.join(", ")}`);
process.exit(0);
