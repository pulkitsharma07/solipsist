// Builds the website, site/index.html, from scripts/site/template.html: the app's real stylesheet (from
// FEATURES.html) goes in at /*APP_CSS*/, the engine marks at <!--PI:size-->, and the version from
// package.json at <!--VERSION-->, so the demos are drawn by the app's own CSS and icons.
// Run `bun run features` first if the catalogue is stale, then `bun run site`. GitHub Pages serves site/
// (.github/workflows/pages.yml).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const features = readFileSync(join(root, "FEATURES.html"), "utf8");
const src = readFileSync(join(import.meta.dir, "template.html"), "utf8");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const styleStart = features.indexOf("<style>");
const baseBanner = features.lastIndexOf("/* ===", features.indexOf("2. BASE"));
if (styleStart < 0 || baseBanner < 0) throw new Error("site: no stylesheet in FEATURES.html");
const appCss = features.slice(baseBanner, features.indexOf("</style>", styleStart));

function svg(cls: string): string {
  const at = features.indexOf(`<svg class="${cls}"`);
  if (at < 0) throw new Error(`site: no <svg class="${cls}"> in FEATURES.html`);
  return features.slice(at, features.indexOf("</svg>", at) + 6);
}
const sized = (s: string, n: string) => s.replace(/width="\d+" height="\d+"/, `width="${n}" height="${n}"`);
const pi = svg("pi-logo");

if (!src.includes("/*APP_CSS*/")) throw new Error("site: the template lost /*APP_CSS*/");
if (!src.includes("<!--VERSION-->")) throw new Error("site: the template lost <!--VERSION-->");
const html = src
  .replace("/*APP_CSS*/", () => appCss)
  .replace(/<!--PI:(\d+)-->/g, (_, n) => sized(pi, n))
  .replace(/<!--PIWORK-->/g, () => sized(pi, "14").replace('class="pi-logo"', 'class="pi-logo note-icon ni-work"'))
  .replaceAll("<!--VERSION-->", () => version);
if (/<!--PI:|<!--PIWORK-->|<!--VERSION-->/.test(html)) throw new Error("site: a slot was left unfilled");

const out = join(root, "site/index.html");
writeFileSync(out, html);
console.log(`site/index.html: ${html.length} bytes (${appCss.length} bytes of app CSS)`);
