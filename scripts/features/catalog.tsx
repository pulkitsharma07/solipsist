import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { answered, editorHtml, openCard, pageEditor, suggestion } from "./page";
import { CHART, CHART_AGAIN, CHAT, CHAT_REPLY, EVENTS, MODEL_CATALOG, MODELS, settingsData } from "./fixtures";
import { PAGE_CHAT } from "../../src/shared/chat";
import type { Entry } from "./types";

/**
 * Every part of the interface the writer can see, once, with what it is called, where it is, what it is for and what
 * touching it does. The pictures are not drawn here: each specimen is the app's own component rendered with fixtures,
 * or the real editor (with its own extensions) put in a state. What is written here is the words, and which states to show.
 */

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);
const noop = () => {};
const imp = <T,>(path: string) => import(path) as Promise<T>;

/** A page the agent has answered: the editor's DOM, and the card behind a click on its diff. */
async function answeredPage(md: string, id: string, reply: string, agent?: { engine: string; model: string; session: string }) {
  const { markdown, records } = await answered(md, id, reply, agent);
  const editor = await pageEditor(markdown, records, { onChat: true });
  return { editor, html: editorHtml(editor), card: () => openCard(editor, id) };
}
const KEPT = { engine: "pi", model: "openrouter/~moonshotai/kimi-latest", session: "s-1" };

export const catalog: Entry[] = [
  // ------------------------------------------------------------------ the frame
  {
    id: "pages-list", group: "frame", name: "Pages", kind: "React component", where: "The home screen, at /",
    summary: "The list of pages (the .md files in the docs folder), newest first.",
    use: ["Find a page to open, or start a new one."],
    handlers: ["The gear: opens the settings dialog.", "New page: creates an empty page and opens it.", "A page's file name: opens it at /d/<id>. Its first line is beside it.", "The time is when the file last changed."],
    specimens: [{ label: "With pages", html: () => { const { PagesView } = require("../../src/app/pages/Pages"); return render(<PagesView docs={[{ id: "a1", title: "Plan for Q3", mtime: Date.parse("2026-11-01T10:42:00Z") }, { id: "b2", title: "Meeting notes", mtime: Date.parse("2026-10-30T16:05:00Z") }]} onNew={noop} />); } }, { label: "Empty", html: () => { const { PagesView } = require("../../src/app/pages/Pages"); return render(<PagesView docs={[]} onNew={noop} />); } }],
    source: ["src/app/pages/Pages.tsx"],
  },
  {
    id: "topbar", group: "frame", name: "TopBar", kind: "React component", where: "Top of a page, full width",
    summary: "Where you are and whether your words are safe: a way back, the page's title, and the save state.",
    use: ["Go back to all pages.", "Know at a glance whether the page is saved: nothing else in the app says it."],
    handlers: ["← : back to the list of pages.", "Copy page, beside the gear: copies the page for GitHub and Google Docs (see Copy page).", "The gear at the right end: opens the settings dialog.", "Save state changes by itself as you type: Unsaved changes → Saving… → Saved, or \"Can't save, retrying…\" in red when the server isn't answering."],
    specimens: (["saved", "dirty", "saving", "error"] as const).map((s) => ({ label: s === "saved" ? "Saved" : s === "dirty" ? "Unsaved changes" : s === "saving" ? "Saving…" : "Can't save", html: () => { const { TopBar } = require("../../src/app/pages/Frame"); return render(<TopBar title="Plan for Q3" save={s} />); }, frame: "bar" as const })),
    source: ["src/app/pages/Frame.tsx"],
  },
  {
    id: "newer-page", group: "frame", name: "A page from a newer Solipsist", kind: "React component", where: "In place of the page, when its file was saved by a newer build",
    summary: "A page whose format is newer than this build knows is shown read-only: nothing here can change it until Solipsist is updated.",
    use: ["Read a page a newer Solipsist saved, without risking it: no saving, no agents, no Sync."],
    handlers: ["The banner names the page's format and the newest this build knows, and says to update. The top bar reads Read-only. The server refuses any write to the page (423) in case one is tried."],
    specimens: [
      { label: "Saved by format 2, opened by a format-1 build", frame: "window", html: () => { const { NewerPage } = require("../../src/app/pages/NewerPage"); return render(<NewerPage title="notes/plan.md" format={2} file={"# Plan\n\n<!-- solip-comments\n\"format\": 2\n\"comments\": {}\n-->\n"} />); } },
    ],
    source: ["src/app/pages/NewerPage.tsx", "src/shared/docfile/file.ts", "src/server/files.ts"],
  },
  {
    id: "banners", group: "frame", name: "Banners", kind: "React component", where: "Under the top bar, one strip per problem",
    summary: "Strips that say what is wrong with the page's connection or file, with the one thing to do about it.",
    use: ["Another tab has the page open (only one may).", "The connection to the server is lost.", "The file changed elsewhere while you were typing."],
    handlers: ["try again: reloads the page.", "Reload: takes the other version. Keep mine: keeps yours and writes it over theirs."],
    specimens: [
      { label: "Open in another tab", html: () => { const { Banners } = require("../../src/app/pages/Frame"); return render(<Banners conn="refused" conflict={false} onReload={noop} onKeepMine={noop} />); }, frame: "bar" },
      { label: "Connection lost", html: () => { const { Banners } = require("../../src/app/pages/Frame"); return render(<Banners conn="offline" conflict={false} onReload={noop} onKeepMine={noop} />); }, frame: "bar" },
      { label: "Changed elsewhere", html: () => { const { Banners } = require("../../src/app/pages/Frame"); return render(<Banners conn="live" conflict onReload={noop} onKeepMine={noop} />); }, frame: "bar" },
    ],
    source: ["src/app/pages/Frame.tsx"],
  },

  {
    id: "support-nudge", group: "frame", name: "SupportNudge", kind: "React component", where: "Under the top bar, when a page opens",
    summary: "A quiet strip asking you to buy a licence, once you have written on support.after_days days (14 by default). Nothing is locked and nothing is sent anywhere: the count stays in support.json on this machine.",
    use: ["Buy a licence if Solipsist is useful to you.", "Say you already have one, or put it off."],
    handlers: ["Buy a licence: opens the shop in a new tab.", "I've bought one: never asks again.", "Later: asks again after 7 more days of writing.", "It is checked only when a page opens, so it never appears while you write."],
    specimens: [{ label: "After 14 days", html: () => { const { SupportNudge } = require("../../src/app/pages/Frame"); return render(<SupportNudge days={14} url="https://example.com/buy" onLater={noop} onPaid={noop} />); }, frame: "bar" }],
    source: ["src/app/pages/Frame.tsx", "src/server/support.ts"],
  },
  {
    id: "settings-gear", group: "frame", name: "Settings gear", kind: "React component", where: "Right end of the top bar, and in the header of the pages list",
    summary: "A gear that opens the settings dialog, from a page or from the list of pages.",
    use: ["Reach the prompts and the loaded settings without leaving the page you are writing."],
    handlers: ["Click: opens the settings dialog over the page. Escape or the ✕ closes it."],
    specimens: [{ label: "In the top bar", html: () => { const { TopBar } = require("../../src/app/pages/Frame"); return render(<TopBar title="Plan for Q3" save="saved" />); }, frame: "bar" }],
    source: ["src/app/pages/SettingsDialog.tsx", "src/app/pages/Frame.tsx", "src/app/pages/PagesView.tsx"],
  },
  {
    id: "copy-page", group: "frame", name: "Copy page", kind: "React component", where: "Just above the page, on its right",
    summary: "Copies the page as you see your own text (unsaved edits included), in two formats at once: markdown for GitHub and rich text for Google Docs. Markers, suggestions, margin comments and hand-written HTML comments are left out; a range's text stays.",
    use: ["Paste the page into a GitHub issue, PR or comment: the markdown keeps image paths as written (relative to the page's folder), which render when that folder is in the repo.", "Paste it into Google Docs: headings, lists, tables, code and links come across, and the images are embedded (SVG and other formats drawn as PNG), up to 8 MB of images in all; past that the rest are links to this server."],
    handlers: ["Click: copies. Its label is always \"Copy page as markdown\".", "Copied (green check) for two seconds; its title says if any image was linked rather than embedded, and why.", "Couldn't copy (red) when the browser refused the clipboard; its title has the reason.", "No key: ⌥⌘C is the card's chat, and ⇧⌘C is the browser's inspector."],
    specimens: (["idle", "copied", "failed"] as const).map((s) => ({
      label: s === "idle" ? "Ready" : s === "copied" ? "Copied" : "Couldn't copy",
      html: () => {
        const { CopyButtonView } = require("../../src/app/pages/CopyButton");
        const copy = s === "idle" ? { state: s } : s === "copied" ? { state: s, note: "Copied" } : { state: s, note: "Couldn't copy: Write permission denied." };
        return render(<div className="sheet-tools" style={{ position: "static" }}><CopyButtonView copy={copy} onCopy={noop} /></div>);
      },
      frame: "bar" as const,
    })),
    source: ["src/app/pages/CopyButton.tsx", "src/app/doc/copyPage.ts", "src/app/pages/Sheet.tsx", "src/app/chrome.css"],
  },
  {
    id: "settings-prompts", group: "frame", name: "Prompts (settings dialog)", kind: "React component", where: "The settings dialog, first tab",
    summary: "Every instruction the agents are given, to read and change: the protocol, the prompt each run is sent, one prompt per kind of placeholder, and the chat prompts.",
    use: ["Change how the agents behave without editing the app: shorter answers, another voice, a house style for one kind of placeholder.", "See what the agents are actually told, with the slots the server fills in."],
    handlers: ["A prompt in the list: opens it in the editor. \"edited\" marks a prompt whose file of yours is in use; \"unsaved\", one with a change not yet saved.", "Save: keeps the text as a file in your prompts folder (~/.config/solipsist/prompts). It is refused, with the reason, if it is empty or leaves out a required {slot}.", "Revert: drops the unsaved changes.", "Reset to default: deletes your file and brings the built-in text back.", "A change applies to the next run and the next agent started; one already running or waiting keeps what it began with.", "Closing with unsaved changes asks once."],
    specimens: [{ label: "An edited prompt open", frame: "window", html: async () => { const { SettingsDialog } = require("../../src/app/pages/SettingsDialog"); const d = await settingsData(); d.prompts.prompts = d.prompts.prompts; return render(<SettingsDialog onClose={noop} prompts={{ ...d.prompts, prompts: d.prompts.prompts }} config={d.config} />); } }],
    source: ["src/app/pages/PromptsPane.tsx", "src/app/pages/SettingsDialog.tsx", "src/server/prompts.ts", "src/app/settings.css"],
  },
  {
    id: "settings-loaded", group: "frame", name: "Loaded settings (settings dialog)", kind: "React component", where: "The settings dialog, second tab",
    summary: "The settings the server is running with, by section, each with its value and where the value came from.",
    use: ["Check what is in effect: a value from the default, from solipsist.yaml, or from an environment variable (named).", "Find out why a setting isn't what you expected. A secret shows only as \"set\"."],
    handlers: ["Filter: narrows the list by key, environment name or description.", "Hover a key: what it does and its environment name.", "Read only: change settings in solipsist.yaml or the environment and restart."],
    specimens: [{ label: "Defaults, a file and an environment variable", frame: "window", html: async () => { const { SettingsDialog } = require("../../src/app/pages/SettingsDialog"); const d = await settingsData(); return render(<SettingsDialog onClose={noop} tab="settings" prompts={d.prompts} config={d.config} />); } }],
    source: ["src/app/pages/SettingsPane.tsx", "src/server/config.ts", "src/app/settings.css"],
  },

  // ------------------------------------------------------------------ writing
  {
    id: "sheet", group: "writing", name: "Sheet (the editor)", kind: "Tiptap extension", where: "Centre of the screen: the page, in a serif at reading size",
    summary: "A Tiptap editor on one markdown file. What you type is saved to the .md file; nothing else is stored.",
    use: ["Write: headings, lists, tables, code, images, links; markdown shortcuts work as you type.", "Everything else in this file is something that happens in or beside this sheet."],
    handlers: ["Typing saves after a short pause (see TopBar).", "Cmd/Ctrl-Z undoes your edits and your decisions on suggestions.", "The page is focused when it opens."],
    specimens: [{
      label: "A page", frame: "sheet",
      html: async () => editorHtml(await pageEditor("# Plan for Q3\n\nThe deadline is **end of Q3**, and the review is on [the calendar](https://example.com).\n\n- Ship the editor\n- Write the docs\n\n| Team | Date |\n| --- | --- |\n| Web | 3 Sep |\n")),
    }],
    source: ["src/app/pages/Sheet.tsx", "src/app/editor/behaviour.ts"],
  },
  {
    id: "vim", group: "writing", name: "Vim mode", kind: "Tiptap extension", where: "In the sheet; switched from the status bar's left button",
    summary: "Optional Vim keys for the sheet: normal, insert, visual and visual-line modes, with a block cursor.",
    use: ["Move and edit without the mouse. Off by default (the status bar says Standard)."],
    handlers: ["Click the mode button in the status bar: Vim on or off.", "Esc (or Ctrl-[): back to normal. i, a, I, A, o, O: insert. v, V: visual. h j k l, w b e, 0 ^ $, gg G, { }, Ctrl-d / Ctrl-u (half a screen down / up, in visual mode extending the selection), counts, and the operators d, c, y with x, s, p.", "On a suggestion: ga accepts, gr rejects, gc opens its chat."],
    specimens: [{ label: "Normal mode: the block cursor", frame: "sheet", html: async () => { const { setVim } = await imp<typeof import("../../src/app/editor/vim")>("../../src/app/editor/vim"); const e = await pageEditor("The cursor is a block in normal mode."); e.commands.focus("start"); setVim(e, true); return editorHtml(e); } }],
    source: ["src/app/editor/vim.ts"],
  },
  {
    id: "new-block", group: "writing", name: "New-block line", kind: "ProseMirror decoration", where: "Left of a block that just arrived from outside",
    summary: "A block added by another editor or by the loop gets a line down its left edge, so you can see what is new.",
    use: ["See at a glance what appeared while you were away.", "Throw a new block away: hover its line and click the cross."],
    handlers: ["Hover the line: a cross appears. Click it: the block is deleted (an ordinary edit: Undo brings it back)."],
    specimens: [{ label: "A block marked new", frame: "sheet", html: async () => { const { newBlockKey } = await imp<typeof import("../../src/app/editor/newBlocks")>("../../src/app/editor/newBlocks"); const e = await pageEditor("An ordinary paragraph.\n\nThis paragraph arrived from outside.\n\nAnother ordinary one."); let pos = 0; e.state.doc.forEach((n, o, i) => { if (i === 1) pos = o; }); e.view.dispatch(e.state.tr.setMeta(newBlockKey, { add: [{ from: pos, to: pos + 2 }] })); return editorHtml(e); } }],
    source: ["src/app/editor/newBlocks.ts"],
  },
  {
    id: "fresh-text", group: "writing", name: "Fresh text", kind: "ProseMirror decoration", where: "Inline in the sheet",
    summary: "Text that arrived from outside fades in, so the eye catches it.",
    use: ["Notice a change without a notification: the words glow for a moment, then settle."],
    specimens: [{ label: "Just arrived", frame: "sheet", html: async () => { const { freshKey } = await imp<typeof import("../../src/app/editor/freshText")>("../../src/app/editor/freshText"); const e = await pageEditor("The deadline is end of Q3, and this sentence just arrived."); const text = e.state.doc.textContent; const from = text.indexOf("and this") + 1; e.view.dispatch(e.state.tr.setMeta(freshKey, { add: [{ from, to: from + 30 }] })); return editorHtml(e); } }],
    source: ["src/app/editor/freshText.ts"],
  },
  {
    id: "html-comment", group: "writing", name: "HTML comment chip", kind: "Tiptap extension", where: "In the sheet, where a hand-written <!-- … --> comment is",
    summary: "A comment you wrote in the markdown (not one of ours) shows as a small chip with its first words; the file keeps it byte for byte.",
    use: ["Leave notes to yourself in the file without them showing as page text."],
    handlers: ["Hover: the whole comment is the tooltip. The chip can't be typed into; delete it as a unit."],
    specimens: [{ label: "A comment in a paragraph and between blocks", frame: "sheet", html: async () => editorHtml(await pageEditor("Check the date <!-- ask finance before Friday --> before sending.\n\n<!-- TODO: add the budget table once it exists -->\n\nThe next paragraph.")) }],
    source: ["src/app/editor/htmlCommentChips.ts"],
  },
  {
    id: "comments-margin", group: "writing", name: "Margin comments", kind: "React component", where: "Left margin, level with the highlighted passage",
    summary: "Questions about a passage, as cards beside it (Google Docs style). Closed, a card is its gloss: the two-to-five-word note a reader pencils in the margin.",
    use: [
      "Read a question about a passage without leaving the page.",
      "Take one down (Dismiss) when you have considered it: the Reader never raises that passage again.",
    ],
    handlers: [
      "Click a highlighted passage, or its card: the question opens in a window of its own, and the card counts as read, which keeps a better question from taking its place.",
      "A card whose question carries a picture shows a small square; the picture itself is in the window.",
      "Questions on nearby lines share the room around their passages and never cover each other. A click on a highlight inside a block a suggestion would change opens the question, not the suggestion's card.",
    ],
    specimens: [{ label: "Two questions, closed", frame: "margin", html: () => { const { Margin } = require("../../src/app/pages/Margin"); const c = (id: string, title: string, gloss: string, body?: string, description?: string) => ({ id, status: "open", thinker: "reader", title, gloss, body, description, score: 8, anchor: {}, created: "2026-11-01T10:00:00Z", created_rev: 1 }); return renderToStaticMarkup(<Margin editor={null} comments={[c("c1", "Fiscal or calendar: which Q3 is this?", "which Q3?", "The date carries the plan and the page never says which.", "Both teams read this, and they keep different calendars, so one of them will read it the wrong way."), c("c2", "What makes this obvious, and to whom?", "obvious to whom?")] as never} placed={new Set(["c1", "c2"])} />); } }],
    source: ["src/app/pages/Margin.tsx", "src/server/review/index.ts", "src/server/place.ts"],
  },
  {
    id: "page-review", group: "writing", name: "Page review", kind: "React component", where: "Status bar or agent panel (the button); the left margin and the sheet (the questions)",
    summary: "A reviewer reads the page and leaves questions beside the passages it can't follow. It writes nothing in the page: a question is a note, not a change.",
    use: [
      "Press Page review to have the page read like a reader would: what is unclear, unsupported or missing.",
      "See where each question is about: the passage is underlined, and its card sits in the left margin.",
      "Open a question to read it in full, take it down (Dismiss) or carry it into the chat (Ask).",
    ],
    handlers: [
      "Page review blinks and reads “Reviewing…” while it runs; its steps are in the agent panel, and when it ends the panel says what became of every question.",
      "A highlighted passage or its card opens the question. With room, the popover hangs in the margin beside the passage; on a laptop it opens just under it. A thin line joins it to the passage and the rest of the page steps back.",
      "The status bar counts the questions, which matters when the window is too narrow for the margin.",
      "Escape, a click away or ✕ closes it. Questions are stored in the page's hidden block and never change the text.",
    ],
    specimens: [
      {
        label: "A question, open under its passage", note: "the blue is the question's accent; suggestions are green, answers orange", frame: "review",
        html: async () => {
          const { CommentModal } = require("../../src/app/pages/CommentModal");
          const e = await pageEditor("# Why small teams ship faster\n\nAdding engineers to a late project makes it later, and yet we keep hiring.\n\nThe alternative is duller than it sounds. You cut scope until the thing fits in one head, and you let that head decide.\n\nNone of this is new. It is just rarely done.");
          const passage = "Adding engineers to a late project makes it later";
          let page = editorHtml(e).replace(passage, `<span class="hl active" data-comment="c1">${passage}</span>`).replace(/<p>(<span class="hl active")/, '<div class="f-anchor"><p>$1');
          page = page.replace(/(<\/span>, and yet we keep hiring\.<\/p>)/, "$1@@POP@@</div>").replace(/class="tiptap ProseMirror/, 'class="tiptap ProseMirror spot');
          const q = { id: "c1", status: "open", thinker: "reviewer", model: "pi:openrouter/deepseek/deepseek-v4-flash", title: "Brooks's law, stated as a fact", gloss: "sourced?", body: "This is Brooks's law, written as if it were always true. Readers will want to know it is an observation.", description: "The next clause carries the real argument, about why managers hire anyway. Naming Brooks, or softening to “tends to”, keeps it from resting on an overstated rule.", score: 8, anchor: { exact: passage }, created: "2026-11-01T10:00:00Z", created_rev: 1 };
          const pop = renderToStaticMarkup(<CommentModal comment={q as never} onDismiss={noop} onAsk={noop} onClose={noop} />)
            .replace(/<div class="comment-scrim"[^>]*><\/div>/, "").replace('class="comment-modal"', 'class="comment-modal anchored below"');
          const link = '<svg class="comment-link" aria-hidden="true"><path d="M0 -2 L0 16"></path><circle cx="0" cy="-2" r="3.5"></circle></svg>';
          return page.replace("@@POP@@", link + pop);
        },
      },
      { label: "Closed, in the margin", frame: "margin", html: () => { const { Margin } = require("../../src/app/pages/Margin"); const c = (id: string, title: string, gloss: string) => ({ id, status: "open", thinker: "reader", title, gloss, score: 8, anchor: {}, created: "2026-11-01T10:00:00Z", created_rev: 1 }); return renderToStaticMarkup(<Margin editor={null} comments={[c("c1", "Brooks's law, stated as a fact", "sourced?"), c("c2", "Evidence for “shipped twice”", "evidence for “twice”?")] as never} placed={new Set(["c1", "c2"])} />); } },
    ],
    source: ["src/app/pages/StatusBar.tsx", "src/app/pages/DebugPanel.tsx", "src/app/pages/Margin.tsx", "src/app/pages/CommentModal.tsx", "src/server/review/index.ts"],
  },
  {
    id: "comment-modal", group: "writing", name: "A question, opened", kind: "React component", where: "Over the page, from a margin card or a highlighted passage",
    summary: "One review question in full: the passage it is about, the point, the reviewer's reasoning, the picture it drew, and who asked.",
    use: [
      "Read the whole question, which never fits in the margin.",
      "See which reviewer and which model asked it — the same question from a small model and a large one is not the same question.",
      "Take it down (Dismiss), or carry it into the chat (Ask).",
    ],
    handlers: [
      "Escape, the backdrop or ✕ closes it; the margin keeps its cards where they are.",
      "Dismiss: the question goes for good, and that passage is never raised again.",
      "There is no Accept or Reject: a question puts nothing in the page, so there is nothing to accept.",
    ],
    specimens: [
      { label: "The window form, for a narrow screen", note: "the reviewer's own picture, when it drew one, goes under the point", frame: "panel", html: () => { const { CommentModal } = require("../../src/app/pages/CommentModal"); const c = { id: "c1", status: "open", thinker: "reviewer", model: "pi:openrouter/deepseek/deepseek-v4-flash", title: "Fiscal or calendar: which Q3 is this?", gloss: "which Q3?", body: "The date carries the plan and the page never says which.", description: "Both teams read this, and they keep different calendars, so one of them will read it the wrong way. Which one did you mean?", score: 8, anchor: { exact: "The deadline is the end of Q3 for all teams." }, created: "2026-11-01T10:00:00Z", created_rev: 1 }; return renderToStaticMarkup(<CommentModal comment={c as never} onDismiss={noop} onAsk={noop} onClose={noop} />); } },
    ],
    source: ["src/app/pages/CommentModal.tsx"],
  },

  // ------------------------------------------------------------------ asking
  {
    id: "placeholder-point", group: "asking", name: "Completion point (gen)", kind: "Tiptap extension", where: "Inline in the sheet, at the caret when you pressed ⌘.",
    summary: "A spot where the writer asked the agent to decide what belongs (text, a list, a table, an image).",
    use: ["Hand over a gap: put the caret where the answer should go and press ⌘. (Ctrl-. on other systems)."],
    handlers: ["⌘.: inserts the point at the caret; the agent picks it up.", "It moves through four states: waiting, being worked on, a suggestion waiting, and done (nothing left to show). Its picture changes with each; when the answer is ready the picture goes and the suggestion shows in its place."],
    specimens: [
      { label: "Waiting to be picked up", note: "a dot fading in and out", frame: "sheet", html: async () => editorHtml(await pageEditor("The deadline is <!-- gen:abc --> for all teams.")) },
      { label: "Being worked on", note: "a ring with an arc turning", frame: "sheet", html: async () => editorHtml(await pageEditor("The deadline is <!-- gen:abc:ack --> for all teams.")) },
      { label: "A suggestion waiting", note: "no picture: the suggestion is the picture", frame: "sheet", html: async () => (await answeredPage("The deadline is <!-- gen:abc --> for all teams.", "abc", suggestion("30 September"))).html },
    ],
    source: ["src/plugins/gen/index.ts", "src/app/editor/pointView.ts", "src/app/editor/markers/loader.ts", "src/app/editor/markers/indicators.ts", "src/app/editor/markers/registry.ts"],
  },
  {
    id: "placeholder-range", group: "asking", name: "Request range (sel)", kind: "Tiptap extension", where: "Inline in the sheet, around the text that was selected when you pressed ⌘.",
    summary: "Text the writer asked the agent about or to change, with an optional instruction (\"make it shorter\").",
    use: ["Select text and press ⌘.: ask or tell the agent something about it. Type the instruction, Enter, and it is sent."],
    handlers: ["⌘. on a selection: opens the instruction input under it; Enter sends, Esc cancels.", "Click its loader (pending): reopens the instruction to read or change it.", "A selection that can't be marked says why under it: nothing selected, part of it already has a request, it holds a code block, or it starts or ends inside inline code."],
    specimens: [
      { label: "Waiting", frame: "sheet", html: async () => editorHtml(await pageEditor("Please check <!-- sel:xyz \"is this still right?\" -->the end of Q3 date<!-- /sel:xyz --> before we send it.")) },
      { label: "Being worked on", frame: "sheet", html: async () => editorHtml(await pageEditor("Please check <!-- sel:xyz:ack \"is this still right?\" -->the end of Q3 date<!-- /sel:xyz:ack --> before we send it.")) },
    ],
    source: ["src/plugins/sel/index.ts", "src/app/editor/rangeLoaders.ts", "src/app/editor/markerCommands.ts"],
  },
  {
    id: "placeholder-image", group: "asking", name: "Image request (img)", kind: "Tiptap extension", where: "Around an image in the sheet, with a hint in the image's corner while it is selected",
    summary: "An image the writer asked the agent to draw again, with what to change (\"make the bars horizontal\"). The agent writes a new file and suggests it in the old one's place.",
    use: ["Change a picture without drawing it: select the image and press ⌘., then say what to change.", "In vim, `v` or `V` on the image's line selects it; otherwise click it or drag over it."],
    handlers: ["While the selection holds one image: the image gets a dashed ring and \"⌘. to change\" in its corner. A selection of text that happens to hold an image is still a request about the text.", "⌘. on it: opens the instruction input over the image. An instruction is required: Enter with nothing typed shakes the box.", "An image already being asked about says so instead of being asked about twice.", "The suggestion is the new image where the old one is: the old one dimmed and ringed, the new one beside it (Accept, Reject, Ask again, Chat as for any other)."],
    specimens: [
      { label: "Selected: the key is there", note: "the hint the writer sees first", frame: "sheet", html: async () => { const editor = await pageEditor(`Signups have risen every week.\n\n![Signups by week, rising from 120 to 310](${CHART})`); let at = 0; editor.state.doc.descendants((n, pos) => { if (n.type.name === "image") at = pos; }); editor.commands.setTextSelection({ from: at, to: at + 1 }); return editorHtml(editor); } },
      { label: "Waiting", frame: "sheet", html: async () => editorHtml(await pageEditor(`<!-- img:xyz "make the bars horizontal" -->![Signups by week, rising from 120 to 310](${CHART})<!-- /img:xyz -->`)) },
      { label: "Being worked on", frame: "sheet", html: async () => editorHtml(await pageEditor(`<!-- img:xyz:ack "make the bars horizontal" -->![Signups by week, rising from 120 to 310](${CHART})<!-- /img:xyz:ack -->`)) },
      { label: "A new image suggested", note: "the old one dimmed, the new one after it", frame: "sheet", html: async () => (await answeredPage(`<!-- img:abc "make the bars horizontal" -->![Signups by week, rising from 120 to 310](${CHART})<!-- /img:abc -->`, "abc", suggestion(`![Signups by week, rising from 120 to 310](${CHART_AGAIN})`, { mode: "replace", place: "blocks", note: "Same numbers, bars on their side." }))).html },
    ],
    source: ["src/plugins/img/index.ts", "src/app/editor/imageTargets.ts"],
  },
  {
    id: "instruction-input", group: "asking", name: "Instruction input", kind: "DOM widget", where: "A popup under the selection (or under a request's loader)",
    summary: "One line that grows as it wraps: what the writer says to the agent about the selected text.",
    use: ["Tell the agent what you want done with the text, or ask a question about it.", "Also opens again from the suggestion card's Ask again, with the old instruction in it."],
    handlers: ["Enter or Shift+Enter: sends (an instruction is one line).", "Esc, or a click away: closes without sending.", "Enter with nothing typed when one is required: the box shakes and nothing is sent.", "500 characters at most."],
    specimens: [
      { label: "Empty", frame: "popup", html: async () => { const { instructionBox } = await imp<typeof import("../../src/app/editor/instructionInput")>("../../src/app/editor/instructionInput"); return instructionBox({ label: "Ask or tell the agent…" }).el.outerHTML; } },
      { label: "With an instruction", frame: "popup", html: async () => { const { instructionBox } = await imp<typeof import("../../src/app/editor/instructionInput")>("../../src/app/editor/instructionInput"); const b = instructionBox({ label: "Ask or tell the agent…", initial: "make it shorter" }); b.field.textContent = b.field.value; return b.el.outerHTML; } },
      { label: "Read only", note: "a run is working on it", frame: "popup", html: async () => { const { instructionBox } = await imp<typeof import("../../src/app/editor/instructionInput")>("../../src/app/editor/instructionInput"); const b = instructionBox({ label: "Ask or tell the agent…", initial: "make it shorter", readOnly: true }); b.field.textContent = b.field.value; return b.el.outerHTML; } },
    ],
    source: ["src/app/editor/instructionInput.ts", "src/app/editor/markers/popup.ts"],
  },

  // ------------------------------------------------------------------ reading
  {
    id: "suggestion-preview", group: "reading", name: "Suggestion preview", kind: "ProseMirror decoration", where: "In the sheet, where the answer would go",
    summary: "The agent's result drawn where it would land, marked, while the page itself stays unchanged until you accept.",
    use: ["Read the answer in context: inline text, whole blocks, or a replacement shown against the old words."],
    handlers: ["Hover: the card appears beside it. Click: the card is pinned until Esc or a click away.", "Nothing is written into the page until Accept."],
    specimens: [
      { label: "Inline text", frame: "sheet", html: async () => (await answeredPage("The deadline is <!-- gen:abc --> for all teams.", "abc", suggestion("30 *September*", { note: "Used the plan's date." }))).html },
      { label: "Blocks", frame: "sheet", html: async () => (await answeredPage("# Plan\n\n<!-- gen:abc -->\n\nAfter.", "abc", suggestion("| Team | Date |\n| --- | --- |\n| Web | 3 Sep |", { place: "blocks" }))).html },
      { label: "Replacing the writer's words", note: "old struck through, new after", frame: "sheet", html: async () => (await answeredPage("Please check <!-- sel:abc -->the end of Q3 date<!-- /sel:abc --> today.", "abc", suggestion("30 September", { mode: "replace" }))).html },
      { label: "After the writer's words", frame: "sheet", html: async () => (await answeredPage("Check <!-- sel:abc -->end of Q3<!-- /sel:abc --> here.", "abc", suggestion("(30 Sep)", { mode: "after" }))).html },
    ],
    source: ["src/app/editor/suggestions.ts"],
  },
  {
    id: "suggestion-chips", group: "reading", name: "Declined and answered chips", kind: "ProseMirror decoration", where: "In the sheet, in place of a preview",
    summary: "When the agent has nothing to put in the page, the marker says so: it declined (with its reason), or it answered a question about the text.",
    use: ["See why nothing was written, and read an answer that is not meant to go into the page."],
    handlers: ["Declined: Dismiss takes the marker out; Ask again sends it back.", "Answered: Done takes the marker out; Ask again asks again."],
    specimens: [
      { label: "Declined", frame: "sheet", html: async () => (await answeredPage("A <!-- gen:abc --> b.", "abc", "<decline>Nothing says what goes here.</decline>")).html },
      { label: "Answered", frame: "sheet", html: async () => (await answeredPage("Please check <!-- sel:abc \"is this right?\" -->the end of Q3 date<!-- /sel:abc -->.", "abc", "<answer>Yes: the plan says 30 September.</answer>")).html },
    ],
    source: ["src/app/editor/suggestions.ts"],
  },
  {
    id: "suggestion-card", group: "reading", name: "Suggestion card", kind: "DOM widget", where: "Right margin, beside the diff (a floating card)",
    summary: "What the agent says about its result, and the buttons to decide.",
    use: ["Decide: Accept puts the result in the page; Reject leaves the page as it is; Ask again turns it down and asks for another.", "On a request about selected text, ▾ beside Accept offers Accept as a Button: the result goes in, with a button above it to run the request again.", "Talk to the agent that made it (Chat)."],
    handlers: ["Accept ⌥⌘Y · Reject ⌥⌘N · Chat ⌥⌘C (vim: gc) · next ⌥⌘] · previous ⌥⌘[ .", "▾ (on a request that can have a button) opens a menu under it. A result that is one piece of text in place: Accept as a Button (see Accept as a Button). One that isn't (it changes other parts of the page, deletes the text, holds new requests, or starts or ends with a code block): Ask again as a button, saying which, and the agent is asked for one that can be. Asked for as a button, the card leads with Accept as a Button and ▾ holds Accept without a button. ▾ again, Esc or a click away closes the menu.", "Ask again on a request with an instruction opens the instruction input first.", "Esc closes the dropdown, then a pinned card; a click away closes it too.", "A decision is your own edit: saved with the next save, undone with Undo."],
    specimens: [
      { label: "A suggestion", frame: "side", html: async () => (await answeredPage("The deadline is <!-- gen:abc --> for all teams.", "abc", suggestion("30 September", { note: "Used the plan's own date." }), KEPT)).card() },
      { label: "With changes to other blocks", frame: "side", html: async () => (await answeredPage("# Plan\n\nThe deadline is end of Q3.\n\nNotes <!-- gen:abc --> here.", "abc", `<edit><before>\nThe deadline is end of Q3.\n</before><after>\nThe deadline is 30 September.\n</after></edit>\n${suggestion("Fixed the date above.")}`, KEPT)).card() },
      { label: "Declined", frame: "side", html: async () => (await answeredPage("A <!-- gen:abc --> b.", "abc", "<decline>Nothing says what goes here.</decline>", KEPT)).card() },
      { label: "Answered", frame: "side", html: async () => (await answeredPage("Please check <!-- sel:abc \"is this right?\" -->the end of Q3 date<!-- /sel:abc -->.", "abc", "<answer>Yes: the plan says **30 September**.</answer>", KEPT)).card() },
    ],
    source: ["src/app/editor/suggestions.ts", "src/app/editor/sideCard.ts"],
  },
  {
    id: "accept-as-button", group: "reading", name: "Accept as a Button", kind: "DOM widget", where: "A popup under the diff, from ▾ beside a suggestion's Accept",
    summary: "Says what a button does before the result becomes one: a press runs the request again and its result goes straight into the page.",
    use: ["Keep a result you will want redone (today's figures, the current time, a summary of a section that grows), with a button to redo it."],
    handlers: ["Accept as a Button: the result goes in, and a button appears above it (see Request button).", "Cancel, Esc or a click away: nothing changes; the suggestion still waits."],
    specimens: [
      { label: "Accept ▾: the result fits", note: "one piece of text in place", frame: "popup", html: async () => { const { acceptMenu } = await imp<typeof import("../../src/app/editor/suggestions")>("../../src/app/editor/suggestions"); const { BUTTON_BLOCKED } = await imp<typeof import("../../src/shared/docfile")>("../../src/shared/docfile"); return `<div class="task-popup" style="position:static">${acceptMenu("abc", [{ label: "Accept as a Button", note: "Keep this text with a ↻ button above it that rewrites it when you press it.", action: "accept-as-button", onPick: noop }]).outerHTML}</div>`; } },
      { label: "Accept ▾: the result doesn't fit", note: "it also changes other parts of the page", frame: "popup", html: async () => { const { acceptMenu } = await imp<typeof import("../../src/app/editor/suggestions")>("../../src/app/editor/suggestions"); const { BUTTON_BLOCKED } = await imp<typeof import("../../src/shared/docfile")>("../../src/shared/docfile"); return `<div class="task-popup" style="position:static">${acceptMenu("abc", [{ label: "Ask again as a button", note: `${BUTTON_BLOCKED.elsewhere} The agent will be asked for a version in one piece here, leaving the rest of the page as it is.`, action: "ask-for-button", onPick: noop }]).outerHTML}</div>`; } },
      { label: "Accept ▾ after asking for a button", note: "the card leads with Accept as a Button", frame: "popup", html: async () => { const { acceptMenu } = await imp<typeof import("../../src/app/editor/suggestions")>("../../src/app/editor/suggestions"); const { BUTTON_BLOCKED } = await imp<typeof import("../../src/shared/docfile")>("../../src/shared/docfile"); return `<div class="task-popup" style="position:static">${acceptMenu("abc", [{ label: "Accept without a button", note: "Put the text in the page as ordinary text (⌥⌘Y).", action: "accept-plain", onPick: noop }]).outerHTML}</div>`; } },
      { label: "The popup", frame: "popup", html: async () => { const { buttonConfirm } = await imp<typeof import("../../src/app/editor/suggestions")>("../../src/app/editor/suggestions"); return buttonConfirm(noop, noop).outerHTML; } },
    ],
    source: ["src/app/editor/suggestions.ts"],
  },
  {
    id: "task-button", group: "reading", name: "Request button", kind: "ProseMirror decoration", where: "In the sheet, on its own line above the text a request's button holds",
    summary: "A result the writer kept as a button. The text is ordinary text; the button runs its request again, and the new result replaces it without a diff.",
    use: ["Redo the request on the text as it is now.", "Change what it asks for.", "Have it redo itself on a schedule, page open or not (today's figures, the time).", "Take the button off and keep the text."],
    handlers: ["Press: runs the request again at once, with its own instruction (no input). While it runs the text shows as a waiting request.", "The new result goes straight in, with no fade or new-block line, and the button comes back; its margin note says when it last ran (Last run 20:59; hover for the next scheduled run). A decline, an answer, or a result for text you changed during the run waits on its card instead; deciding it brings the button back.", "Hover: the text it holds is highlighted, and ✎, ⏱ and × show.", "✎: the instruction input, filled in; Enter keeps the new instruction (it doesn't run).", "⏱: a menu, Only when pressed or every minute, 5 or 15 minutes, hour or day. The server runs a schedule, page open or not, as if you pressed it (on any engine; the page's agent switch and the cost limits still hold), and the button says how often (⏱ every 5 minutes; hover it for the next run). A run that ends on a card waits for you, and the schedule with it.", "×: removes the button, keeps the text (Undo brings it back).", "Sync writes only the text: the button stays in the working copy."],
    specimens: [
      { label: "Above its text", frame: "sheet", html: async () => editorHtml(await pageEditor("The time is now <!-- sel:abc:btn \"add the current time in words\" -->half past three<!-- /sel:abc:btn -->.\n\nThe next paragraph.", { abc: { type: "sel", created_by: "writer", created: "2026-11-10T10:00:00.000Z", status: "button", button: { at: "2026-11-10T10:00:00.000Z" } } })) },
      { label: "With a schedule", frame: "sheet", html: async () => editorHtml(await pageEditor("The time is now <!-- sel:abc:btn \"add the current time in words\" -->half past three<!-- /sel:abc:btn -->.", { abc: { type: "sel", created_by: "writer", created: "2026-11-10T10:00:00.000Z", status: "button", button: { at: "2026-11-10T10:00:00.000Z", every: 300000, from: "2026-11-10T10:00:00.000Z" } } })) },
      { label: "Its schedule menu (⏱)", frame: "popup", html: async () => { const { scheduleMenu } = await imp<typeof import("../../src/app/editor/taskButtons")>("../../src/app/editor/taskButtons"); return `<div class="task-popup" style="position:static">${scheduleMenu("abc", 300000, noop).outerHTML}</div>`; } },
      { label: "Over a list", frame: "sheet", html: async () => editorHtml(await pageEditor("Risks:\n\n- <!-- sel:abc:btn -->late data<!-- /sel:abc:btn -->\n- <!-- sel:abc:btn -->a missed step<!-- /sel:abc:btn -->", { abc: { type: "sel", created_by: "writer", created: "2026-11-10T10:00:00.000Z", status: "button", button: { at: "2026-11-10T10:00:00.000Z" } } })) },
    ],
    source: ["src/app/editor/taskButtons.ts", "src/app/page.css"],
  },
  {
    id: "suggestion-count", group: "reading", name: "Suggestion count", kind: "React component", where: "Status bar, right side (only while suggestions wait)",
    summary: "How many suggestions wait in the page, and a menu to go through them.",
    use: ["Know there is something to read; step through them; accept or reject them all at once."],
    handlers: ["Click: opens the menu: Next, Accept all, Reject all.", "⌥⌘] / ⌥⌘[ : next / previous from anywhere in the page."],
    specimens: [{ label: "One waiting", frame: "bar", html: async () => { const { SuggestionCount } = await imp<typeof import("../../src/app/pages/SuggestionCount")>("../../src/app/pages/SuggestionCount"); const { editor } = await answeredPage("The deadline is <!-- gen:abc --> for all teams.", "abc", suggestion("30 September")); return render(<footer className="statusbar"><span className="sb-spacer" /><SuggestionCount editor={editor} /></footer>); } }],
    source: ["src/app/pages/SuggestionCount.tsx"],
  },

  // ------------------------------------------------------------------ watching
  {
    id: "agent-note", group: "watching", name: "Agent pill (margin note)", kind: "React component", where: "Right margin, level with each placeholder's marker",
    summary: "One line beside a placeholder that says where its agent is: waiting to be picked up, working (with its latest step), done, declined (with the agent's reason), asleep, or in a chat. After you accept its result it stays beside where the result landed, saying Accepted (Kept as a button beside a button), for as long as the page is open.",
    use: ["See, without opening anything, that the agent is on it, what it is doing, and when it is done."],
    handlers: ["Click (or Enter): opens the chat with that agent, wherever there is one to talk to (done, asleep, in chat, accepted, or a run a Pi agent is working).", "Hover: the whole step (a tool call's arguments, a result) in a panel under the pill.", "Each state has its own icon and motion (see Primitives)."],
    specimens: (() => {
      const pill = (label: string, note: string, events: object[], state: string, engine = "pi", record?: { status: string; note: string }) => ({
        label, note, frame: "margin" as const,
        html: async () => { const { AgentNote, agentNote, declinedNote } = await imp<typeof import("../../src/app/pages/AgentFeed")>("../../src/app/pages/AgentFeed"); const at = Date.now(); const n = declinedNote(agentNote(events.map((e) => ({ at, ...e })) as never, "live", state, "abc"), state, record, "live")!; return renderToStaticMarkup(<div className="agent-notes" style={{ position: "relative", margin: 0, left: 0, height: 36 }}><AgentNote note={n} top={18} engine={engine} onChat={noop} /></div>); },
      });
      const hello = { event: "hello" };
      const run = [hello, { event: "start", run: 1, task: "abc", engine: "pi", chat: true }];
      return [
        pill("Waiting to be picked up", "a clock", [hello], "pending"),
        pill("Working", "the engine's own mark, breathing", [...run, { event: "step", run: 1, kind: "tool", name: "Read", brief: "plan.md", text: "Read plan.md", detail: "{\"file_path\": \"/docs/plan.md\"}" }], "ack"),
        pill("A step failed", "a warning", [...run, { event: "step", run: 1, kind: "error", text: "The agent asked for permission (Write …), which can't be answered here" }], "ack"),
        pill("Done: the agent is still here", "a check that draws itself", [...run, { event: "wait", run: 1, task: "abc", until: Date.now() + 300000, finishedAt: Date.now() }], "sug"),
        pill("Declined", "the agent's reason in place of Done, a crossed ring", [...run, { event: "wait", run: 1, task: "abc", until: Date.now() + 300000, finishedAt: Date.now() }], "sug", "pi", { status: "declined", note: "Nothing around the marker says what this section is about: add a line on its topic." }),
        pill("Snoozed", "a moon; the conversation is on disk", [...run, { event: "snooze", run: 1, task: "abc", finishedAt: Date.now() }], "sug"),
        pill("In chat", "a bubble with rising dots", [...run, { event: "chat", run: 1, task: "abc" }], "sug"),
        pill("Working in the chat", "the agent is answering there; the bubble stays", [...run, { event: "chat", run: 1, task: "abc" }, { event: "chat_busy", run: 0, task: "abc", busy: true }], "sug"),
        pill("Accepted", "beside where the result landed; the agent still here", [...run, { event: "wait", run: 1, task: "abc", until: Date.now() + 300000, finishedAt: Date.now() }], "accepted"),
        pill("Accepted, agent snoozed", "its conversation is on disk; a click wakes it", [...run, { event: "snooze", run: 1, task: "abc", finishedAt: Date.now() }], "accepted"),
        pill("Kept as a button", "beside a button that hasn't run since", [hello], "btn"),
        pill("Pi's mark", "the same pill, another engine", [{ event: "hello" }, { event: "start", run: 1, task: "abc", engine: "pi", chat: true }], "ack", "pi"),
      ];
    })(),
    source: ["src/app/pages/AgentFeed.tsx", "src/app/pages/NoteIcon.tsx"],
  },
  {
    id: "engine-icons", group: "watching", name: "Engine marks", kind: "React component", where: "Pills, the debug panel's header, the page-chat button",
    summary: "The mark of the engine that runs an agent: Pi's pixel mark.",
    use: ["Tell at a glance that an agent is at work, and which engine it runs on."],
    specimens: [{ label: "Pi", html: () => { const { EngineIcon } = require("../../src/app/pages/EngineIcon"); return renderToStaticMarkup(<EngineIcon engine="pi" size={28} />); } }],
    source: ["src/app/pages/EngineIcon.tsx", "src/app/pages/PiIcon.tsx", "src/app/editor/logo.ts"],
  },
  {
    id: "status-bar", group: "watching", name: "Status bar", kind: "React component", where: "Bottom of the screen, full width",
    summary: "Like an IDE's: editing mode, the model answering, single-agent mode, what the page has cost, the agent panel, and where the caret is.",
    use: ["Switch between Standard and Vim editing.", "See which model is answering on this page, whether one lasting agent handles every request, and what the page's agents have cost since you opened it.", "Open the agent panel; see suggestions waiting; the caret's line and column; the word count; which version of Solipsist is serving the page."],
    handlers: ["Mode button: Vim on/off.", "Version (last, e.g. v0.1.0; v0.1.0-dev from source): its title is the whole `solipsist --version` line, to give in a bug report.", "Model: opens the agent panel, where the model is chosen and the agents are turned off and on.", "Page review: one review, which leaves questions in the margin and writes nothing in the page. It blinks and reads “Reviewing…” while the run is in flight, and its title says so when a review raised nothing.", "Debug: opens the same panel (its dot shows the agents' state).", "In Vim, typed counts and operators show beside the mode (e.g. 2d)."],
    specimens: [
      { label: "Standard editing, agent on", frame: "bar", html: async () => { const { StatusBar } = await imp<typeof import("../../src/app/pages/StatusBar")>("../../src/app/pages/StatusBar"); const { editor } = await answeredPage("The deadline is <!-- gen:abc --> for all teams.", "abc", suggestion("30 September")); return render(<StatusBar editor={editor} agent={{ on: true, model: "pi:openrouter/~deepseek/deepseek-flash-latest", single: false, cost: 0.0123 }} read={{ busy: false, count: 2, start: noop }} debug={{ open: false, tone: "run", toggle: noop }} build={{ version: "0.1.0", line: "solipsist 0.1.0 (darwin-arm64, a1b2c3d, 2026-11-10)" }} />); } },
      { label: "Vim on, agent off, debug open", frame: "bar", html: async () => { const { StatusBar } = await imp<typeof import("../../src/app/pages/StatusBar")>("../../src/app/pages/StatusBar"); const { setVim } = await imp<typeof import("../../src/app/editor/vim")>("../../src/app/editor/vim"); const editor = await pageEditor("Some words to count in the page."); setVim(editor, true); return render(<StatusBar editor={editor} agent={{ on: false, model: "pi:openrouter/~deepseek/deepseek-flash-latest", single: true, cost: 0.0123 }} read={{ busy: true, count: 0, start: noop }} debug={{ open: true, tone: "bad", toggle: noop }} />); } },
    ],
    source: ["src/app/pages/StatusBar.tsx"],
  },
  {
    id: "debug-panel", group: "watching", name: "Debug panel", kind: "React component", where: "Right edge of the screen, opened from the status bar",
    summary: "Everything the page's agents say, as it happens: the state, the runs, every step.",
    use: ["See why nothing is happening, or what a run did, step by step.", "Choose this page's engine and model (the picker); turn the page's agents off and on; clear the log."],
    handlers: ["Model picker: changes this page's model (saved in its file); a run in flight finishes on the old one.", "Agent on/off: stops or starts this page's agents (kept in the page's file, so a reload and every other tab agree; a run in flight stops).", "Page review: one review, which leaves questions in the margin and writes nothing in the page. When it ends, the panel says what became of every question it raised.", "Run tabs: show one run's messages; ‹ › cycle through them.", "Clear: empties the log. ✕: closes the panel."],
    specimens: [
      { label: "A page's agents at work", frame: "panel", html: async () => { const { DebugPanel } = await imp<typeof import("../../src/app/pages/DebugPanel")>("../../src/app/pages/DebugPanel"); return renderToStaticMarkup(<DebugPanel events={EVENTS.map((e) => ({ ...e, at: Date.now() - 60_000 + (e.at - EVENTS[0]!.at) / 100 }))} link="live" cost={0.0123} model="pi:openrouter/~moonshotai/kimi-latest" models={MODELS} agent={{ on: true, toggle: noop }} onModel={noop} onClear={noop} onClose={noop} />); } },
      { label: "The agents turned off", note: "the switch is the page's own, kept in its file", frame: "panel", html: async () => { const { DebugPanel } = await imp<typeof import("../../src/app/pages/DebugPanel")>("../../src/app/pages/DebugPanel"); return renderToStaticMarkup(<DebugPanel events={[]} link="paused" cost={0} model="pi:~deepseek/deepseek-flash-latest" models={MODELS} agent={{ on: false, toggle: noop }} onModel={noop} onClear={noop} onClose={noop} />); } },
    ],
    source: ["src/app/pages/DebugPanel.tsx"],
  },
  {
    id: "model-select", group: "watching", name: "Model picker", kind: "React component", where: "Debug panel header, and the page chat's header",
    summary: "The model this page's agents run on: a shortlist at a glance — your preferred models first, then each engine's — and a search over every model your engines can run, which for Pi is every model your own Pi has credentials for.",
    use: [
      "Choose which engine and model this page's agents use; the page-wide chat uses the same one.",
      "Type to search the whole catalog by name, vendor or id, beyond the few the shortlist shows.",
      "Read what a model holds and what a million tokens cost before picking it.",
    ],
    handlers: [
      "Choosing saves the page's setting. A run in flight finishes on the old model; old agents keep their own engine.",
      "↑ ↓ move, Enter picks, Escape closes, and so does a click outside.",
      "A model whose engine isn't set up is listed but can't be chosen, and says why on hover.",
      "`agent.preferred_models` in solipsist.yaml pins models to the top under Preferred; the first that can run is a new page's default.",
    ],
    specimens: [
      { label: "Closed: the model the page is on", html: async () => { const { ModelSelect } = await imp<typeof import("../../src/app/pages/ModelPicker")>("../../src/app/pages/ModelPicker"); return renderToStaticMarkup(<ModelSelect model="pi:openrouter/~moonshotai/kimi-latest" models={MODELS} catalog={MODEL_CATALOG} onModel={noop} />); } },
      { label: "Open: the shortlist, preferred first", html: async () => { const { ModelMenu } = await imp<typeof import("../../src/app/pages/ModelPicker")>("../../src/app/pages/ModelPicker"); return renderToStaticMarkup(<div className="model-pick"><ModelMenu model="pi:openrouter/~moonshotai/kimi-latest" offered={MODELS} catalog={MODEL_CATALOG} query="" active={0} onQuery={noop} onActive={noop} onChoose={noop} /></div>); } },
      { label: "Searching the whole catalog", html: async () => { const { ModelMenu } = await imp<typeof import("../../src/app/pages/ModelPicker")>("../../src/app/pages/ModelPicker"); return renderToStaticMarkup(<div className="model-pick"><ModelMenu model="pi:openrouter/~moonshotai/kimi-latest" offered={MODELS} catalog={MODEL_CATALOG} query="flash" active={1} onQuery={noop} onActive={noop} onChoose={noop} /></div>); } },
    ],
    source: ["src/app/pages/ModelPicker.tsx"],
  },

  // ------------------------------------------------------------------ talking
  {
    id: "chat-launch", group: "talking", name: "Page chat button", kind: "React component", where: "Top-right corner of the sheet",
    summary: "Opens a chat about the whole page with the engine this page is on, and shows how that chat's agent is.",
    use: [
      "Ask a question about the page, or ask for changes (they come back as suggestions on the page). The conversation is kept: opening it again goes on where it was.",
      "See at a glance whether the page chat is working while its window is closed: quiet (no agent), a little brighter (snoozed, conversation kept), a breathing glow (agent up, or the chat open), a light running round the edge (replying), a dot (a reply came while it was closed).",
    ],
    handlers: ["Click: opens the chat window. Its mark is the page's engine.", "Its state comes from the page's agent stream (`pichat` events, `pageChat` in the hello). Under reduced motion it holds still and shows the state by colour."],
    specimens: (["none", "snoozed", "waiting", "working"] as const).map((state) => ({
      label: { none: "No agent", snoozed: "Snoozed, conversation kept", waiting: "Agent up (or chat open)", working: "Replying" }[state],
      frame: "sheet" as const,
      html: () => { const { ChatLaunch } = require("../../src/app/pages/ChatLaunch"); return `<div style="position:relative;height:76px">${renderToStaticMarkup(<ChatLaunch engine="pi" engineTitle="Pi" status={{ state }} onOpen={noop} />)}</div>`; },
    })).concat([{
      label: "A reply came while it was closed", frame: "sheet" as const,
      html: () => { const { ChatLaunch } = require("../../src/app/pages/ChatLaunch"); return `<div style="position:relative;height:76px">${renderToStaticMarkup(<ChatLaunch engine="pi" engineTitle="Pi" status={{ state: "waiting", unread: true }} onOpen={noop} />)}</div>`; },
    }]),
    source: ["src/app/pages/ChatLaunch.tsx", "src/app/pages/Sheet.tsx", "src/app/pages/EngineIcon.tsx", "src/server/agent/pageChatStatus.ts"],
  },
  {
    id: "chat-window", group: "talking", name: "Chat window", kind: "React component", where: "A window over the page",
    summary: "A conversation with an agent: what you say, what it does (folded), and what it answers.",
    use: ["Talk to the agent behind a suggestion (from its card or its pill), or about the whole page.", "Look in on a run that is still going."],
    handlers: ["A call to one of Solipsist's own tools (suggest, answer, decline) is shown apart from the agent's own work, as the result it gave; the agent's calls fold away into one line of work.", "Enter sends · Shift+Enter new line · Esc closes (also the ✕ and a click outside).", "Stop (while it replies): stops the reply, keeps the conversation.", "Send while it replies (an engine that takes it, Pi): the message is queued and the agent reads it after its current step; the same reply answers it. Closing the chat (Esc, a click outside) leaves the reply going.", "The page chat's header has the model picker (changing it starts a new chat on that model) and New chat (forgets the conversation and starts over).", "Closing the page chat leaves a reply going (its suggestion still lands on the page); opening it again shows the conversation where it is. Left alone, it snoozes and is taken up again on the next open.", "While it looks in on a run, the box is disabled until the run ends."],
    specimens: [
      { label: "A conversation", frame: "window", html: () => chatView({ messages: CHAT, busy: true }) },
      { label: "The page's chat, with the model picker and New chat", note: "the picker is the page's model; changing it, or New chat, starts a new chat", frame: "window", html: () => chatView({ messages: [CHAT[2]!, { ...CHAT[1]!, id: "m9", blocks: [{ type: "text", text: "The deadline is on 30 September." }], stats: undefined }], busy: false, page: true }) },
      { label: "What it gives back", note: "Solipsist's own tools (suggest, answer, decline) are the result the writer decides on, not work: the call the page refused says so, and the next one takes its place", frame: "window", html: () => chatView({ messages: CHAT_REPLY, busy: false }) },
      { label: "Waking the agent", note: "before the conversation arrives", frame: "window", html: () => chatView({ messages: [], opened: false, busy: false }) },
      { label: "Looking in on a run", frame: "window", html: () => chatView({ messages: [CHAT[0]!, CHAT[4]!], watching: true, busy: true }) },
      { label: "A message sent mid-reply", note: "Send stays beside Stop; the message waits for the agent's next step", frame: "window", html: () => chatView({ messages: CHAT, busy: true, steers: true, notices: [{ key: 1, kind: "queued", text: "Sent mid-reply: “keep it short”. It reads this after its current step.", after: Infinity }] }) },
      { label: "An error", frame: "window", html: () => chatView({ messages: [], error: "No agent was kept for this suggestion: its engine can't keep a conversation, or it isn't set up now.", busy: false }) },
    ],
    source: ["src/app/pages/ChatModal.tsx"],
  },
  {
    id: "chat-parts", group: "talking", name: "Chat log parts", kind: "React component", where: "Inside the chat window's log",
    summary: "The kinds of thing in a conversation, each shown its own way.",
    use: ["Read the answer first; look at the work only if you want to."],
    handlers: ["Task from Solipsist: folded; opens to the prompt the agent was sent.", "Worked for 5s · 2 tools: folded work; open while it streams, and when a tool failed.", "A tool: its arguments and result open under it.", "Envelopes (suggestion, edit, answer, note, declined) are set apart from prose."],
    specimens: [
      { label: "Tool: running, done, failed", html: async () => { const { Tool } = await imp<typeof import("../../src/app/pages/ChatModal")>("../../src/app/pages/ChatModal"); const t = (b: object) => renderToStaticMarkup(<Tool b={{ type: "tool", id: "x", name: "Read", brief: "/docs/plan.md", args: "{}", ...b } as never} />); return `<div class="chat-work-body">${t({ running: true })}${t({ result: "# Plan …", durationMs: 40 })}${t({ name: "Bash", brief: "date -j …", isError: true, result: "date: illegal option", durationMs: 1200 })}</div>`; }, frame: "window" },
      { label: "Envelopes", html: async () => { const { Text } = await imp<typeof import("../../src/app/pages/ChatModal")>("../../src/app/pages/ChatModal"); return renderToStaticMarkup(<Text text={"Here you go.\n<suggestion mode=\"at\" place=\"inline\">30 September</suggestion>\n<edit><before>\nThe deadline is end of Q3.\n</before><after>\n(removed)\n</after></edit>\n<answer>Yes.</answer>\n<note>Used the plan's date.</note>\n<decline>Nothing to do.</decline>"} />); }, frame: "window" },
      { label: "Reply stats", html: async () => { const { Stats } = await imp<typeof import("../../src/app/pages/ChatModal")>("../../src/app/pages/ChatModal"); return renderToStaticMarkup(<Stats stats={{ model: "kimi-latest", input: 13200, output: 86, costUsd: 0.0123, ms: 5100, tokensPerSec: 42 }} />); }, frame: "window" },
      { label: "Notices", html: async () => { const { ChatLog } = await imp<typeof import("../../src/app/pages/ChatModal")>("../../src/app/pages/ChatModal"); return renderToStaticMarkup(<ChatLog messages={[]} notices={[{ key: 1, kind: "revised", text: "Your suggestion was updated on the page.", after: 0 }, { key: 2, kind: "warning", text: "Another run started on this placeholder.", after: 0 }]} />); }, frame: "window" },
    ],
    source: ["src/app/pages/ChatModal.tsx"],
  },

  {
    id: "setup-dialog", group: "frame", name: "Choose your files", kind: "React component", where: "Over the home screen, on the first launch and from Add files",
    summary: "The markdown files md_search_paths found, to pick which ones Solipsist copies and syncs.",
    use: ["Say which of a project's files to work on. Nothing is created until you confirm."],
    handlers: ["All: ticks or clears every file.", "Add N files: copies the ones ticked into .solipsist/.", "Cancel (Add files only): closes it."],
    specimens: [{ label: "First launch", frame: "window", html: () => { const { SetupDialog } = require("../../src/app/pages/SetupDialog"); return render(<SetupDialog found={["README.md", "ROADMAP.md", "docs/plan.md"]} searchPaths={["*.md", "docs"]} capped={false} first failed={[]} onAdd={noop} />); } }],
    source: ["src/app/pages/SetupDialog.tsx"],
  },
  {
    id: "sync-dialog", group: "frame", name: "Sync and its dialog", kind: "React component", where: "Sync to file and Reload from file in the top bar; the dialog over the page",
    summary: "Sends the page to its original file, and asks first if the original changed since it was loaded.",
    use: ["Write your edits to the repo, or take in a newer original."],
    handlers: ["Sync to file: writes the page over its original.", "Reload from file: merges the newer original with your edits.", "Overwrite the file: replaces the original.", "Discard my edits and load the file: when both changed the same text.", "Create it: when the original was deleted.", "Cancel: nothing is written."],
    specimens: [{ label: "The original changed", frame: "window", html: () => { const { SyncDialog } = require("../../src/app/pages/SyncDialog"); return render(<SyncDialog path="ROADMAP.md" problem="changed" onReload={noop} onOverwrite={noop} onDiscard={noop} onCancel={noop} />); } }],
    source: ["src/app/pages/SyncDialog.tsx"],
  },

  {
    id: "connect-model", group: "frame", name: "Connect a model", kind: "React component", where: "Over the page, from the status bar or the ask key when no model can run",
    summary: "How to connect a model, instead of a request that can only fail.",
    use: ["Find out what the agent needs before it can answer."],
    handlers: ["Close: closes it."],
    specimens: [{ label: "No model yet", frame: "window", html: () => { const { ConnectModel } = require("../../src/app/pages/ConnectModel"); return render(<ConnectModel onClose={noop} />); } }],
    source: ["src/app/pages/ConnectModel.tsx"],
  },

  // ------------------------------------------------------------------ primitives
  {
    id: "buttons", group: "primitives", name: "Buttons", kind: "CSS pattern", where: "Everywhere",
    summary: "Three variants: primary (rare, one per surface), the default, and ghost. An icon button is square.",
    use: ["Primary: the one thing to do next (Accept, Send, New page). Ghost: a quiet alternative (Reject, Clear, Close)."],
    specimens: [{ label: ".btn .btn-primary · .btn · .btn-ghost · .icon-btn", html: () => `<button class="btn btn-primary">Accept</button> <button class="btn">Ask again</button> <button class="btn btn-ghost">Reject</button> <button class="btn btn-ghost icon-btn" aria-label="Close">✕</button> <button class="btn btn-primary" disabled>Disabled</button>` }, { label: "Inside a card: .task-btn", html: () => `<div class="task-row"><button class="task-btn primary">Accept</button><button class="task-btn">Ask again</button><button class="task-btn ghost">Reject</button><button class="task-btn" disabled>Chat</button></div>` }],
    source: ["src/app/chrome.css", "src/app/margin.css"],
  },
  {
    id: "kbd", group: "primitives", name: "Key chip", kind: "CSS pattern", where: "Next to the action a key performs",
    summary: "A small raised chip for a key: shortcuts are shown, not shouted.",
    use: ["Show the key for an action beside it, in the chat's footer and on buttons."],
    specimens: [{ label: "kbd", html: () => `<kbd>⌘</kbd> <kbd>.</kbd> &nbsp; <kbd>⌥⌘Y</kbd> &nbsp; <kbd>esc</kbd> &nbsp; <kbd>⇧↵</kbd>` }],
    source: ["src/app/chrome.css", "src/app/tokens.css"],
  },
  {
    id: "dots", group: "primitives", name: "Status dots and tags", kind: "CSS pattern", where: "Status bar, chat header, debug panel, run tabs",
    summary: "A 6-pixel dot says live, fine or wrong; the live one breathes. Tags are tinted, never filled.",
    use: ["Say a state in a glance: live (breathing), ok, error, idle."],
    specimens: [{ label: ".dot · .dot-live · .dot-ok · .dot-err", html: () => `<span class="tag"><span class="dot"></span>Idle</span> <span class="tag tag-agent"><span class="dot dot-live"></span>Writing</span> <span class="tag tag-add"><span class="dot dot-ok"></span>Done</span> <span class="tag tag-del"><span class="dot dot-err"></span>Failed</span>` }],
    source: ["src/app/chrome.css"],
  },
  {
    id: "spinners", group: "primitives", name: "Spinners and motion", kind: "DOM widget", where: "Wherever work is waiting or in progress",
    summary: "Every indicator that moves, and what moves it. SVG ones animate themselves; the rest are CSS.",
    use: ["Placeholder pending: a slow-fading dot. Placeholder working: a turning arc. A pill's icons: a turning clock hand, a breathing mark, a check that draws itself, a floating z, rising dots. Chat: a caret while the agent thinks; a ring while a tool runs."],
    handlers: ["All motion stops for people who prefer reduced motion."],
    specimens: [
      { label: "Placeholder: waiting (blinkingDot)", html: async () => { const { blinkingDot } = await imp<typeof import("../../src/app/editor/markers/indicators")>("../../src/app/editor/markers/indicators"); return `<span style="color:var(--agent)">${blinkingDot().outerHTML}</span>`; } },
      { label: "Placeholder: working (spinner)", html: async () => { const { spinner } = await imp<typeof import("../../src/app/editor/markers/indicators")>("../../src/app/editor/markers/indicators"); return `<span style="color:var(--agent)">${spinner().outerHTML}</span>`; } },
      { label: "Chat: thinking caret", html: () => `<div class="chat-msg assistant streaming"><span class="chat-caret" aria-label="Thinking"></span></div>`, frame: "window" },
      { label: "Chat: tool running", html: () => `<details class="chat-tool running"><summary><span class="chat-tool-icon" aria-label="running"></span><b>Read</b><span class="chat-tool-brief">/docs/plan.md</span></summary></details>`, frame: "window" },
    ],
    source: ["src/app/editor/markers/indicators.ts", "src/app/margin.css", "src/app/chat.css", "src/app/pages/NoteIcon.tsx"],
  },
];

/** The chat window with the given state, as the page draws it. */
function chatView(o: { messages: typeof CHAT; busy: boolean; opened?: boolean; error?: string | null; watching?: boolean; page?: boolean; steers?: boolean; notices?: { key: number; kind: "warning" | "revised" | "queued"; text: string; after: number }[] }) {
  const { ChatView } = require("../../src/app/pages/ChatModal");
  const html = renderToStaticMarkup(
    <ChatView
      chat={o.page ? { task: PAGE_CHAT, title: "Chat with Pi" } : { task: "abc", title: "Suggestion · plan.md" }} models={o.page ? { model: "pi:openrouter/~moonshotai/kimi-latest", models: MODELS, onModel: noop, onNew: noop } : undefined} messages={o.messages} notices={o.notices ?? []} busy={o.busy} watching={!!o.watching} steers={!!o.steers}
      opened={o.opened ?? true} error={o.error ?? null} model="kimi-latest" draft="" onDraft={noop} onSend={noop} onStop={noop} onClose={noop}
    />,
  );
  return html.replace(/<div class="chat-backdrop"[^>]*><\/div>/, "");
}
