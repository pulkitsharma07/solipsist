import { useState } from "react";
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
  const { revalidate } = useRevalidator();
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);

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
  const open = setup.needed || adding;

  return (
    <>
      <PagesView
        docs={docs}
        onNew={async () => navigate(pageUrl((await createPage())!))}
        project={setup.project ? { onAddFiles: () => setAdding(true), onSyncAll: () => void syncAll(), skipped, onCreate: (p) => void create(p) } : undefined}
      />
      {setup.project && open && (
        <SetupDialog
          found={setup.found} searchPaths={setup.searchPaths} capped={setup.capped} first={setup.needed} failed={failed}
          onAdd={(paths) => void add(paths)} onClose={setup.needed ? undefined : () => setAdding(false)}
        />
      )}
    </>
  );
}
