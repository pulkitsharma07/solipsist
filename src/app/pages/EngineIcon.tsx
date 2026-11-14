import { PiIcon } from "./PiIcon";

/** The mark of an engine (`pi`): the agent, wherever the page shows it. An engine without one of its own gets Pi's. */
export function EngineIcon({ size = 14, className = "" }: { engine?: string; size?: number; className?: string }) {
  return <PiIcon size={size} className={className} />;
}

export { engineOf } from "../../shared/choice";
