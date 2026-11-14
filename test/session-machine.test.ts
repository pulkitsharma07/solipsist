// The session's save and sync states (`src/app/doc/sessionMachine.ts`): every state × every event.
// The table below is the spec: each row says, for one event, what the next state is and what happens. A change to the
// machine that isn't also made here fails.
import { describe, expect, test } from "bun:test";
import {
  invalid, receiveVia, step, type Effect, type Event, type Hold, type Save, type SessionState,
} from "../src/app/doc/sessionMachine";

const HOLDS: Record<string, Hold> = {
  none: { kind: "none" },
  conflict: { kind: "conflict" },
};
/** Every combination of the state's parts, valid or not. */
function allStates(): SessionState[] {
  const out: SessionState[] = [];
  for (const save of ["saved", "dirty", "saving", "error"] as Save[])
    for (const sending of [false, true])
      for (const awaiting of [null, { version: 5, body: "sent" }, { version: 4, body: "sent" }])
        for (const hold of Object.values(HOLDS))
          for (const retries of [0, 2]) out.push({ save, sending, awaiting, hold, retries, version: 5 });
  return out;
}

const fileEvents = (): Event[] => [
  ...(["take", "merge"] as const).flatMap((via) => [
    { type: "fileReceived" as const, via, theirs: "T", bodyRev: 9, merged: null, same: false },
    { type: "fileReceived" as const, via, theirs: "T", bodyRev: 9, merged: "M", same: false },
    { type: "fileReceived" as const, via, theirs: "T", bodyRev: 9, merged: "T", same: true },
  ]),
];
const EVENTS: Event[] = [
  { type: "edit" }, { type: "lost" }, { type: "save", force: false }, { type: "save", force: true }, { type: "sent", body: "B" },
  { type: "saveOk" }, { type: "save409" }, { type: "saveFailed" }, ...fileEvents(),
  { type: "keepMine" }, { type: "reload" },
];

type Expected = { reject: string } | { patch: Partial<SessionState>; effects?: Effect[] };
const soon: Effect = { type: "scheduleSave", after: "soon" };
const none: Hold = { kind: "none" };

/** The spec, row by row. */
function expected(s: SessionState, e: Event): Expected {
  const keptAfterMerge = (same: boolean): Partial<SessionState> => ({ hold: none, save: same ? "saved" : "dirty" });
  switch (e.type) {
    case "edit":
      return s.hold.kind === "conflict"
        ? { patch: { version: 6 } }
        : { patch: { version: 6, save: "dirty" }, effects: [{ type: "scheduleSave", after: "typing" }] };
    case "lost":
      return s.hold.kind !== "conflict" && s.save === "saved" ? { patch: { save: "dirty" }, effects: [soon] } : { patch: {} };
    case "save":
      if (s.sending || s.hold.kind !== "none" || (s.save === "saved" && !e.force)) return { patch: {} };
      return { patch: { save: "saving", sending: true }, effects: [{ type: "sendPut" }] };
    case "sent":
      return { patch: { awaiting: { version: 5, body: "B" } } };
    case "saveFailed":
      return s.sending ? { patch: { sending: false, save: "error", retries: s.retries + 1 }, effects: [{ type: "scheduleSave", after: { retry: s.retries } }] } : { reject: "no request out" };
    case "saveOk":
      if (!s.awaiting) return { reject: "no save sent" };
      return s.awaiting.version === 5
        ? { patch: { sending: false, retries: 0, awaiting: null, save: "saved" } }
        : { patch: { sending: false, retries: 0, awaiting: null, save: "dirty" }, effects: [soon] };
    case "save409":
      return s.awaiting ? { patch: { sending: false, retries: 0, awaiting: null, save: "dirty" } } : { reject: "no save sent" };
    case "fileReceived": {
      const via = s.save === "saved" ? "take" : "merge";
      if (e.via !== via) return { reject: "wrong way in" };
      if (e.merged === null) return e.via === "take" ? { reject: "their own body clashing" } : { patch: { hold: { kind: "conflict" } } };
      const adopt: Effect = { type: "adopt", merged: e.merged, theirs: "T", bodyRev: 9 };
      if (e.via === "take") return { patch: { hold: none }, effects: [adopt] };
      return { patch: keptAfterMerge(e.same), effects: e.same ? [adopt] : [adopt, soon] };
    }
    case "keepMine":
      return s.hold.kind === "conflict" ? { patch: { hold: none, save: "dirty" } } : { reject: "no conflict" };
    case "reload":
      return { patch: { hold: none, save: "saved", version: 6 } };
  }
}

const label = (s: SessionState, e: Event) => `${JSON.stringify({ ...s, hold: s.hold.kind })} ${JSON.stringify(e)}`;

describe("every state × event", () => {
  let pairs = 0;
  const states = allStates().filter((s) => !invalid(s));
  test(`${states.length} states`, () => {
    for (const s of states) {
      for (const e of EVENTS) {
        pairs++;
        const got = step(s, e);
        const want = expected(s, e);
        const at = label(s, e);
        if ("reject" in want) {
          expect({ at, ok: got.ok }).toEqual({ at, ok: false });
          continue;
        }
        if (!got.ok) throw new Error(`rejected (${got.reason}): ${at}`);
        expect({ at, state: got.state, effects: got.effects }).toEqual({ at, state: { ...s, ...want.patch }, effects: want.effects ?? [] });
        // Whatever happens, the next state is one that can exist.
        expect({ at, invalid: invalid(got.state) }).toEqual({ at, invalid: null });
      }
    }
  });
  test("the table covered every pair", () => expect(pairs).toBe(states.length * EVENTS.length));
});

describe("a state that can't exist is refused, whatever the event", () => {
  const saving: SessionState = { save: "saving", sending: false, awaiting: null, hold: none, retries: 0, version: 0 };
  test("saving with no request out", () => {
    for (const e of EVENTS) expect(step(saving, e)).toEqual({ ok: false, reason: "invalid state: saving with no request out" });
  });
});

describe("stories", () => {
  const run = (s: SessionState, ...events: Event[]) => {
    const effects: Effect[][] = [];
    for (const e of events) {
      const r = step(s, e);
      if (!r.ok) throw new Error(r.reason);
      s = r.state;
      effects.push(r.effects);
    }
    return { s, effects };
  };
  const start: SessionState = { save: "saved", sending: false, awaiting: null, hold: none, retries: 0, version: 0 };

  test("type, save, type again before the reply: the reply leaves the page unsaved and plans another save", () => {
    const { s, effects } = run(start, { type: "edit" }, { type: "save", force: false }, { type: "sent", body: "a" }, { type: "edit" }, { type: "saveOk" });
    expect(s).toMatchObject({ save: "dirty", sending: false, awaiting: null });
    expect(effects.at(-1)).toEqual([soon]);
  });

  test("a failing save retries with growing delays, and the first answered save resets them", () => {
    let { s, effects } = run(start, { type: "edit" }, { type: "save", force: false }, { type: "sent", body: "a" }, { type: "saveFailed" }, { type: "save", force: false }, { type: "saveFailed" });
    expect(effects.filter((x) => x.length && x[0]!.type === "scheduleSave" && typeof (x[0] as { after: unknown }).after === "object")).toEqual([
      [{ type: "scheduleSave", after: { retry: 0 } }], [{ type: "scheduleSave", after: { retry: 1 } }],
    ]);
    expect(s.awaiting).toEqual({ version: 1, body: "a" }); // the server may have stored it: a later merge can build on it
    ({ s } = run(s, { type: "save", force: false }, { type: "sent", body: "a" }, { type: "saveOk" }));
    expect(s).toMatchObject({ save: "saved", retries: 0 });
  });

  test("a clashing file holds saves until Keep mine; typing meanwhile is kept and saved with it", () => {
    const { s, effects } = run(start, { type: "edit" }, { type: "fileReceived", via: "merge", theirs: "T", bodyRev: 2, merged: null, same: false }, { type: "edit" }, { type: "save", force: false });
    expect(s.hold.kind).toBe("conflict");
    expect(effects.at(-2)).toEqual([]); // no save planned while in conflict
    expect(effects.at(-1)).toEqual([]); // nor sent
    const after = run(s, { type: "keepMine" }, { type: "save", force: false });
    expect(after.effects.at(-1)).toEqual([{ type: "sendPut" }]);
  });

  test("a later body that merges ends the conflict", () => {
    const { s } = run(start, { type: "edit" }, { type: "fileReceived", via: "merge", theirs: "T", bodyRev: 2, merged: null, same: false }, { type: "fileReceived", via: "merge", theirs: "U", bodyRev: 3, merged: "M", same: false });
    expect(s).toMatchObject({ hold: none, save: "dirty" });
  });

  test("a file arriving with nothing unsaved is taken; with typing, merged", () => {
    expect(receiveVia(start)).toBe("take");
    expect(receiveVia({ ...start, save: "dirty" })).toBe("merge");
    expect(receiveVia({ ...start, save: "saving", sending: true })).toBe("merge"); // a save out counts as unsaved
  });

  test("reload while a save is out: its late reply is stale, and the page is saved again", () => {
    const { s, effects } = run(start, { type: "edit" }, { type: "save", force: false }, { type: "sent", body: "a" }, { type: "reload" }, { type: "saveOk" });
    expect(s.save).toBe("dirty");
    expect(effects.at(-1)).toEqual([soon]);
  });
});
