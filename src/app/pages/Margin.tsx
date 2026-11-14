import type { Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommentEntry } from "../../shared/docfile";
import { CommentModal } from "./CommentModal";
import { stackCards } from "./stackCards";

const GAP = 8;

/**
 * The review's questions in the left margin, level with the passages they are about (Google Docs style).
 *
 * A card is its gloss and nothing more: the two-to-five-word note a reader pencils beside a passage. Clicking it, or
 * its passage, opens the question in a window of its own (`CommentModal`) — there is far more to a question than fits
 * in the margin, and a card that grew to hold it pushed every other card down the page.
 */
export function Margin({ editor, comments, placed, onDismiss, onOpen, onAsk }: {
  editor: Editor | null;
  comments: CommentEntry[];
  placed: Set<string>;
  onDismiss?: (id: string) => void;
  onOpen?: (id: string) => void;
  onAsk?: (id: string) => void;
}) {
  const col = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  const els = useRef<Record<string, HTMLElement | null>>({});
  const shown = comments.filter((c) => c.status === "open" && placed.has(c.id));
  /** The question whose window is open, if any. One closed by a dismissal is gone from `shown` and so from here. */
  const open = shown.find((c) => c.id === active);

  // Read through a ref, not captured: the click handler on the editor is registered once, and must call the
  // callback the app has now (a handler on `window` reads what the app knows now, not what a late effect captured).
  const openRef = useRef(onOpen);
  useLayoutEffect(() => { openRef.current = onOpen; });
  /** Brings a card forward, and tells the app the writer has read it. */
  const show = (id: string) => { setActive(id); openRef.current?.(id); };

  const measure = () => {
    const root = col.current;
    if (!root || !editor) return;
    const base = root.getBoundingClientRect().top;
    const stacked = stackCards(shown.map((c) => ({
      top: (editor.view.dom.querySelector<HTMLElement>(`[data-comment="${c.id}"]`)?.getBoundingClientRect().top ?? base) - base,
      height: els.current[c.id]?.offsetHeight ?? 64,
    })), GAP);
    const next = Object.fromEntries(shown.map((c, i) => [c.id, stacked[i]!]));
    setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };

  useLayoutEffect(measure);
  useEffect(() => {
    if (!editor) return;
    const f = () => requestAnimationFrame(measure);
    editor.on("transaction", f);
    window.addEventListener("resize", f);
    return () => { editor.off("transaction", f); window.removeEventListener("resize", f); };
  });

  // Highlight the passage of the active card, and open a card by clicking its passage.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.querySelectorAll(".hl.active").forEach((el) => el.classList.remove("active"));
    if (active) dom.querySelectorAll(`[data-comment="${active}"]`).forEach((el) => el.classList.add("active"));
  });
  // The page recedes while a question is open (page.css `.spot`), so the passage it is about is what stands out.
  useEffect(() => {
    if (!editor || !open) return;
    const dom = editor.view.dom;
    dom.classList.add("spot");
    return () => dom.classList.remove("spot");
  }, [editor, !!open]);
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const click = (e: MouseEvent) => {
      const id = (e.target as HTMLElement).closest?.("[data-comment]")?.getAttribute("data-comment");
      if (id) show(id);
    };
    dom.addEventListener("click", click);
    return () => dom.removeEventListener("click", click);
  }, [editor]);

  return (
    <aside className="margin" ref={col} aria-label="Comments">
      {shown.map((c) => (
        <section
          key={c.id}
          ref={(el) => { els.current[c.id] = el; }}
          className={`card${active === c.id ? " active" : ""}`}
          style={{ top: tops[c.id] ?? 0, opacity: c.id in tops ? 1 : 0 }}
          onClick={() => show(c.id)}
          title="Open the question"
        >
          {/* The card is the gloss and nothing else; the question itself opens in a window of its own. */}
          {c.gloss ? <p className="gloss">{c.gloss}</p> : <h3>{c.title}</h3>}
          {c.image && <span className="card-has-image" aria-hidden="true" title="This question comes with a picture" />}
        </section>
      ))}
      {/* The question in full, over the page. The margin keeps its cards where they are while it is open. */}
      {open && <CommentModal comment={open} onDismiss={onDismiss} onAsk={onAsk} onClose={() => setActive(null)} />}
    </aside>
  );
}
