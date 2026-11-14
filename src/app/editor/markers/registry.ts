import type { TaskState } from "../../../shared/docfile";
import { pluginFor, type IndicatorName, type PopupDef } from "../../../shared/plugin";
import { blinkingDot, nothing, spinner } from "./indicators";

export type { PopupContext, PopupDef } from "../../../shared/plugin";

/** What the page shows for one state of a task type, with every default filled in. `loader.ts` moves between them. */
export interface PhaseDef {
  /** Tooltip and accessible name. */
  label: string;
  /** A fresh picture each time the state is entered; it may animate itself. */
  indicator(): Element;
  popup?: PopupDef;
}

const PICTURES: Record<IndicatorName, () => Element> = { blink: blinkingDot, spinner, none: nothing };
const DEFAULTS: Record<TaskState, { says: string; indicator: IndicatorName }> = {
  pending: { says: "waiting to be picked up", indicator: "blink" },
  ack: { says: "being worked on", indicator: "spinner" },
  sug: { says: "a suggestion is waiting for you", indicator: "none" },
  done: { says: "finished", indicator: "none" },
  btn: { says: "kept as a button", indicator: "none" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The phases of a task type: what its plugin says (`src/shared/plugin.ts`) over the defaults. */
export function phasesFor(taskType: string): Record<TaskState, PhaseDef> {
  const plugin = pluginFor(taskType);
  const out = {} as Record<TaskState, PhaseDef>;
  for (const state of Object.keys(DEFAULTS) as TaskState[]) {
    const own = plugin?.phases?.[state];
    const pic = own?.indicator ?? DEFAULTS[state].indicator;
    out[state] = { label: own?.label ?? cap(DEFAULTS[state].says), indicator: typeof pic === "function" ? pic : PICTURES[pic], ...(own?.popup && { popup: own.popup }) };
  }
  return out;
}
