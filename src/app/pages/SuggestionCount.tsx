import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { decideAll, goToSuggestion, suggestionsIn } from "../editor/suggestions";
import { keyLabel } from "../keys";

/** How many suggestions wait in the page; a click opens a menu to go to the next, or accept or reject them all. */
export function SuggestionCount({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const count = suggestionsIn(editor.state).length;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(".sug-menu, .sug-count")) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => { if (!count) setOpen(false); }, [count]);
  if (!count) return null;
  const act = (f: () => void) => (e: React.MouseEvent) => { e.preventDefault(); setOpen(false); f(); editor.view.focus(); };
  const left = button.current?.getBoundingClientRect().left ?? 0;
  return (
    <>
      <button ref={button} type="button" className="sb-item sb-count sug-count" title={`Suggestions waiting for you (${keyLabel("Mod-Alt-]")} for the next)`} onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }}>
        {count} {count === 1 ? "suggestion" : "suggestions"}
      </button>
      {open && (
        <div className="sug-menu" role="menu" style={{ left }}>
          <button type="button" role="menuitem" onMouseDown={act(() => goToSuggestion(editor.view, 1))}>Next</button>
          <button type="button" role="menuitem" onMouseDown={act(() => decideAll(editor.view, "accepted"))}>Accept all</button>
          <button type="button" role="menuitem" onMouseDown={act(() => decideAll(editor.view, "rejected"))}>Reject all</button>
        </div>
      )}
    </>
  );
}
