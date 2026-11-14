import type { Note } from "./AgentFeed";
import { EngineIcon } from "./EngineIcon";

/**
 * The icon of a margin note, by where the agent stands: a clock while the task waits to be picked up, the engine's own
 * mark while it works (a warning when its latest step is an error), a drawn check once it is done and still here, a
 * moon when it sleeps, a speech bubble while the writer chats with it. Each moves in its own way (margin.css): the
 * check draws itself once, the clock's hand turns, the bubble's dots rise in turn. Colours are the design system's.
 */
const Svg = ({ cls, children }: { cls: string; children: React.ReactNode }) => (
  <svg className={`note-icon ${cls}`} viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export function NoteIcon({ note, engine }: { note: Note; engine: string }) {
  // Declined: a crossed ring, whatever its agent is doing now.
  if (note.declined !== undefined) return <Svg cls="ni-declined"><circle cx="8" cy="8" r="6.25" /><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" /></Svg>;
  switch (note.mode) {
    case "waiting":
      return <Svg cls="ni-wait"><circle cx="8" cy="8" r="6.25" /><path className="ni-hand" d="M8 8V4.5" /><path d="M8 8l2.5.8" /></Svg>;
    case "idle":
    case "kept":
      return <Svg cls="ni-done"><circle className="ni-ring" cx="8" cy="8" r="6.25" /><path className="ni-tick" pathLength={1} d="M5 8.3l2.1 2.1L11 6" /></Svg>;
    case "snoozed":
      return <Svg cls="ni-sleep"><path d="M10.5 10.6A5 5 0 0 1 5.4 3.9a5 5 0 1 0 6.7 6.7z" transform="translate(-1 1.2)" /><path className="ni-z ni-z1" d="M10.2 2.6h2.4l-2.4 2.6h2.4" /></Svg>;
    case "chatting":
      return <Svg cls="ni-chat"><path d="M3.2 3h9.6a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H8.4L5.2 13.4v-2.8H3.2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><circle className="ni-dot ni-d1" cx="5.6" cy="6.8" r=".4" /><circle className="ni-dot ni-d2" cx="8" cy="6.8" r=".4" /><circle className="ni-dot ni-d3" cx="10.4" cy="6.8" r=".4" /></Svg>;
    default:
      return note.step?.kind === "error"
        ? <Svg cls="ni-warn"><path d="M8 2.6l5.8 10.2H2.2z" /><path d="M8 6.6v3" /><path d="M8 11.3v.01" /></Svg>
        : <EngineIcon engine={engine} className="note-icon ni-work" />;
  }
}
