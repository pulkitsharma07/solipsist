import { useEffect, useState } from "react";
import { useLoaderData, useNavigate, useRevalidator } from "react-router";
import { pageUrl } from "../../shared/ids";
import { addFiles, createPage, getSetup, listPages, syncDoc } from "../doc/client";
import { PagesView } from "./PagesView";
import { SetupDialog } from "./SetupDialog";

export { PagesView };
export const pagesLoader = async () => {
  const [docs, setup] = await Promise.all([listPages(), getSetup()]);
  return { docs, setup };
};

export function Pages() {
  const { docs, setup } = useLoaderData() as Awaited<ReturnType<typeof pagesLoader>>;
  const navigate = useNavigate();
  const { revalidate, state } = useRevalidator();
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

  // Back on the tab: the files and the setup again, since they change outside it (a new file, a restart with new
  // search paths), and nothing pushes them here.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible" && state === "idle") void revalidate(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => { window.removeEventListener("focus", again); document.removeEventListener("visibilitychange", again); };
  }, [revalidate, state]);

  const add = async (paths: string[]) => {
    const r = await addFiles(paths);
    setFailed(r.failed);
    if (!r.failed.length) setAdding(false);
    await revalidate();
  };
  const syncAll = async () => {
    const left: string[] = [];
    for (const d of docs.filter((d) => d.unsynced)) if (!(await syncDoc(d.id, false)).ok) left.push(d.id);
    setSkipped(left);
    await revalidate();
  };
  const create = async (path: string) => { const id = await createPage(path); if (id) navigate(pageUrl(id)); };
  // It opens by itself on the first launch, and again when md_search_paths changed and found files not added yet.
  const open = setup.needed || setup.changed || adding;
  const close = async () => {
    if (setup.changed) await addFiles([]);
    setAdding(false);
    setFailed([]);
    await revalidate();
  };

  return (
    <>
      <PagesView
        docs={docs}
        onNew={async () => navigate(pageUrl((await createPage())!))}
        project={setup.project ? { onAddFiles: () => setAdding(true), newFiles: setup.found.length, onSyncAll: () => void syncAll(), skipped, onCreate: (p) => void create(p) } : undefined}
      />
      {setup.project && open && (
        <SetupDialog
          found={setup.found} searchPaths={setup.searchPaths} capped={setup.capped} first={setup.needed} failed={failed}
          onAdd={(paths) => void add(paths)} onClose={setup.needed ? undefined : () => void close()}
        />
      )}
    </>
  );
}
