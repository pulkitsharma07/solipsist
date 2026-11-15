import { useMemo, useState } from "react";

/** The files in folder order: each folder's name once, its files under it. */
export function byFolder(paths: string[]): { folder: string; files: string[] }[] {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const cut = p.lastIndexOf("/") + 1;
    const folder = p.slice(0, cut);
    out.set(folder, [...(out.get(folder) ?? []), p]);
  }
  return [...out].map(([folder, files]) => ({ folder, files }));
}

/**
 * The markdown files the search paths found, to pick from. `first`: the first launch, everything ticked and no way
 * round it; afterwards (Add files) it offers the files not added yet, with none ticked. When nothing is found it offers
 * a new page instead (`onCreate`), so a first launch in an empty folder has a way on.
 */
export function SetupDialog({ found, searchPaths, capped, first, failed, onAdd, onCreate, onClose }: {
  found: string[];
  searchPaths: string[];
  capped: boolean;
  first: boolean;
  /** Files that couldn't be copied, last time. */
  failed: string[];
  onAdd(paths: string[]): void;
  /** Makes a page at `path` and opens it; false when it couldn't (the name is taken or not allowed). */
  onCreate?(path: string): Promise<boolean>;
  onClose?(): void;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(first ? found : []));
  const groups = useMemo(() => byFolder(found), [found]);
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); if (!n.delete(p)) n.add(p); return n; });
  const all = found.length > 0 && picked.size === found.length;
  const count = `${picked.size} file${picked.size === 1 ? "" : "s"}`;
  const [path, setPath] = useState("notes.md");
  const [refused, setRefused] = useState<string | null>(null);
  const creating = found.length === 0 && !!onCreate;
  const create = async () => {
    const p = path.trim();
    if (!p || !onCreate) return;
    setRefused(null);
    if (!(await onCreate(p))) setRefused(p);
  };
  return (
    <>
      <div className="dialog-backdrop" aria-hidden />
      <section className="dialog" role="dialog" aria-modal="true" aria-label="Choose your files">
        <h2>Choose your files</h2>
        {found.length > 0
          ? <p className="muted">Found {found.length} markdown file{found.length === 1 ? "" : "s"}, searching: <code>{searchPaths.join(", ")}</code></p>
          : <p className="muted">No markdown files match <code>{searchPaths.join(", ")}</code>.{creating && " Start with a new page:"}</p>}
        {creating && (
          <form id="setup-new" className="setup-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <input className="field" autoFocus placeholder="notes.md" aria-label="Path of the new page" value={path} onChange={(e) => { setPath(e.target.value); setRefused(null); }} />
          </form>
        )}
        {refused && <p className="dialog-warn">Couldn't create {refused}: a file of that name exists, or the name isn't allowed.</p>}
        <p className="muted">Files in subfolders? Add patterns like <code>docs/**/*.md</code> to <code>md_search_paths</code> in solipsist.yaml.</p>
        {capped && <p className="dialog-warn">There are more files than can be listed. Use narrower patterns.</p>}
        {failed.length > 0 && <p className="dialog-warn">Couldn't copy: {failed.join(", ")}</p>}
        {found.length > 0 && (
          <div className="file-list">
            <label className="file-all"><input type="checkbox" checked={all} onChange={() => setPicked(new Set(all ? [] : found))} /> All</label>
            {groups.map((g) => (
              <div key={g.folder}>
                {g.folder && <div className="file-folder">{g.folder}</div>}
                {g.files.map((p) => (
                  <label key={p}><input type="checkbox" checked={picked.has(p)} onChange={() => toggle(p)} /> {p.slice(g.folder.length)}</label>
                ))}
              </div>
            ))}
          </div>
        )}
        <footer>
          <span className="muted">{creating
            ? "It's made empty in this folder. You'll work on a copy, written to it when you press Sync to file."
            : "You'll work on copies. These files change only when you press Sync to file."}</span>
          {onClose && <button className="btn btn-ghost" onClick={onClose}>Cancel</button>}
          {creating
            ? <button className="btn btn-primary" form="setup-new" disabled={!path.trim()}>Create page</button>
            : <button className="btn btn-primary" disabled={picked.size === 0} onClick={() => onAdd([...picked])}>Add {count}</button>}
        </footer>
      </section>
    </>
  );
}
