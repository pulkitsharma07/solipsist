import { useState } from "react";
import { saveOpenRouterKey } from "../doc/client";

const KEYS_URL = "https://openrouter.ai/settings/keys";

/**
 * Connect an AI model: shown when a page opens and no engine can run (no key, no login of Pi's own), and when asking the
 * agent would otherwise fail with nothing to go on. The writer pastes an OpenRouter key, which the server checks and
 * keeps in the system's keychain (`saveOpenRouterKey`); `canSave` false (`pi.key_store: off`) shows only how to set one.
 */
export function ConnectModel({ onClose, onConnected, canSave = true, save = saveOpenRouterKey }: { onClose(): void; onConnected?(): void; canSave?: boolean; save?: typeof saveOpenRouterKey }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await save(key.trim());
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    if (r.noEngine) return setProblem("The key was saved, but the AI model still can't run. Restart Solipsist and try again.");
    onConnected?.();
  };
  return (
    <>
      <div className="dialog-backdrop" aria-hidden onClick={onClose} />
      <section className="dialog connect-model" role="dialog" aria-modal="true" aria-label="Connect an AI model" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <h2>Connect an AI model</h2>
        {canSave ? (
          <form className="connect-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <p>Paste an OpenRouter key and the agents can start.</p>
            <input
              className="field" type="password" autoFocus autoComplete="off" spellCheck={false}
              placeholder="sk-or-v1-…" aria-label="OpenRouter key"
              value={key} onChange={(e) => { setKey(e.target.value); setProblem(null); }}
            />
            {problem && <p className="dialog-warn" role="alert">{problem}</p>}
            <p className="connect-hint"><a href={KEYS_URL} target="_blank" rel="noopener noreferrer">Get a key ↗</a> · Kept in your system's keychain</p>
            <footer>
              <details className="connect-more">
                <summary>Other ways</summary>
                <p>Set <code>SOLIPSIST_OPENROUTER_KEY</code>, or run <code>pi</code>, then <code>/login</code>. Then restart Solipsist.</p>
              </details>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>{busy ? "Checking…" : "Save key"}</button>
            </footer>
          </form>
        ) : (
          <>
            <p>Set <code>SOLIPSIST_OPENROUTER_KEY</code> in your environment, or run <code>pi</code>, then <code>/login</code>. Then restart Solipsist.</p>
            <footer><button className="btn btn-primary" onClick={onClose}>Close</button></footer>
          </>
        )}
      </section>
    </>
  );
}
