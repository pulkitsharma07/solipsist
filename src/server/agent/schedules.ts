import { listPages, readPage, readModifyWrite, withLock } from "../files";
import { log, why } from "../log";
import { pressDueButtons } from "../suggest";
import { PageAgents, pageAgents } from "./pageAgents";
import { readSettings } from "./settings";

/**
 * Buttons on a schedule (`button.every`), run by the server, so they keep running with the
 * page closed. Every `LOOK_MS` it looks at each page: a button whose time has come is pressed as the writer would press it
 * (`pressDueButtons`: back to pending), and the page's agents are started if none are working, as a tab's stream starts
 * them. They stop on their own once nothing is left. A page whose agents the writer turned off is left alone, and the
 * cost limits hold as for any run.
 *
 * Decided by the writer (2026-11-10): this runs on any engine, Pi included, though its commands aren't confined
 * (`AgentEngine.confined`): a scheduled run can do what the writer can, with nobody watching.
 */
export const LOOK_MS = 15_000;

/** Presses every button that is due, on every page. Returns what it pressed, by page. */
export async function runSchedules(now = new Date()): Promise<Record<string, string[]>> {
  const pressed: Record<string, string[]> = {};
  for (const { id } of await listPages().catch(() => [])) {
    const src = await readPage(id).catch(() => null);
    // Most pages have no schedule: not worth parsing.
    if (!src?.includes('"every"')) continue;
    const settings = readSettings(id);
    if (!settings.on) continue;
    const ids = await withLock(id, () => readModifyWrite(id, (s) => {
      const r = s === null ? null : pressDueButtons(s, now);
      return { file: r?.file, result: r?.ids ?? [] };
    }));
    if (!ids.length) continue;
    pressed[id] = ids;
    log("button.timed", { page: id, tasks: ids });
    const page = pageAgents(id);
    if (page) page.nudge();
    else new PageAgents(id, settings.model).start();
  }
  return pressed;
}

/** Looks every `ms` until the returned function is called. */
export function startSchedules(ms = LOOK_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    runSchedules().catch((e) => log("server.error", { kind: "schedules", message: why(e) })).finally(() => { busy = false; });
  }, ms);
  return () => clearInterval(timer);
}
