// Draws the social preview card (1280x640: what a link to solipsist.sh or to the repository shows) into
// site/public/og.png. Nothing in it is drawn by hand: it is the landing page's own stylesheet and parts (the hero's
// headline and background, the demo's window, the sheet with a suggestion, the suggestion card), laid out for a card.
// It reads site/src/landing.html, so run `bun run site` first. Real Chrome via Playwright, as `bun run site:shots`
// uses (`E2E_CHANNEL` picks another). Run it with `bun run site:og` when the landing page's look or these words
// change, and commit the picture. The fonts are the bundled ones, so it needs no network.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = join(import.meta.dir, "../..");
const out = join(root, "site/public/og.png");
const landing = readFileSync(join(root, "site/src/landing.html"), "utf8");

/** The one match of `re` in the landing page: a part that moved or was renamed stops the script, not the picture. */
function part(re: RegExp, what: string): string {
  const m = re.exec(landing);
  if (!m) throw new Error(`site:og: the landing page has no ${what} (run \`bun run site\`, or update scripts/site/og.ts)`);
  return m[1]!;
}
const css = part(/<style>([\s\S]*?)<\/style>/, "<style>");
const logo = part(/<a class="l-brand" href="#top">(<svg[\s\S]*?<\/svg>)Solipsist<\/a>/, "brand logo");

const font = (pkg: string, file: string) => pathToFileURL(join(root, "node_modules", pkg, "files", file)).href;
const FONTS = `
@font-face { font-family: "Fraunces"; font-weight: 100 900; src: url("${font("@fontsource-variable/fraunces", "fraunces-latin-wght-normal.woff2")}"); }
@font-face { font-family: "Inter"; font-weight: 100 900; src: url("${font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2")}"); }
@font-face { font-family: "IBM Plex Mono"; font-weight: 400; src: url("${font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2")}"); }
@font-face { font-family: "IBM Plex Mono"; font-weight: 500; src: url("${font("@fontsource/ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2")}"); }`;

// Only the layout is written here. The window and the card are zoomed, so their `left`/`top` are in zoomed pixels.
// What matters stays 80px inside every edge (GitHub crops a card); the window's frame runs off the right and bottom.
const LAYOUT = `
*, *::before, *::after { animation: none !important; transition: none !important; }
html, body { width: 1280px; height: 640px; overflow: hidden; margin: 0; background: var(--bg); }
.og-bg { position: absolute; inset: 0; overflow: hidden; }
.og-bg::before { content: ""; position: absolute; inset: -80px; filter: blur(36px); opacity: 0.85; background:
  radial-gradient(38% 50% at 22% 30%, color-mix(in srgb, var(--agent) 24%, transparent), transparent 70%),
  radial-gradient(36% 48% at 78% 22%, color-mix(in srgb, var(--add) 20%, transparent), transparent 70%),
  radial-gradient(32% 44% at 56% 78%, color-mix(in srgb, var(--warn) 16%, transparent), transparent 70%); }
.og-bg::after { content: ""; position: absolute; inset: 0; opacity: 0.5; background-size: 22px 22px;
  background-image: radial-gradient(color-mix(in srgb, var(--ink) 22%, transparent) 1px, transparent 1.2px);
  -webkit-mask-image: radial-gradient(70% 80% at 30% 40%, #000, transparent 80%); }
.og-left { position: absolute; left: 84px; top: 84px; width: 500px; height: 472px; display: flex; flex-direction: column; }
.og-left .l-brand { font-size: 34px; gap: 16px; }
.og-left .l-brand svg { width: 46px; height: 46px; }
.og-left h1 { font: 600 53px/1.06 var(--sans); letter-spacing: -0.035em; margin: 58px 0 0; text-wrap: balance; }
.og-left .l-lede { font-size: 25px; line-height: 1.4; margin: 24px 0 0; max-width: none; }
.og-foot { margin-top: auto; font: 400 19px/1 var(--mono); color: var(--ink-2); }
.og-win { position: absolute; left: 525px; top: 46px; width: 640px; zoom: 1.22; margin: 0; }
.og-win .l-desk { grid-template-columns: minmax(0, 1fr); padding: 24px 24px 400px; }
.og-win .sheet { --pad-x: 38px; padding: 34px var(--pad-x) 300px; min-height: 0; width: auto; }
.og-win .tiptap { max-width: 386px; }
.og-card { position: absolute; left: 696px; top: 334px; zoom: 1.22; }
.og-card .sug-side { position: static; width: 280px; max-height: none; overflow: visible; }`;

const HTML = `<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><style>${css}</style><style>${FONTS}${LAYOUT}</style>
<body>
<div class="og-bg"></div>
<div class="og-left">
  <span class="l-brand">${logo}Solipsist</span>
  <h1>Think and work with AI agents in your markdown docs</h1>
  <p class="l-lede">They suggest; you decide.</p>
  <div class="og-foot">solipsist.sh</div>
</div>
<div class="l-win l-app og-win">
  <div class="l-winbar">launch-plan.md</div>
  <div class="l-desk"><article class="sheet"><div class="tiptap ProseMirror">
    <h1>Q3 launch plan</h1>
    <p>We open the second shop on 14 August. In the trial, repeat orders rose from 18% to 31%.</p>
    <p>The main risk is <span class="sug-preview sug-inline">that the 212 trial customers chose to take part, so the 31% repeat rate may be higher than a typical customer’s.</span></p>
  </div></article></div>
</div>
<div class="og-card l-app"><div class="sug-side" data-kind="suggestion"><div class="task-card sug-card" data-kind="suggestion"><header>Suggestion</header><p class="sug-note">Named the main risk, using the survey and the order data.</p><div class="task-row sug-actions"><button type="button" class="task-btn primary">Accept</button><button type="button" class="task-btn ghost">Reject</button><button type="button" class="task-btn">Ask again</button><button type="button" class="task-btn ghost">Chat</button></div></div></div></div>
</body></html>`;

// A file, not `setContent`: a page without a file: address may not load the fonts from disk.
const dir = mkdtempSync(join(tmpdir(), "solipsist-og-"));
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
try {
  writeFileSync(join(dir, "og.html"), HTML);
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(dir, "og.html")).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`wrote ${out}`);
