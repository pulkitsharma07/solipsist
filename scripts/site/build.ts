// Writes the website's two generated files; site/ is an Astro Starlight project that serves them (its `dev` and
// `build` run this first; .github/workflows/pages.yml publishes site/dist):
// - site/src/landing.html, the landing page at /, from scripts/site/template.html: the app's real stylesheet (from
//   FEATURES.html) goes in at /*APP_CSS*/, the engine marks at <!--PI:size-->, and the version from package.json at
//   <!--VERSION-->, so the demos are drawn by the app's own CSS and icons. Run `bun run features` first if the
//   catalogue is stale.
// - the documentation's configuration reference, from CONFIGURATION.md, so the two never differ;
// - site/public/features.html, a copy of FEATURES.html, served as /features.html.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
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

writeFileSync(join(root, "site/src/landing.html"), html);
console.log(`site/src/landing.html: ${html.length} bytes (${appCss.length} bytes of app CSS)`);

// CONFIGURATION.md as a docs page: its title becomes the frontmatter, and a link to a file of the repo goes to GitHub.
const configMd = readFileSync(join(root, "CONFIGURATION.md"), "utf8");
if (!configMd.startsWith("# Configuration\n")) throw new Error("site: CONFIGURATION.md no longer starts with its title");
const repoFile = "https://github.com/pulkitsharma07/solipsist/blob/main/";
const configPage = [
  "---",
  "title: Configuration",
  "description: Every setting, its default, and where it can be set.",
  "editUrl: " + repoFile.replace("/blob/", "/edit/") + "CONFIGURATION.md",
  "sidebar:",
  "  order: 1",
  "---",
  "",
  "<!-- Generated from CONFIGURATION.md by scripts/site/build.ts: edit that file instead. -->",
  configMd.slice("# Configuration\n".length).replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, f) => `](${repoFile}${f})`),
].join("\n");
writeFileSync(join(root, "site/src/content/docs/docs/reference/configuration.md"), configPage);
console.log(`site/src/content/docs/docs/reference/configuration.md: ${configPage.length} bytes`);

// The protocol every agent is told (src/server/agent/protocol.md), published as it is: what the agent is asked to do.
const protocolPage = [
  "---",
  "title: The protocol",
  "description: Exactly what every agent is told about tasks, markers and how to reply.",
  "editUrl: " + repoFile.replace("/blob/", "/edit/") + "src/server/agent/protocol.md",
  "sidebar:",
  "  order: 6",
  "---",
  "",
  "<!-- Generated from src/server/agent/protocol.md by scripts/site/build.ts: edit that file instead. -->",
  "This is the `protocol` [prompt](/docs/agents/prompts/): it goes in every agent's system prompt, before the prompt for the run. You can read and change it in settings. `{guide}` stands for the path of the image guide.",
  "",
  readFileSync(join(root, "src/server/agent/protocol.md"), "utf8"),
].join("\n");
writeFileSync(join(root, "site/src/content/docs/docs/agents/protocol.md"), protocolPage);
console.log(`site/src/content/docs/docs/agents/protocol.md: ${protocolPage.length} bytes`);

copyFileSync(join(root, "FEATURES.html"), join(root, "site/public/features.html"));
console.log("site/public/features.html: copied from FEATURES.html");
