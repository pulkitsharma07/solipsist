import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PromptsPane, type LoadedPrompts } from "./PromptsPane";
import { SettingsPane, type LoadedConfig } from "./SettingsPane";

type Tab = "prompts" | "settings";

/** The gear (top bar, pages list) and the dialog it opens. */
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn btn-ghost settings-gear" onClick={() => setOpen(true)} aria-label="Settings" title="Settings and prompts">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Prompts and the loaded settings in one dialog. Closing with unsaved prompt changes asks once. `prompts` and `config`
 * stand in for what the server sends, to render the dialog without one.
 */
export function SettingsDialog({ onClose, tab: first = "prompts", prompts, config }: { onClose(): void; tab?: Tab; prompts?: LoadedPrompts; config?: LoadedConfig }) {
  const [tab, setTab] = useState<Tab>(first);
  const [dirty, setDirty] = useState(false);
  const [warn, setWarn] = useState(false);
  const close = useCallback(() => {
    if (dirty && !warn) return setWarn(true);
    onClose();
  }, [dirty, warn, onClose]);
  // Escape is answered by what the dialog knows now, not by what it knew when the key was last listened for: an
  // effect that listens again when `close` changes runs only after the next paint, so Escape pressed in the moment
  // after an edit would be answered by a `close` that hadn't heard of it, and the dialog would shut on unsaved
  // changes without a word. The ref is set as the dialog commits (before the browser can deliver the next key).
  const latest = useRef(close);
  useLayoutEffect(() => { latest.current = close; });
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") latest.current(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => { if (!dirty) setWarn(false); }, [dirty]);

  return (
    <>
      <div className="dlg-backdrop" onClick={close} />
      <section className="dlg" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <nav className="dlg-tabs" aria-label="Settings sections">
            <button className={`dlg-tab${tab === "prompts" ? " on" : ""}`} onClick={() => setTab("prompts")} aria-pressed={tab === "prompts"}>Prompts</button>
            <button className={`dlg-tab${tab === "settings" ? " on" : ""}`} onClick={() => setTab("settings")} aria-pressed={tab === "settings"}>Loaded settings</button>
          </nav>
          <button className="btn btn-ghost" onClick={close} aria-label="Close">✕</button>
        </header>
        {warn && <p className="dlg-warn" role="alert">There are unsaved changes to a prompt. Save or revert them, or close again to discard them.</p>}
        <div className="dlg-body">
          {/* Both stay mounted so a draft survives a look at the other tab. */}
          <div hidden={tab !== "prompts"}><PromptsPane initial={prompts} onDirty={setDirty} /></div>
          <div hidden={tab !== "settings"}><SettingsPane initial={config} /></div>
        </div>
      </section>
    </>
  );
}
