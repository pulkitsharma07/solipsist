import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { assetUrl, type CommentEntry } from "../../shared/docfile";
import { EngineIcon, engineOf } from "./EngineIcon";
import { modelName } from "./StatusBar";

/**
 * One review question, opened in full. The margin card is only ever the gloss — the
 * two-to-five-word note beside the passage — and clicking it opens the question here, where there is room for the
 * reviewer's reasoning and the picture it drew.
 *
 * It is a window on a question, not on a suggestion, so there is no Accept and no Reject: nothing of it is in the
 * page. **Dismiss** takes it down for good, and **Ask** carries it into the chat. Escape, the backdrop and the close
 * button all close it, as the chat's window does.
 *
 * With room to its left it hangs in the margin beside its passage; on a laptop screen, where the margin is too narrow,
 * it opens just below the passage instead. Either way a thin line joins it to the passage, and the rest of the page
 * recedes (`Margin` marks the editor) instead of going behind a dark scrim. On a phone it is a window of its own.
 */
const WIDTH = 320; // keep in step with `.comment-modal.anchored` in margin.css
const PHONE = 640; // below this it is a full window (margin.css)
export function CommentModal({ comment, onDismiss, onAsk, onClose }: {
  comment: CommentEntry;
  onDismiss?: (id: string) => void;
  onAsk?: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  // Where the passage is, in the margin's own coordinates, so the popover and its line scroll with the page.
  const box = useRef<HTMLElement>(null);
  type At = { mode: "side" | "below"; top: number; left?: number; width?: number; px: number; py: number; w: number; ty: number };
  const [at, setAt] = useState<At | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const margin = box.current?.parentElement;
      const hl = document.querySelector<HTMLElement>(`[data-comment="${comment.id}"]`);
      if (!margin || !hl || window.innerWidth < PHONE) return setAt(null);
      const m = margin.getBoundingClientRect(), r = hl.getBoundingClientRect();
      // Beside the passage, when the screen has room to the left of the margin's right edge.
      if (m.right >= WIDTH + 12) {
        const top = Math.max(0, r.top - m.top - 14);
        return setAt({ mode: "side", top, px: r.left - m.left - 6, py: r.top - m.top + 10, w: m.width, ty: 0 });
      }
      // Otherwise just under the passage's last line, kept on screen; the line drops from the passage to it.
      const last = hl.getClientRects();
      const line = last[last.length - 1] ?? r;
      const width = Math.min(360, window.innerWidth - 32);
      const x = Math.min(Math.max(line.left - 8, 16), window.innerWidth - width - 16);
      const top = line.bottom - m.top + 14;
      const px = Math.min(Math.max(line.left + 14, x + 20), x + width - 20) - m.left;
      setAt({ mode: "below", top, left: x - m.left, width, px, py: line.bottom - m.top - 2, w: 0, ty: top });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [comment.id]);

  return (
    <>
      <div className="comment-scrim" onClick={onClose} />
      {at && (
        // The line runs from the popover's right edge (the margin's right edge) to the passage.
        <svg className="comment-link" aria-hidden="true" style={{ top: 0 }}>
          <path d={at.mode === "side" ? `M${at.w - 2} ${at.py} L${at.px} ${at.py}` : `M${at.px} ${at.py} L${at.px} ${at.ty}`} />
          <circle cx={at.px} cy={at.py} r="3.5" />
        </svg>
      )}
      <section ref={box} data-kind="review" className={`comment-modal${at ? ` anchored ${at.mode}` : ""}`} style={at ? { top: at.top, ...(at.mode === "below" ? { left: at.left, width: at.width } : {}) } : undefined} role="dialog" aria-label={`Question: ${comment.title}`}>
        <header>
          <div className="comment-head">
            <p className="pop-eyebrow">Question</p>
            <h2>{comment.title}</h2>
            {/*
              Who asked: the reviewer, and the model it ran on. The same question from a small model and a large one
              is not the same question, and the writer is the one deciding how much to make of it.
            */}
            <p className="comment-by">
              {comment.model && <EngineIcon engine={engineOf(comment.model)} />}
              <span>{comment.thinker}{comment.model ? ` · ${modelName(comment.model)}` : ""}</span>
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="comment-body">
          {/* The writer's own words, so they can see what the question is about without hunting for the highlight. */}
          <blockquote className="comment-passage">{comment.anchor.exact}</blockquote>
          {comment.body && <p className="comment-point">{comment.body}</p>}
          {/*
            The reviewer's own picture, when it drew one. An `<img>`, not inline SVG: an animated SVG still animates
            in one, while a script inside it does not run — and the file came from an agent.
          */}
          {comment.image && <img className="comment-image" src={assetUrl(comment.image)} alt="" />}
          {comment.description && <p className="comment-why">{comment.description}</p>}
        </div>
        <footer>
          <button type="button" className="btn btn-ghost" title="Take this question down, and don't raise it on this passage again" onClick={() => { onDismiss?.(comment.id); onClose(); }}>Dismiss</button>
          {onAsk && <button type="button" className="btn btn-ghost ask" title="Ask the reviewer about this passage" onClick={() => { onAsk(comment.id); onClose(); }}>Ask</button>}
        </footer>
      </section>
    </>
  );
}
