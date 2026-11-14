import type { ReactNode } from "react";
import { Link } from "react-router";
import { SettingsButton } from "./SettingsDialog";

/** How the page's file stands: what the top bar says, and its class (the colour of the dot). */
export type SaveState = "saved" | "dirty" | "saving" | "error" | "readonly";
const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", error: "Can't save, retrying…", readonly: "Read-only" };

/**
 * The bar across the top of a page: back to all pages, the page's title, whether it is saved, Sync, and the settings gear.
 */
export function TopBar({ title, save, actions }: { title: string; save: SaveState; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <Link to="/" className="back" aria-label="All pages">←</Link>
      <span className="doc-title">{title}</span>
      <span className={`save ${save}`}>{SAVE_LABEL[save]}</span>
      {actions}
      <SettingsButton />
    </header>
  );
}

/**
 * What can be wrong with the page, in strips under the top bar: it is open in another tab, the connection is lost,
 * or the file was changed elsewhere while the writer typed.
 */
export function Banners({ conn, conflict, onReload, onKeepMine }: {
  conn: "live" | "offline" | "refused" | string;
  conflict: boolean;
  onReload(): void;
  onKeepMine(): void;
}) {
  return (
    <>
      {conn === "refused" && (
        <div className="banner error">This page is open in another tab. Close that tab, then <button onClick={() => location.reload()}>try again</button>.</div>
      )}
      {conn === "offline" && <div className="banner error">Connection lost. Reconnecting…</div>}
      {conflict && (
        <div className="banner warn">
          This page was changed elsewhere.
          <button onClick={onReload}>Reload</button>
          <button onClick={onKeepMine}>Keep mine</button>
        </div>
      )}
    </>
  );
}

/**
 * The strip that asks for support once the writer has used Solipsist for a while (`src/server/support.ts`). It never
 * blocks anything: the page works the same whether they buy, put it off or close it.
 */
export function SupportNudge({ days, url, onLater, onPaid }: { days: number; url: string; onLater(): void; onPaid(): void }) {
  return (
    <div className="banner support" role="note">
      <span>You've written in Solipsist on {days} days. If it's useful to you, please buy a licence: it keeps it going.</span>
      <a href={url} target="_blank" rel="noreferrer">Buy a licence</a>
      <button onClick={onPaid}>I've bought one</button>
      <button onClick={onLater}>Later</button>
    </div>
  );
}
