import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { setVim, vimKey, type VimMode } from "../editor/vim";
import { modelOf } from "../../shared/choice";
import { SuggestionCount } from "./SuggestionCount";

const MODE_LABEL: Record<VimMode, string> = { normal: "NORMAL", insert: "INSERT", visual: "VISUAL", vline: "V-LINE" };

/** `pi:openrouter/~deepseek/deepseek-flash-latest` → `deepseek-flash-latest`. */
export const modelName = (choice: string) => modelOf(choice).split("/").pop() || choice;

/** The bottom bar, like an IDE's: the editing mode (click to switch between Vim and Standard), the caret, the word count. */
/** `0.1.0` → `v0.1.0`; from source, `0.1.0-dev+a1b2c3d.dirty` → `v0.1.0-dev` (the commit is in the title). */
export const shortVersion = (v: string) => `v${v.replace(/\+.*$/, "")}`;

export function StatusBar({ editor, agent, read, debug, build }: { editor: Editor; agent: { on: boolean; model: string; single: boolean; cost: number; noEngine?: boolean; onConnect?(): void }; read?: { busy: boolean; count: number; said?: string | null; start(): void }; debug: { open: boolean; tone: string; toggle(): void }; build?: { version: string; line: string } | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    editor.on("transaction", f);
    return () => void editor.off("transaction", f);
  }, [editor]);
  const st = vimKey.getState(editor.state);
  const { $head } = editor.state.selection;
  let line = 0;
  editor.state.doc.descendants((n, pos) => {
    if (n.isTextblock && pos < $head.pos) line++;
    return !n.isTextblock;
  });
  const words = editor.state.doc.textContent.split(/\s+/).filter(Boolean).length;
  const pending = st?.on ? `${st.count}${st.op}${st.g ? "g" : ""}` : "";
  const tone = ({ run: "dot-live", bad: "dot-err", ok: "dot-ok" } as Record<string, string>)[debug.tone] ?? "";
  const live = agent.on && debug.tone === "run";
  const vimDot = st?.on && st.mode !== "normal" ? "dot-live" : "";
  return (
    <footer className="statusbar">
      <button
        type="button"
        className="sb-item sb-mode"
        title={st?.on ? "Vim keys are on. Click to go back to Standard editing." : "Standard editing. Click to turn on Vim keys."}
        onMouseDown={(e) => { e.preventDefault(); setVim(editor, !st?.on); }}
      >
        <span className={`dot ${vimDot}`} />{st?.on ? MODE_LABEL[st.mode] : <>Standard <i className="sb-hint">· click to use Vim mode</i></>}
      </button>
      {pending && <span className="sb-item pending">{pending}</span>}
      <span className="sb-spacer" />
      <SuggestionCount editor={editor} />
      {agent.noEngine ? (
        <button type="button" className="sb-item sb-model" title="No model can run yet. Click to see how to connect one." onMouseDown={(e) => { e.preventDefault(); agent.onConnect?.(); }}>
          <span className="dot dot-err" />Connect a model
        </button>
      ) : (
        <button
          type="button"
          className="sb-item sb-model"
          title="The model answering on this page. Click to open the agent panel and change it."
          onMouseDown={(e) => { e.preventDefault(); debug.toggle(); }}
        >
          <span className={`dot${live ? " dot-live" : ""}`} />{modelName(agent.model)}
        </button>
      )}
      <span className="sb-item" title={agent.single ? "One lasting agent handles every request on this page." : "Each request gets its own agent."}>
        Single agent <b>{agent.single ? "on" : "off"}</b>
      </span>
      <span className="sb-item" title="Spent by all of this page's agents since you opened it.">Cost <b>${agent.cost.toFixed(4)}</b></span>
      {/* One review, without opening the agent panel: questions in the margin, nothing written in the page. */}
      {read && (
        <button
          type="button"
          className="sb-item review-page"
          disabled={read.busy}
          title={read.busy ? "Reviewing the page. Its steps are in the agent panel." : read.said ?? "Review this page and leave questions in the margin. Nothing is written into the page."}
          onMouseDown={(e) => { e.preventDefault(); if (!read.busy) read.start(); }}
        >
          {/* A blinking dot while it reads, and nothing else: the step-by-step belongs in the agent panel, not here. */}
          <span className={`dot${read.busy ? " dot-live" : ""}`} />{read.busy ? "Reviewing…" : "Page review"}
        </button>
      )}
      {/*
        How many questions are on the page. It matters most when the margin has no room for them (a narrow window
        hides it), since then this is the only place that says they are there at all.
      */}
      {!!read?.count && (
        <span className="sb-item sb-review-count" title="Questions the review left on this page. They are in the right margin, beside the passages they are about.">
          {read.count} {read.count === 1 ? "question" : "questions"}
        </span>
      )}
      <button type="button" className={`sb-item debug-toggle${debug.open ? " on" : ""}`} title="Show the agent's messages in a panel on the right." onMouseDown={(e) => { e.preventDefault(); debug.toggle(); }}>
        <span className={`dot ${tone}`} />Debug
      </button>
      <span className="sb-item sb-pos">{line || 1}:{$head.parentOffset + 1}</span>
      <span className="sb-item sb-pos">{words} {words === 1 ? "word" : "words"}</span>
      {build && <span className="sb-item sb-version" title={`${build.line}: the Solipsist serving this page. Give this line in a bug report.`}>{shortVersion(build.version)}</span>}
    </footer>
  );
}
