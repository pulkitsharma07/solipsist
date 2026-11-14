import type { TaskState } from "../../../shared/docfile";
import { openPopup, type OpenPopup } from "./popup";
import { phasesFor, type PhaseDef } from "./registry";

/** How long the old picture takes to fade out; matches `.task-face.leave` in the CSS. */
const LEAVE_MS = 260;
/** A popup that opens by itself waits for the new picture to settle first. */
const POPUP_DELAY_MS = 380;

export interface Loader {
  /** The element to put in the page. It stays the same across state changes, so the change can be animated. */
  el: HTMLElement;
  readonly state: TaskState;
  /** `live`: the state changed while the page was open (not a page that loaded already in this state), so popups may open by themselves. */
  setState(next: TaskState, opts?: { live?: boolean }): void;
  destroy(): void;
}

/**
 * The picture (and popup) of one marker, moving from state to state as the markdown file says. `activate`, if
 * given, is asked first when the writer clicks it: a popup of the page's own (the instruction of a range), which calls
 * `closed` when it closes, or null to fall back to the phase's popup.
 */
export function createLoader(taskType: string, id: string, initial: TaskState, activate?: (el: HTMLElement, state: TaskState, closed: () => void) => OpenPopup | null): Loader {
  const phases = phasesFor(taskType);
  const el = document.createElement("span");
  el.className = "task-loader";
  el.contentEditable = "false";
  el.dataset.taskType = taskType;
  el.dataset.id = id;
  let state = initial;
  let popup: OpenPopup | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (f: () => void, ms: number) => { const t = setTimeout(() => { timers.delete(t); f(); }, ms); timers.add(t); };

  const face = (phase: PhaseDef) => {
    const f = document.createElement("span");
    f.className = "task-face";
    f.append(phase.indicator());
    return f;
  };
  const describe = () => {
    const phase = phases[state];
    el.dataset.state = state;
    el.title = phase.label;
    el.setAttribute("aria-label", phase.label);
    if (phase.popup || activate) { el.setAttribute("role", "button"); el.tabIndex = 0; } else { el.removeAttribute("role"); el.removeAttribute("tabindex"); }
  };
  const closePopup = () => { popup?.close(); popup = null; };
  const openPhasePopup = () => {
    if (popup || !el.isConnected) return;
    const own = activate?.(el, state, () => { if (popup === own) popup = null; });
    if (own) { popup = own; return; }
    const spec = phases[state].popup;
    if (!spec) return;
    const at = state;
    popup = openPopup(el, spec.render({ id, taskType, state: at, close: closePopup }), () => { popup = null; });
  };

  let current = face(phases[state]);
  el.append(current);
  describe();

  // Clicking never moves the caret out of the page.
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("click", () => (popup ? closePopup() : openPhasePopup()));
  el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); popup ? closePopup() : openPhasePopup(); } });

  return {
    el,
    get state() { return state; },
    setState(next, opts = {}) {
      if (next === state) return;
      state = next;
      closePopup();
      const leaving = current;
      current = face(phases[next]);
      current.classList.add("enter");
      leaving.classList.add("leave");
      el.append(current);
      later(() => leaving.remove(), LEAVE_MS);
      describe();
      if (opts.live && phases[next].popup?.opens === "auto") later(openPhasePopup, POPUP_DELAY_MS);
    },
    destroy() {
      closePopup();
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
