/**
 * The save and sync states of one tab's page, as a pure function: `step(state, event)` gives the next state
 * and what to do about it. No editor and no timers here: `DocSession` computes the inputs (merges, diffs), feeds the
 * events in, and carries out the effects. The connection, typing pauses and the fresh-text flash are not part of it.
 */

export type Save = "saved" | "dirty" | "saving" | "error";

/**
 * What stops the page from saving. `conflict`: someone else changed the body and it can't be merged with the writer's
 * edits (the banner: Reload or Keep mine).
 */
export type Hold = { kind: "none" } | { kind: "conflict" };

export interface SessionState {
  save: Save;
  /** A save request is out, between sending it and its reply. */
  sending: boolean;
  /** The last save sent and not answered: the edit count and body it carried. The server may already hold it. */
  awaiting: { version: number; body: string } | null;
  hold: Hold;
  /** Failed saves since the last answered one: picks the retry delay. */
  retries: number;
  /** +1 per edit by the writer, and whenever the writer's edits are discarded. */
  version: number;
}

export const initialState: SessionState = { save: "saved", sending: false, awaiting: null, hold: { kind: "none" }, retries: 0, version: 0 };

/** How a body from someone else is taken in: as it is (nothing unsaved), or merged. */
export type Via = "take" | "merge";
export const receiveVia = (s: SessionState): Via => (s.save === "saved" ? "take" : "merge");
export type Event =
  | { type: "edit" }
  /** Comments the file calls open can't be found in the page: a save reports them. */
  | { type: "lost" }
  /** `force` saves even when nothing changed. */
  | { type: "save"; force: boolean }
  /** The request was built with this body. */
  | { type: "sent"; body: string }
  | { type: "saveOk" }
  | { type: "save409" }
  /** The request failed, or the server refused it without a file. */
  | { type: "saveFailed" }
  /** `merged`: their body with the writer's edits kept (their body itself for `take`), null when they clash. `same`: it equals theirs. */
  | { type: "fileReceived"; via: "take" | "merge"; theirs: string; bodyRev: number; merged: string | null; same: boolean }
  | { type: "keepMine" }
  | { type: "reload" };

export type Effect =
  /** Replace any planned save with one after a delay: `typing` (debounced, with a maximum wait), `soon`, or a retry. */
  | { type: "scheduleSave"; after: "typing" | "soon" | { retry: number } }
  | { type: "sendPut" }
  /** Show `merged` in the page and make `theirs` the agreed body. */
  | { type: "adopt"; merged: string; theirs: string; bodyRev: number };

/** `ok: false`: the event can't happen in this state (a bug in the caller); nothing changes. */
export type Step = { ok: true; state: SessionState; effects: Effect[] } | { ok: false; reason: string };

/** Why a state can't exist, or null when it can. */
export function invalid(s: SessionState): string | null {
  if (s.save === "saving" && !s.sending) return "saving with no request out";
  return null;
}

export function step(s: SessionState, e: Event): Step {
  const bad = invalid(s);
  if (bad) return { ok: false, reason: `invalid state: ${bad}` };
  const no = (reason: string): Step => ({ ok: false, reason });
  const to = (patch: Partial<SessionState>, ...effects: Effect[]): Step => ({ ok: true, state: { ...s, ...patch }, effects });
  // The writer's edits kept on top of their body: unsaved unless the result is their body.
  const merged = (same: boolean): Partial<SessionState> => ({ save: same ? "saved" : "dirty" });
  const saveIfNeeded = (same: boolean): Effect[] => (same ? [] : [{ type: "scheduleSave", after: "soon" }]);

  switch (e.type) {
    case "edit":
      // In a conflict the edits wait for the writer's choice; until then they are not saved.
      if (s.hold.kind === "conflict") return to({ version: s.version + 1 });
      return to({ version: s.version + 1, save: "dirty" }, { type: "scheduleSave", after: "typing" });

    case "lost":
      if (s.hold.kind === "conflict" || s.save !== "saved") return to({}); // the next save reports them anyway
      return to({ save: "dirty" }, { type: "scheduleSave", after: "soon" });

    case "save":
      if (s.sending || s.hold.kind !== "none" || (s.save === "saved" && !e.force)) return to({});
      return to({ save: "saving", sending: true }, { type: "sendPut" });

    case "sent":
      return to({ awaiting: { version: s.version, body: e.body } });

    case "saveFailed":
      if (!s.sending) return no("a failed save with no request out");
      return to({ sending: false, save: "error", retries: s.retries + 1 }, { type: "scheduleSave", after: { retry: s.retries } });

    case "saveOk": {
      if (!s.awaiting) return no("a save reply with no save sent");
      const unchanged = s.awaiting.version === s.version;
      return to({ sending: false, retries: 0, awaiting: null, save: unchanged ? "saved" : "dirty" }, ...saveIfNeeded(unchanged));
    }

    case "save409":
      // Someone else wrote the body: the file in the reply arrives next, and we are dirty, so it merges or holds.
      if (!s.awaiting) return no("a save reply with no save sent");
      return to({ sending: false, retries: 0, awaiting: null, save: "dirty" });

    case "fileReceived": {
      const via = receiveVia(s);
      if (e.via !== via) return no(`a file taken in by ${e.via}, but this state takes it in by ${via}`);
      if (e.merged === null) {
        if (e.via === "take") return no("their body itself can't clash");
        return to({ hold: { kind: "conflict" } });
      }
      const adopt: Effect = { type: "adopt", merged: e.merged, theirs: e.theirs, bodyRev: e.bodyRev };
      // A body that merges ends any hold: it builds on what the writer has, so nothing is left to decide.
      if (e.via === "take") return to({ hold: { kind: "none" } }, adopt);
      return to({ hold: { kind: "none" }, ...merged(e.same) }, adopt, ...saveIfNeeded(e.same));
    }

    case "keepMine":
      if (s.hold.kind !== "conflict") return no("no conflict to resolve");
      return to({ hold: { kind: "none" }, save: "dirty" });

    case "reload":
      // A save still out is answered later as a stale one: its version no longer matches, so the page stays as loaded.
      return to({ hold: { kind: "none" }, save: "saved", version: s.version + 1 });
  }
}
