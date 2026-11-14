import { useEffect, useRef, useState } from "react";

/** Where a copy stands: what the button shows, and its class. */
export type CopyState = { state: "idle" } | { state: "copying" } | { state: "copied"; note: string } | { state: "failed"; note: string };

/** How long the button shows how its copy went before it is a plain button again. */
export const COPY_SHOWN_MS = 2000;

const LABEL = "Copy page as markdown";

const Icon = ({ state }: { state: CopyState["state"] }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {state === "copied" ? <path d="M5 12.5l4.5 4.5L19 7.5" />
      : state === "failed" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5v.01" /></>
      : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>}
  </svg>
);

/**
 * The top bar's Copy: what it shows in each state. Its label is always "Copy page as markdown"; its title says how the
 * last copy went (which images were linked rather than embedded, or why it failed).
 */
export function CopyButtonView({ copy, onCopy }: { copy: CopyState; onCopy(): void }) {
  const title = copy.state === "copied" || copy.state === "failed" ? copy.note : copy.state === "copying" ? "Copying…" : LABEL;
  return (
    <button type="button" className={`btn btn-ghost copy-page ${copy.state}`} aria-label={LABEL} title={title} onClick={onCopy} disabled={copy.state === "copying"}>
      <Icon state={copy.state} />
      {copy.state === "copied" && <span className="copy-note">Copied</span>}
      {copy.state === "failed" && <span className="copy-note">Couldn't copy</span>}
    </button>
  );
}

/** Copy page in the top bar: runs `run` (the page's `copyPage`) and shows how it went for a moment. */
export function CopyButton({ run }: { run(): Promise<{ note: string }> }) {
  const [copy, setCopy] = useState<CopyState>({ state: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = (s: CopyState) => {
    setCopy(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy({ state: "idle" }), COPY_SHOWN_MS);
  };
  const onCopy = () => {
    clearTimeout(timer.current);
    setCopy({ state: "copying" });
    // Called within the click, so the clipboard write it starts at once counts as the writer's own.
    run().then(
      (r) => show({ state: "copied", note: r.note }),
      (e: unknown) => show({ state: "failed", note: `Couldn't copy: ${e instanceof Error ? e.message : String(e)}` }),
    );
  };
  return <CopyButtonView copy={copy} onCopy={onCopy} />;
}
