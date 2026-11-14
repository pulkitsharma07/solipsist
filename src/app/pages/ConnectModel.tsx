/** Says how to connect a model, when no engine can run: asking the agent would otherwise fail with nothing to go on. */
export function ConnectModel({ onClose }: { onClose(): void }) {
  return (
    <>
      <div className="dialog-backdrop" aria-hidden />
      <section className="dialog" role="dialog" aria-modal="true" aria-label="Connect a model">
        <h2>Connect a model</h2>
        <p>The agent needs a model before it can answer. Any one of these will do, then restart Solipsist:</p>
        <p className="muted">Put <code>SOLIPSIST_OPENROUTER_KEY</code> in a <code>.env</code> file here.</p>
        <p className="muted">Run <code>pi</code>, then <code>/login</code>.</p>
        <footer><button className="btn btn-primary" onClick={onClose}>Close</button></footer>
      </section>
    </>
  );
}
