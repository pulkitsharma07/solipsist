import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getSyncState, reloadDoc, syncDoc } from "../doc/client";

export type SyncProblem = "changed" | "clash" | "missing";

/** Asks before Sync replaces something the writer hasn't seen. Nothing has been written when this shows. */
export function SyncDialog({ path, problem, onReload, onOverwrite, onDiscard, onCancel }: {
  path: string;
  problem: SyncProblem;
  onReload(): void;
  onOverwrite(): void;
  onDiscard(): void;
  onCancel(): void;
}) {
  return (
    <>
      <div className="dialog-backdrop" aria-hidden />
      <section className="dialog" role="dialog" aria-modal="true" aria-label="Sync">
        {problem === "changed" && <p><code>{path}</code> changed since you loaded it. Syncing to the file now would replace those changes.</p>}
        {problem === "clash" && <p>You and <code>{path}</code> changed the same text, so they can't be merged.</p>}
        {problem === "missing" && <p><code>{path}</code> was deleted. Syncing will create it again.</p>}
        <footer>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          {problem === "clash" && <button className="btn" onClick={onDiscard}>Discard my edits and load the file</button>}
          {problem !== "missing" && <button className={`btn${problem === "changed" ? "" : " btn-primary"}`} onClick={onOverwrite}>Overwrite the file</button>}
          {problem === "changed" && <button className="btn btn-primary" onClick={onReload}>Reload from file</button>}
          {problem === "missing" && <button className="btn btn-primary" onClick={onOverwrite}>Create it</button>}
        </footer>
      </section>
    </>
  );
}

/** The top bar's controls for a page in a project: send it to the original, or take the original's changes in. */
export function SyncButtons({ unsynced, disabled, synced, onSync, onReload }: { unsynced: boolean; disabled: boolean; synced: boolean; onSync(): void; onReload(): void }) {
  return (
    <>
      <button className="btn btn-ghost" disabled={disabled} title="Bring changes made to the file into this page" onClick={onReload}>Reload from file</button>
      <button className="btn" disabled={disabled || !unsynced} title="Write this page to its original file" onClick={onSync}>{synced && !unsynced ? "Synced to file" : "Sync to file"}</button>
    </>
  );
}

/** Sync for one page: its state, the buttons and the dialog. Without `path` (no project) there is nothing to show. */
export function useSync(id: string, path: string | undefined, save: string, saveNow: () => Promise<unknown>): { buttons: ReactNode; dialog: ReactNode } {
  const [unsynced, setUnsynced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(false);
  const [problem, setProblem] = useState<SyncProblem | null>(null);

  const refresh = useCallback(() => { if (path) void getSyncState(id).then(setUnsynced); }, [id, path]);
  useEffect(() => { if (save === "saved") refresh(); else setSynced(false); }, [save, refresh]);

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await saveNow(); await f(); } finally { setBusy(false); refresh(); }
  };
  const sync = (force: boolean) => act(async () => {
    const r = await syncDoc(id, force);
    if (r.ok) { setProblem(null); setSynced(true); }
    else if (r.code === "original_changed") setProblem("changed");
    else if (r.code === "original_missing") setProblem("missing");
  });
  const reload = (discard: boolean) => act(async () => {
    const r = await reloadDoc(id, discard);
    if (r.ok) setProblem(null);
    else if (r.code === "conflict") setProblem("clash");
    else if (r.code === "original_missing") setProblem("missing");
  });

  if (!path) return { buttons: null, dialog: null };
  return {
    buttons: <SyncButtons unsynced={unsynced} synced={synced} disabled={busy || save !== "saved"} onSync={() => void sync(false)} onReload={() => void reload(false)} />,
    dialog: problem && <SyncDialog path={path} problem={problem} onReload={() => void reload(false)} onOverwrite={() => void sync(true)} onDiscard={() => void reload(true)} onCancel={() => setProblem(null)} />,
  };
}
