import { useState } from "react";
import { Link } from "react-router";
import { pageUrl } from "../../shared/ids";
import { SettingsButton } from "./SettingsDialog";
import { byFolder } from "./SetupDialog";

export interface PageRow { id: string; title: string; mtime: number; unsynced?: boolean }

/** What the home page offers when it shows a project's files. */
export interface ProjectControls {
  onAddFiles(): void;
  /** Files the search paths find that aren't pages yet: shown on Add files, so a file made since is seen. */
  newFiles: number;
  onSyncAll(): void;
  /** Pages Sync all left alone, because their originals changed. */
  skipped: string[];
  onCreate(path: string): void;
}

function ProjectList({ docs }: { docs: PageRow[] }) {
  const paths = docs.map((d) => `${d.id}.md`).sort();
  const row = new Map(docs.map((d) => [`${d.id}.md`, d]));
  return (
    <>
      {byFolder(paths).map((g) => (
        <section key={g.folder}>
          {g.folder && <h2 className="home-folder">{g.folder}</h2>}
          <ul>
            {g.files.map((p) => (
              <li key={p}>
                <Link to={pageUrl(row.get(p)!.id)}>{p.slice(g.folder.length)}</Link>
                {row.get(p)!.unsynced && <span className="tag" title="Edited here, and not written to the original file yet. Open it and press Sync to file, or use Sync all to files.">Not in file yet</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The list of pages and the ways to add to it. A project's are its files, by folder; otherwise the newest first. */
export function PagesView({ docs, onNew, project }: { docs: PageRow[]; onNew(): void; project?: ProjectControls }) {
  const [naming, setNaming] = useState(false);
  const [path, setPath] = useState("");
  return (
    <main className="home">
      <header>
        <h1>Pages</h1>
        <SettingsButton />
        {project && (
          <button className="btn" onClick={project.onAddFiles} title={project.newFiles ? `${project.newFiles} markdown file${project.newFiles === 1 ? "" : "s"} not added yet` : undefined}>
            Add files{project.newFiles > 0 && <span className="btn-count">{project.newFiles}</span>}
          </button>
        )}
        {project && <button className="btn" disabled={!docs.some((d) => d.unsynced)} title="Write every page with edits to its original file" onClick={project.onSyncAll}>Sync all to files</button>}
        <button className="btn btn-primary" onClick={project ? () => setNaming(true) : onNew}>New page</button>
      </header>
      {project && naming && (
        <form className="home-new" onSubmit={(e) => { e.preventDefault(); if (path.trim()) project.onCreate(path.trim()); }}>
          <input className="field" autoFocus placeholder="docs/notes.md" aria-label="Path of the new page" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="btn btn-primary" disabled={!path.trim()}>Create</button>
        </form>
      )}
      {project && project.skipped.length > 0 && <p className="dialog-warn">Not written, because the file changed: {project.skipped.map((id) => `${id}.md`).join(", ")}. Open each to reload from its file.</p>}
      {docs.length === 0 && <p className="muted">No pages yet.</p>}
      {project ? <ProjectList docs={docs} /> : (
        <ul>
          {docs.map((d) => (
            <li key={d.id}>
              <Link to={pageUrl(d.id)}>{d.id}.md <span className="home-title">{d.title}</span></Link>
              <time className="muted">{new Date(d.mtime).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
