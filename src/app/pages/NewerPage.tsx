import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { FORMAT, markdownToDoc, parseFile } from "../../shared/docfile";
import { editorExtensions } from "../editor/behaviour";
import { TopBar } from "./Frame";

/** The page format a file was saved in, when it is newer than this build's (`FORMAT`); null when this build can edit it. */
export function newerFormat(file: string): number | null {
  const { format } = parseFile(file);
  return format > FORMAT ? format : null;
}

/**
 * A page saved by a newer Solipsist: shown, never written. The server refuses every write to it (`NewerPageError`),
 * and here nothing tries: no session, no saves, no agents, no Sync; the editor can't be typed in. The banner says why
 * and what to do.
 */
export function NewerPage({ title, file, format }: { title: string; file: string; format: number }) {
  const editor = useEditor({ immediatelyRender: false, editable: false, extensions: editorExtensions(), content: markdownToDoc(parseFile(file).markdown).toJSON() }, [file]);
  useEffect(() => { document.title = `${title} · Solipsist`; }, [title]);
  return (
    <div className="app">
      <TopBar title={title} save="readonly" />
      <div className="banner warn" role="note">
        This page was saved by a newer Solipsist (page format {Number.isFinite(format) ? format : "unknown"}; this one knows up to {FORMAT}). Update Solipsist to edit it; until then it is read-only, and nothing here changes it.
      </div>
      <main className="desk">
        <div className="sheet-row">
          <article className="sheet" aria-label="Page">
            <EditorContent editor={editor} />
          </article>
        </div>
      </main>
    </div>
  );
}
