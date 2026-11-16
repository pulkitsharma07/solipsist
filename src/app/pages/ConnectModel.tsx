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
        <p>Solipsist's agents need an AI model to answer. They reach one through OpenRouter, where one key opens hundreds of AI models.</p>
        {canSave ? (
          <form className="connect-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <ol className="connect-steps">
              <li>Sign in at <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer">openrouter.ai</a> and add a little credit.</li>
              <li>Open <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">Keys</a> and create one.</li>
              <li>Paste it here.</li>
            </ol>
            <input
              className="field" type="password" autoFocus autoComplete="off" spellCheck={false}
              placeholder="sk-or-v1-…" aria-label="OpenRouter key"
              value={key} onChange={(e) => { setKey(e.target.value); setProblem(null); }}
            />
            {problem && <p className="dialog-warn" role="alert">{problem}</p>}
            <p className="muted">Kept on your computer, in your system's keychain (or a file only you can read where there's none). It is sent to OpenRouter only.</p>
            <p className="muted">Or, then restart: set <code>SOLIPSIST_OPENROUTER_KEY</code> in your environment, or run <code>pi</code>, then <code>/login</code>.</p>
            <footer>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Not now</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !key.trim()}>{busy ? "Checking…" : "Save key"}</button>
            </footer>
          </form>
        ) : (
          <>
            <p className="muted">Set <code>SOLIPSIST_OPENROUTER_KEY</code> in your environment, or run <code>pi</code>, then <code>/login</code>. Then restart Solipsist.</p>
            <footer><button className="btn btn-primary" onClick={onClose}>Close</button></footer>
          </>
        )}
      </section>
    </>
  );
}
