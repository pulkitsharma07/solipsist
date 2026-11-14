import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { PromptView } from "../../server/prompts";

export interface LoadedPrompts { dir: string; prompts: PromptView[] }

const GROUPS = ["Agent", "Chat", "Task types"] as const;

async function call(method: string, id: string, body?: unknown): Promise<PromptView> {
  const res = await fetch(`/api/prompts/${encodeURIComponent(id)}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data;
}

/**
 * The prompts the agents are given, to read and change. A change is kept in the writer's prompts folder and applies to
 * the next run and the next agent started. `initial` is for rendering without the server.
 */
export function PromptsPane({ initial, onDirty }: { initial?: LoadedPrompts; onDirty?(dirty: boolean): void }) {
  const [data, setData] = useState<LoadedPrompts | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch("/api/prompts")
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`))))
      .then((d) => live && setData(d))
      .catch((e) => live && setLoadError(String(e.message ?? e)));
    return () => { live = false; };
  }, [initial]);

  const prompts = data?.prompts ?? [];
  const current = prompts.find((p) => p.id === picked) ?? prompts[0] ?? null;
  const draft = current ? drafts[current.id] ?? current.text : "";
  const dirtyIds = useMemo(() => prompts.filter((p) => p.id in drafts && drafts[p.id] !== p.text).map((p) => p.id), [prompts, drafts]);
  useLayoutEffect(() => onDirty?.(dirtyIds.length > 0), [dirtyIds.length, onDirty]);

  if (loadError) return <p className="dlg-note">Couldn't load the prompts ({loadError}).</p>;
  if (!data || !current) return <p className="dlg-note">Loading…</p>;

  const replace = (p: PromptView) => {
    setData({ ...data, prompts: data.prompts.map((x) => (x.id === p.id ? p : x)) });
    setDrafts(({ [p.id]: _gone, ...rest }) => rest);
  };
  const run = async (f: () => Promise<PromptView>) => {
    setBusy(true);
    setError(null);
    try { replace(await f()); } catch (e: any) { setError(String(e.message ?? e)); } finally { setBusy(false); }
  };
  const changed = draft !== current.text;
  const missing = current.slots.filter((s) => s.required && !draft.includes(`{${s.name}}`));

  return (
    <div className="prompts">
      <nav className="prompt-list" aria-label="Prompts">
        {GROUPS.map((g) => {
          const items = prompts.filter((p) => p.group === g);
          return items.length === 0 ? null : (
            <section key={g}>
              <h3>{g}</h3>
              <ul>
                {items.map((p) => (
                  <li key={p.id}>
                    <button className={`prompt-item${p.id === current.id ? " on" : ""}${p.custom ? " custom" : ""}`} onClick={() => { setPicked(p.id); setError(null); }} aria-current={p.id === current.id}>
                      <span>{p.title}</span>
                      {dirtyIds.includes(p.id) ? <i title="Unsaved changes">unsaved</i> : p.custom ? <i title="Different from the built-in text">edited</i> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      <div className="prompt-editor">
        <h3>{current.title} <code>{current.id}</code></h3>
        <p className="what">{current.description}</p>
        {current.slots.length > 0 && (
          <ul className="slots" aria-label="Slots">
            {current.slots.map((s) => <li key={s.name} className={s.required ? "required" : undefined} title={s.description + (s.required ? " Required." : "")}><code>{`{${s.name}}`}</code>{s.required && <b>required</b>}</li>)}
          </ul>
        )}
        <textarea
          key={current.id}
          value={draft}
          spellCheck={false}
          aria-label={`${current.title} text`}
          onChange={(e) => setDrafts({ ...drafts, [current.id]: e.target.value })}
        />
        {error && <p className="error" role="alert">{error}</p>}
        {!error && missing.length > 0 && <p className="warn">Leave in {missing.map((s) => `{${s.name}}`).join(", ")}: {missing[0]!.description}</p>}
        <footer>
          <button className="btn btn-primary" disabled={busy || !changed || draft.trim() === ""} onClick={() => run(() => call("PUT", current.id, { text: draft }))}>Save</button>
          <button className="btn" disabled={busy || !changed} onClick={() => setDrafts(({ [current.id]: _gone, ...rest }) => rest)}>Revert</button>
          <button className="btn btn-ghost" disabled={busy || !current.custom} onClick={() => run(() => call("DELETE", current.id))} title="Bring the built-in text back and delete your file.">Reset to default</button>
          <span className="where" title={current.file}>{current.custom ? `Saved in ${current.file}` : `Built in. A change is saved in ${data.dir}`}</span>
        </footer>
        <p className="dlg-note">A change applies to the next run and the next agent started; an agent already running or waiting keeps the instructions it began with.</p>
      </div>
    </div>
  );
}
