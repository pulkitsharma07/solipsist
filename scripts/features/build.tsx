import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { done, register } from "./env";
import { GROUPS, type Entry, type Specimen } from "./types";

const ROOT = join(import.meta.dir, "..", "..");
const css = (f: string) => readFileSync(join(ROOT, "src/app", f), "utf8");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** The app's own styles, as the page loads them; font files point into node_modules from the repo root. */
const appCss = () =>
  ["tokens.css", "chrome.css", "page.css", "margin.css", "chat.css", "settings.css"].map(css).join("\n").replace(/url\("\.\.\/\.\.\/node_modules\//g, 'url("node_modules/');

/** What the app's CSS gets from Tailwind's reset in the real page, and the layout of this document. */
const SHELL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 400 var(--t-md)/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4, p, ul, ol, dl, dd, figure { margin: 0; }
ul, ol { padding: 0; list-style: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; padding: 0; }
a { color: inherit; }
img, svg { display: block; max-width: 100%; }
svg { display: inline-block; }
table { border-collapse: collapse; }

.f-top { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: var(--s4); padding: 10px var(--s5); background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.f-top h1 { font: 500 var(--t-md)/1 var(--sans); letter-spacing: 0; }
.f-top nav { display: flex; gap: var(--s1); flex-wrap: wrap; }
.f-top nav a { text-decoration: none; padding: 4px 10px; border-radius: var(--r-pill); color: var(--ink-2); font-size: var(--t-sm); }
.f-top nav a:hover { background: var(--sunken); color: var(--ink); }
.f-top .f-tools { margin-left: auto; display: flex; gap: var(--s2); align-items: center; }
.f-top input { height: 28px; width: 180px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--raised); }
.f-top input:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
.f-wrap { max-width: 1120px; margin: 0 auto; padding: var(--s7) var(--s5) 120px; }
.f-hero h2 { font: 400 40px/1.1 var(--serif); letter-spacing: -0.02em; margin-bottom: var(--s3); }
.f-hero p { max-width: 62ch; color: var(--ink-2); font: 400 17px/1.6 var(--serif); }
.f-hero p + p { margin-top: var(--s3); }
.f-hero code { font-size: 0.85em; }
.f-group { margin-top: 88px; scroll-margin-top: 70px; }
.f-group > header { display: flex; align-items: baseline; gap: var(--s4); padding-bottom: var(--s3); margin-bottom: var(--s5); border-bottom: 1px solid var(--line); }
.f-group > header .n { font: 500 var(--t-xs)/1 var(--mono); color: var(--agent); }
.f-group > header h2 { font: 400 28px/1.15 var(--serif); letter-spacing: -0.015em; }
.f-group > header p { margin-left: auto; max-width: 46ch; color: var(--ink-3); font-size: var(--t-sm); }
.f-entry { padding: var(--s6) 0; border-bottom: 1px solid var(--line); scroll-margin-top: 70px; display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--s6); }
.f-entry:last-child { border-bottom: 0; }
.f-entry.hide { display: none; }
.f-info h3 { font: 500 var(--t-lg)/1.3 var(--sans); display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.f-kind { font: 500 10px/1 var(--mono); letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); border: 1px solid var(--line-2); border-radius: var(--r-pill); padding: 3px 7px; }
.f-where { margin-top: var(--s2); color: var(--ink-2); font-size: var(--t-sm); }
.f-where b { color: var(--ink-3); font: 500 var(--t-xs)/1 var(--mono); text-transform: uppercase; letter-spacing: 0.05em; margin-right: 6px; }
.f-summary { margin-top: var(--s3); font: 400 15px/1.6 var(--serif); }
.f-info h4 { margin-top: var(--s4); font: 500 var(--t-xs)/1 var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); }
.f-info ul { margin-top: var(--s2); display: flex; flex-direction: column; gap: 6px; font-size: var(--t-sm); color: var(--ink-2); }
.f-info li { padding-left: 14px; position: relative; }
.f-info li::before { content: ""; position: absolute; left: 0; top: 0.62em; width: 5px; height: 1px; background: var(--ink-3); }
.f-src { margin-top: var(--s4); display: flex; flex-wrap: wrap; gap: 4px; }
.f-src code { font-size: 11px; color: var(--ink-3); background: var(--sunken); padding: 2px 6px; border-radius: var(--r-sm); }
.f-specs { display: flex; flex-direction: column; gap: var(--s5); min-width: 0; }
.f-spec > .f-label { display: flex; align-items: baseline; gap: var(--s2); margin-bottom: 6px; font: 500 var(--t-xs)/1.3 var(--mono); color: var(--ink-2); }
.f-spec > .f-label i { font-style: normal; font-weight: 400; color: var(--ink-3); }
.f-stage { --margin-w: 300px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--bg); padding: var(--s4); overflow: hidden; position: relative; }
.f-stage.fx-plain { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; background: var(--surface); }
.f-stage.fx-sheet { background: var(--bg); padding: var(--s4); }
.f-stage.fx-review { background: var(--bg); padding: var(--s4); min-height: 430px; }
.f-stage.fx-sheet .sheet, .f-stage.fx-review .sheet { min-height: 0; width: 100%; padding: 28px 40px; --pad-x: 40px; box-shadow: none; }
.f-stage.fx-bar { padding: 0; background: var(--surface); }
.f-stage.fx-bar .statusbar { position: static; }
.f-stage.fx-margin { background: var(--bg); min-height: 64px; width: min(100%, 340px); }
.f-stage.fx-margin .agent-notes { position: relative; left: 0; margin: 0; width: 100%; height: 36px; }
.f-stage.fx-margin .agent-note { left: 0; }
.f-stage.fx-margin .margin { position: static; display: block !important; width: 100%; margin: 0; }
.f-stage.fx-margin .margin .card { display: block !important; position: relative !important; opacity: 1 !important; top: 0 !important; margin-bottom: var(--s3); }
.f-stage.fx-panel { padding: 0; height: 560px; background: var(--surface); }
.f-stage.fx-panel:has(.comment-modal) { height: auto; }
/* A question hung under its passage, as in the page: the popover and its line hang from the paragraph. */
.f-anchor { position: relative; --pop: var(--review); --pop-edge: var(--review-edge); --pop-soft: var(--review-soft); }
.f-stage.fx-review .sheet { min-height: 540px; }
.f-anchor .comment-modal.anchored { top: calc(100% + 16px); left: -8px; right: auto; width: min(360px, 100%); }
.f-anchor .comment-link { top: 100%; left: 14px; }
.f-stage.fx-panel .debug { position: static; width: 100%; height: 100%; border-left: 0; }
.f-stage.fx-window { padding: 0; background: var(--sunken); }
.f-stage.fx-window .chat-modal { position: static; transform: none; width: 100%; height: auto; max-height: 640px; min-width: 0; animation: none; box-shadow: none; border-radius: 0; }
.f-stage.fx-window .chat-modal { max-height: none; overflow: visible; }
.f-stage.fx-window .chat-log { overflow: visible; flex: none; }
.f-stage.fx-window .dlg { position: static; transform: none; width: 100%; height: 540px; animation: none; box-shadow: none; border-radius: 0; }
.f-stage .dlg-backdrop, .f-stage .dialog-backdrop, .f-stage .comment-scrim { display: none; }
/* The dialogs are fixed over the page in the app; in a picture they sit in their frame, whole. */
.f-stage.fx-window .dialog { position: static; transform: none; width: 100%; max-width: none; max-height: none; border: 0; border-radius: 0; box-shadow: none; animation: none; }
.f-stage.fx-panel .comment-modal { position: static; transform: none; width: 100%; max-height: none; border-radius: 0; box-shadow: none; animation: none; }
.f-stage.fx-side { background: var(--bg); }
.f-stage.fx-side .sug-side { position: static; display: block; box-shadow: var(--shadow-2); }
.f-stage.fx-popup { background: var(--bg); min-height: 70px; }
.f-stage.fx-popup .task-popup { position: static; display: inline-block; }
.f-empty { color: var(--ink-3); font-size: var(--t-sm); }
.f-where-map { margin-top: var(--s5); border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--surface); padding: var(--s4); display: grid; grid-template-columns: minmax(0,1fr) 190px; grid-template-rows: 34px 22px minmax(260px,auto) 30px; gap: 6px; font: var(--t-xs)/1.3 var(--sans); }
.f-where-map a { text-decoration: none; display: flex; align-items: center; justify-content: center; text-align: center; padding: 6px; border: 1px dashed var(--line-2); border-radius: var(--r-md); color: var(--ink-2); background: var(--bg); }
.f-where-map a:hover { border-color: var(--agent); color: var(--agent); }
.f-where-map .m-top { grid-column: 1 / 3; } .f-where-map .m-banner { grid-column: 1 / 3; }
.f-where-map .m-sheet { background: var(--surface); flex-direction: column; gap: 4px; position: relative; }
.f-where-map .m-side { display: grid; grid-template-rows: 1fr 1fr 1fr; gap: 6px; }
.f-where-map .m-bar { grid-column: 1 / 3; }
.f-keys { width: 100%; font-size: var(--t-sm); }
.f-keys td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.f-keys td:first-child { white-space: nowrap; width: 1%; }
.f-keys td:nth-child(2) { white-space: nowrap; color: var(--ink-3); font: var(--t-xs)/1.5 var(--mono); width: 1%; }
.f-foot { margin-top: 96px; color: var(--ink-3); font-size: var(--t-sm); }
@media (max-width: 900px) { .f-entry { grid-template-columns: 1fr; gap: var(--s4); } .f-group > header { flex-direction: column; } .f-group > header p { margin-left: 0; } }
`;

/** The shortcuts, in one place. They are written where they are bound (the files named); this is the writer's view of them. */
const KEYS: [string, string, string][] = [
  ["⌘ .", "Anywhere in the page", "Ask the agent: at the caret it adds a completion point; on a selection it opens the request box; on a selected image, the box to change the image (src/plugins/*/index.ts, markerCommands.ts)"],
  ["⌥⌘ Y", "Caret on a suggestion", "Accept it"],
  ["⌥⌘ N", "Caret on a suggestion", "Reject it"],
  ["⌥⌘ C", "Caret on a suggestion", "Chat with the agent that made it"],
  ["⌥⌘ ]  ·  ⌥⌘ [", "Anywhere in the page", "Go to the next · previous suggestion"],
  ["esc", "A pinned card, an input, the chat", "Close it (the request box: cancel)"],
  ["↵  ·  ⇧↵", "The request box", "Send (an instruction is one line)"],
  ["↵  ·  ⇧↵", "The chat's box", "Send · new line"],
  ["⌘ Z", "The page", "Undo, including a decision on a suggestion"],
  ["ga · gr · gc", "Vim normal mode, caret on a suggestion", "Accept · reject · chat"],
  ["esc · ctrl-[", "Vim insert or visual mode", "Back to normal mode"],
];

const kindClass = (k: string) => k.toLowerCase().replace(/[^a-z]+/g, "-");

async function frame(s: Specimen): Promise<string> {
  const raw = typeof s.html === "function" ? await s.html() : s.html;
  const html = raw;
  const f = s.frame ?? "plain";
  const inner =
    f === "sheet" || f === "review" ? `<article class="sheet">${html}</article>`
    : f === "side" ? `<div class="sug-side">${html}</div>`
    : f === "popup" ? `<div class="task-popup">${html}</div>`
    : html;
  return `<div class="f-spec"><div class="f-label">${esc(s.label)}${s.note ? ` <i>· ${esc(s.note)}</i>` : ""}</div><div class="f-stage fx-${f === "plain" ? "plain" : f}">${inner}</div></div>`;
}

async function entryHtml(e: Entry): Promise<string> {
  const specs = (await Promise.all(e.specimens.map(frame))).join("");
  const li = (xs?: string[]) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  return `<section class="f-entry" id="${e.id}" data-name="${esc(`${e.name} ${e.kind} ${e.where} ${e.summary}`.toLowerCase())}">
  <div class="f-info">
    <h3>${esc(e.name)} <span class="f-kind f-kind-${kindClass(e.kind)}">${esc(e.kind)}</span></h3>
    <p class="f-where"><b>Where</b>${esc(e.where)}</p>
    <p class="f-summary">${esc(e.summary)}</p>
    <h4>Use it for</h4>${li(e.use)}
    ${e.handlers ? `<h4>When touched</h4>${li(e.handlers)}` : ""}
    <div class="f-src">${e.source.map((s) => `<code>${esc(s)}</code>`).join("")}</div>
  </div>
  <div class="f-specs">${specs}</div>
</section>`;
}

const MAP = `<div class="f-where-map" role="group" aria-label="Where things are on the screen">
  <a class="m-top" href="#topbar">Top bar · ← title · save state</a>
  <a class="m-banner" href="#banners">Banners</a>
  <div class="m-sheet" style="display:flex;align-items:center;justify-content:center;border:1px dashed var(--line-2);border-radius:var(--r-md);background:var(--surface);text-align:center;padding:10px;gap:6px;flex-direction:column">
    <a href="#sheet" style="border:0;background:none">The sheet (the page)</a>
    <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">
      <a href="#chat-launch">Page chat button</a><a href="#placeholder-point">Placeholders</a><a href="#suggestion-preview">Suggestions</a><a href="#new-block">New-block line</a><a href="#review-badge">Review badge</a>
    </span>
  </div>
  <div class="m-side"><a href="#agent-note">Agent pills (margin)</a><a href="#suggestion-card">Suggestion card (hover)</a><a href="#debug-panel">Debug panel (when open)</a></div>
  <a class="m-bar" href="#status-bar">Status bar · mode · suggestions · agent · auto-merge · debug · caret · words</a>
</div>`;

export interface BuildOptions { out?: string }

/** The page, as one string. */
export async function buildFeatures(): Promise<string> {
  const own = register();
  try {
    const { catalog } = await import("./catalog");
    const groups = await Promise.all(GROUPS.map(async (g, i) => {
      const entries = catalog.filter((e) => e.group === g.id);
      const body = (await Promise.all(entries.map(entryHtml))).join("");
      return `<section class="f-group" id="g-${g.id}"><header><span class="n">${String(i + 1).padStart(2, "0")}</span><h2>${esc(g.title)}</h2><p>${esc(g.blurb)}</p></header>${body}</section>`;
    }));
    const keys = `<section class="f-group" id="g-keys"><header><span class="n">${String(GROUPS.length + 1).padStart(2, "0")}</span><h2>Keyboard</h2><p>Every shortcut, and where it works. On Linux and Windows ⌘ is Ctrl and ⌥ is Alt; the app's own hints name your keyboard's keys.</p></header><table class="f-keys">${KEYS.map(([k, w, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(w)}</td><td>${esc(d)}</td></tr>`).join("")}</table></section>`;
    const nav = [...GROUPS.map((g) => `<a href="#g-${g.id}">${esc(g.title)}</a>`), `<a href="#g-keys">Keyboard</a>`].join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solipsist: every part of the interface</title>
<style>
${appCss()}
${SHELL_CSS}
</style>
</head>
<body>
<div class="f-top"><h1>Solipsist · features</h1><nav>${nav}</nav><div class="f-tools"><input id="f-filter" type="search" placeholder="Filter parts…" aria-label="Filter parts"><button class="btn btn-ghost" id="f-theme" type="button">Light / dark</button></div></div>
<main class="f-wrap">
  <section class="f-hero">
    <h2>Every part of the interface, once.</h2>
    <p>What each user-facing part is called, where it lives on the screen, what it is for and what touching it does. Arranged the way a writer meets them: the frame around the page, writing, asking the agent, reading its answer, watching it work, talking to it, and the review of changes from outside.</p>
    <p>None of the pictures are drawn here. Each one is the app's own component rendered with sample data, or the real editor with its own extensions put in that state, styled by the app's own CSS. Regenerate it with <code>bun run features</code>; when a component changes, so does its picture. The words come from <code>scripts/features/catalog.tsx</code>, and <code>test/features.test.ts</code> fails when a component exists that this page doesn't list.</p>
  </section>
  ${MAP}
  ${groups.join("\n")}
  ${keys}
  <p class="f-foot">Generated from the code. Fonts load from <code>node_modules</code> when this file is opened from the repository.</p>
</main>
<script>
(() => {
  const root = document.documentElement;
  try { const t = localStorage.getItem("f-theme"); if (t) root.dataset.theme = t; } catch {}
  document.getElementById("f-theme").addEventListener("click", () => {
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("f-theme", root.dataset.theme); } catch {}
  });
  document.getElementById("f-filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll(".f-entry").forEach((el) => el.classList.toggle("hide", !!q && !el.dataset.name.includes(q)));
  });
})();
</script>
</body>
</html>
`;
  } finally {
    if (own) await done();
  }
}

/** What is in the app and not in the catalog: exported components of `src/app/pages` and the editor's extensions. */
export async function uncovered(): Promise<string[]> {
  const { catalog } = await import("./catalog");
  const listed = new Set(catalog.flatMap((e) => e.source));
  const files = [
    ...readdirSync(join(ROOT, "src/app/pages")).filter((f) => f.endsWith(".tsx")).map((f) => `src/app/pages/${f}`),
    ...readdirSync(join(ROOT, "src/app/editor")).filter((f) => f.endsWith(".ts")).map((f) => `src/app/editor/${f}`),
  ];
  // Files that hold no part of the interface of their own: helpers, and the editor's wiring.
  const SKIP = new Set(["src/app/editor/behaviour.ts", "src/app/editor/focus.ts", "src/app/editor/links.ts", "src/app/editor/markers/indicators.ts", "src/app/editor/acceptedSpots.ts"]);
  return files.filter((f) => !listed.has(f) && !SKIP.has(f)).map((f) => relative(ROOT, join(ROOT, f)));
}
