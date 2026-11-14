import { readFileSync } from "node:fs";
import { FORMAT, parseFile, serializeFile, type AgentSettings, type TaskAgent } from "../../shared/docfile";
import { readModifyWrite, withLock } from "../files";
import { asChoice, pageFile } from "./page";

/**
 * A page's agent settings: whether its agents are on, and the engine and model
 * they use. Kept in the page's file (`block.agent`), so they survive a reload and a restart, and every browser and the
 * terminal view read the same. The page's choice is a choice, not a promise: a model whose engine can't run now (a key
 * removed) is used as the default until it can.
 */
export interface PageSettings {
  on: boolean;
  /** The model the page's agents use now (`engine:model`): the page's choice if its engine can run, else the default. */
  model: string;
  /** What the file holds, as written (absent: the default). */
  saved: AgentSettings;
}

/** The page's settings as its file has them now. A page with no file, or none of these, has the defaults. */
export function readSettings(id: string): PageSettings {
  let saved: AgentSettings = {};
  let newer = false;
  try {
    const f = parseFile(readFileSync(pageFile(id), "utf8"));
    saved = f.block.agent ?? {};
    newer = f.format > FORMAT;
  } catch {}
  // A newer build's page is read-only here (`NewerPageError`): its agents are off, whatever it says, so nothing starts.
  return { on: !newer && saved.on !== false, model: asChoice(saved.model), saved };
}

const listeners = new Map<string, Set<(s: PageSettings) => void>>();
/** Calls `f` when the page's settings are changed through `writeSettings`; the returned function stops it. */
export function onSettings(id: string, f: (s: PageSettings) => void): () => void {
  const set = listeners.get(id) ?? new Set();
  listeners.set(id, set.add(f));
  return () => { set.delete(f); if (!set.size) listeners.delete(id); };
}

/**
 * Changes the page's settings: `on` (true removes the entry, since on is the default), `model` (a full
 * `engine:model` choice, which the caller has checked), `chat` (the page-wide chat's conversation; null forgets it)
 * and `solo` (the page's lasting agent in single-agent mode; null forgets it). Null when the page has no file. Tells
 * those listening.
 */
export async function writeSettings(id: string, patch: { on?: boolean; model?: string; chat?: TaskAgent | null; solo?: TaskAgent | null }): Promise<PageSettings | null> {
  const found = await withLock(id, () => readModifyWrite(id, (src) => {
    if (src === null) return { result: false };
    const { markdown, block } = parseFile(src);
    const next: AgentSettings = { ...block.agent };
    // On is the default, so turning on removes a `false`; a hand-written `true` (the opt-in to start unopened) stays.
    if (patch.on !== undefined) { if (!patch.on) next.on = false; else if (next.on === false) delete next.on; }
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.chat === null) delete next.chat;
    else if (patch.chat) next.chat = patch.chat;
    if (patch.solo === null) delete next.solo;
    else if (patch.solo) next.solo = patch.solo;
    const { agent: _old, ...rest } = block;
    const changed = JSON.stringify(next) !== JSON.stringify(block.agent ?? {});
    if (!changed) return { result: true };
    const file = serializeFile(markdown, { ...rest, meta: { ...block.meta, rev: block.meta.rev + 1 }, ...(Object.keys(next).length && { agent: next }) });
    return { file, result: true };
  }));
  if (!found) return null;
  const s = readSettings(id);
  for (const f of listeners.get(id) ?? []) f(s);
  return s;
}
