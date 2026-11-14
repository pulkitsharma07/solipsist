// The contract every agent engine keeps, as a suite any engine can be put through.
//
// `AgentEngine` says what an engine must offer, but what each part *means* was only ever asserted engine by engine, so
// a new one (Codex, a configured `exec` command, a hosted agent) had to discover each rule by running into it. This
// file is that rule set, once: an engine's own test file calls `describeEngine` with a fixture that starts it on a
// scripted model, and the rules are checked against it.
//
// What is here is the engine API itself: the declarations an engine makes about itself, the shape of a run, cost
// honesty, and what a session promises about its conversation and its close. What is *not* here is the write guard —
// proving that an agent cannot write the page needs tool calls only that engine's script can make, so it stays in each
// engine's own file (`pi-engine.test.ts`, `cmd-engine.test.ts`). It belongs here once a `WritePolicy` is passed in
// `StartOptions` and enforced the same way by every engine (plan item P1-2), and this comment is the marker for that.
import { expect, test } from "bun:test";
import type { AgentEngine, AgentSession } from "../src/server/agent/engine";
import { engineOffers } from "../src/server/agent/engines";

export interface EngineFixture {
  /** The engine under test, set up so it can run: its key faked, its model scripted, its config in a scratch folder. */
  engine: AgentEngine;
  /** Starts one agent on a scratch page, scripted to answer at least one run. The suite closes what this returns. */
  start(): Promise<AgentSession>;
  /** What the fixture's script makes the one run reply, when it is worth asserting. */
  says?: string;
  /** Removes the fixture's scratch folders and anything it started. */
  done?(): void | Promise<void>;
}

/**
 * Runs the engine contract against `make`'s fixture. A fresh fixture per test, so one test's agent can't affect
 * another's, and each closes what it started.
 */
export function describeEngine(label: string, make: () => Promise<EngineFixture> | EngineFixture) {
  /** A fixture for one test, with its cleanup. */
  const using = async <T>(f: (fx: EngineFixture) => Promise<T>): Promise<T> => {
    const fx = await make();
    try {
      return await f(fx);
    } finally {
      await fx.done?.();
    }
  };

  test(`${label}: it says what it reports and whether it confines what it runs`, async () => {
    const { engine } = await make();
    expect(engine.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(engine.title.length).toBeGreaterThan(0);
    // Both are optional in the type, so an engine that forgets them is read as unmetered and unconfined — which is the
    // safe default but a silent one. The contract is that an engine states each, so neither is a default by accident.
    expect(typeof engine.reportsCost).toBe("boolean");
    expect(typeof engine.confined).toBe("boolean");
  });

  test(`${label}: its first model is one it offers, and it can run now`, async () => {
    const { engine } = await make();
    await engine.warm?.();
    const models = engine.models();
    expect(models.length).toBeGreaterThan(0);
    const first = models[0]!;
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.title.length).toBeGreaterThan(0);
    // The strict check, the one `POST …/agent` uses when the writer picks: its own first model must pass it.
    expect(engineOffers(engine, first.id)).toBe(true);
    if (engine.knows) expect(engine.knows(first.id)).toBe(true);
    expect(engine.unavailable()).toBeNull();
  });

  test(`${label}: a run gives a result, and a cost when it says it reports one`, async () => {
    await using(async (fx) => {
      const agent = await fx.start();
      try {
        const res = await agent.run("Do the task.");
        expect(typeof res.ok).toBe("boolean");
        expect(typeof res.result).toBe("string");
        if (fx.says !== undefined) expect(res.result).toContain(fx.says);
        expect(res.ok).toBe(true);
        // The whole point of `reportsCost`: the dollar limits can only bound an engine whose runs carry a figure.
        // One that claims to report and doesn't would pass every limit untouched (`agent/budget.ts`).
        if (fx.engine.reportsCost) {
          expect(typeof res.costUsd).toBe("number");
          expect(Number.isFinite(res.costUsd)).toBe(true);
          expect(res.costUsd).toBeGreaterThanOrEqual(0);
        }
      } finally {
        await agent.close();
      }
    });
  });

  test(`${label}: it keeps a conversation the chat can show, or keeps none at all`, async () => {
    await using(async (fx) => {
      const agent = await fx.start();
      try {
        if (agent.sessionId !== undefined) {
          // It outlives `close()`, so the id must be something `resume` can be given back.
          expect(agent.sessionId.length).toBeGreaterThan(0);
          expect(typeof agent.resumed).toBe("boolean");
        }
        // `chats` is what the page shows a chat button for: such an agent must have a conversation to show.
        if (fx.engine.chats) {
          expect(typeof agent.history).toBe("function");
          await agent.run("Do the task.");
          expect(agent.history!().length).toBeGreaterThan(0);
        }
      } finally {
        await agent.close();
      }
    });
  });

  test(`${label}: closing is safe twice, and dying is reported rather than thrown`, async () => {
    await using(async (fx) => {
      const agent = await fx.start();
      // `died` is only ever read with `.then` beside a run, so a rejection would be an unhandled one.
      let rejected: unknown;
      agent.died.then(undefined, (e) => { rejected = e; });
      await agent.close();
      await agent.close();
      await Promise.resolve();
      expect(rejected).toBeUndefined();
    });
  });
}
