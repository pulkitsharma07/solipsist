import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { keyLabel } from "../keys";

/** One stop of the tour: the part of the page it points at (a selector), and what it says about it. */
export interface TourStep { id: string; target: string; title: string; body: ReactNode }

/**
 * The stops, in order: the page's agent first, then the status bar from left to right. A stop whose part isn't on the
 * page (no Page review without a model, say) is skipped.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "agent", target: ".pi-launch", title: "Your page agent",
    body: <>Chat with an AI agent about this whole page here. To ask for something in the text, put the caret where it should go, or select a passage, and press <kbd>{keyLabel("Mod-.")}</kbd>. The agent suggests; nothing changes until you accept.</>,
  },
  {
    id: "mode", target: ".statusbar .sb-mode", title: "Editing mode",
    body: <>Standard editing, or Vim keys if you prefer them. Click to switch at any time.</>,
  },
  {
    id: "model", target: ".statusbar .sb-model", title: "AI model",
    body: <>The AI model that answers on this page. Click to open the agent panel and pick another; each page keeps its own.</>,
  },
  {
    id: "cost", target: ".statusbar .sb-cost", title: "Cost",
    body: <>What this page's agents have spent since you opened it. Daily and monthly limits stop new requests before they run away.</>,
  },
  {
    id: "review", target: ".statusbar .review-page", title: "Page review",
    body: <>Click it to start a review: an agent reads the whole page and leaves questions in the margin. It can't change a word of it.</>,
  },
  {
    id: "debug", target: ".statusbar .debug-toggle", title: "Agent panel",
    body: <>Everything the agents are doing, step by step, with the switch that turns them off for this page.</>,
  },
];

const DONE_KEY = "solipsist.tour-done";
/** Whether this browser has seen the tour (localStorage, which may be refused: then it is not shown, rather than every time). */
export function tourSeen(): boolean { try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return true; } }
export function markTourSeen(): void { try { localStorage.setItem(DONE_KEY, "1"); } catch { /* not kept */ } }

type Box = { top: number; left: number; width: number; height: number };
const PAD = 6;
const CARD_W = 320;

/** Where the card goes for a target: above it when it is low on the screen (the status bar), else below; kept on screen. */
export function cardPlace(box: Box, view: { width: number; height: number }): { top?: number; bottom?: number; left: number; side: "above" | "below" } {
  const left = Math.min(Math.max(16, box.left + box.width / 2 - CARD_W / 2), Math.max(16, view.width - CARD_W - 16));
  return box.top > view.height / 2
    ? { bottom: view.height - box.top + PAD + 10, left, side: "above" }
    : { top: box.top + box.height + PAD + 10, left, side: "below" };
}

/** The card of one stop, as drawn: the title, what it says, where the tour is, and its buttons. */
export function TourCard({ step, index, total, onBack, onNext, onSkip, style }: { step: TourStep; index: number; total: number; onBack(): void; onNext(): void; onSkip(): void; style?: React.CSSProperties }) {
  const last = index === total - 1;
  return (
    <section className="tour-card" role="dialog" aria-label="Product tour" aria-describedby={`tour-${step.id}`} style={style}>
      <p className="tour-count">{index + 1} of {total}</p>
      <h3>{step.title}</h3>
      <p id={`tour-${step.id}`}>{step.body}</p>
      <footer>
        {!last && <button type="button" className="btn btn-ghost tour-skip" onClick={onSkip}>Skip tour</button>}
        {index > 0 && <button type="button" className="btn" onClick={onBack}>Back</button>}
        <button type="button" className="btn btn-primary" autoFocus onClick={onNext}>{last ? "Done" : "Next"}</button>
      </footer>
    </section>
  );
}

/**
 * The tour of a page, the first time one opens: a ring around each part in turn and a card that says what it is for.
 * Next, Back, Skip tour or Escape; finishing or skipping it marks it seen. Nothing on the page is blocked behind it.
 */
export function ProductTour({ onClose, steps = TOUR_STEPS }: { onClose(): void; steps?: TourStep[] }) {
  // Only the stops whose part is on the page now.
  const [shown] = useState(() => steps.filter((s) => document.querySelector(s.target)));
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const step = shown[i];
  const finish = useCallback(() => { markTourSeen(); onClose(); }, [onClose]);
  const measure = useCallback(() => {
    const el = step && document.querySelector(step.target);
    if (!el) return setBox(null);
    const r = el.getBoundingClientRect();
    setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Only while the card has focus: the arrows and Escape belong to the editor (and Vim) otherwise.
    const key = (e: KeyboardEvent) => {
      if (!(document.activeElement instanceof Element && document.activeElement.closest(".tour-card"))) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
      else if (e.key === "ArrowRight") setI((n) => Math.min(n + 1, shown.length - 1));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(n - 1, 0));
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); window.removeEventListener("keydown", key, true); };
  }, [measure, finish, shown.length]);
  useEffect(() => { if (!shown.length) finish(); }, [shown.length, finish]);
  if (!step) return null;
  const view = { width: window.innerWidth, height: window.innerHeight };
  const place = box ? cardPlace(box, view) : { top: view.height / 3, left: Math.max(16, view.width / 2 - CARD_W / 2), side: "below" as const };
  return (
    <div className="tour" data-step={step.id}>
      {box && <div className="tour-ring" aria-hidden style={{ top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 }} />}
      <TourCard
        step={step} index={i} total={shown.length}
        onBack={() => setI((n) => Math.max(0, n - 1))}
        onNext={() => (i === shown.length - 1 ? finish() : setI(i + 1))}
        onSkip={finish}
        style={{ top: place.top, bottom: place.bottom, left: place.left, width: CARD_W }}
      />
    </div>
  );
}
