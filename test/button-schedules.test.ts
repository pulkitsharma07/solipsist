// Buttons on a schedule (`src/server/agent/schedules.ts`): the server presses a due button as the writer would, page
// open or not, and starts the page's agents if none are working. No real engine is reachable here (`test/sandbox.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyBlock, parseFile, serializeFile, type TaskRecord } from "../src/shared/docfile";
import { pressDueButtons } from "../src/server/suggest";
import { runSchedules } from "../src/server/agent/schedules";
import { pageAgents, stopAllPages } from "../src/server/agent/pageAgents";
import { projectDir } from "./project-dir";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const btn = (id: string, text: string) => `<!-- sel:${id}:btn "add the time" -->${text}<!-- /sel:${id}:btn -->`;
const rec = (every?: number, at = "2026-11-10T11:00:00.000Z"): TaskRecord => ({
  type: "sel", created_by: "writer", created: at, status: "button", finished: at, note: "Added the time.", suggestion: "old", saw: "old",
  button: { at, ...(every && { every, from: at }) },
});
const file = (body: string, tasks: Record<string, TaskRecord>, agent?: { on: boolean }) =>
  serializeFile(body, { ...emptyBlock(), tasks, ...(agent && { agent }) });

describe("pressing the buttons that are due", () => {
  test("a due one goes back to pending, its record pending with the result it held dropped; the body otherwise as it was", () => {
    const r = pressDueButtons(file(`Time: ${btn("aaa", "noon")}.\n\nOther ${btn("bbb", "x")}`, { aaa: rec(60_000), bbb: rec() }), NOW)!;
    expect(r.ids).toEqual(["aaa"]);
    const out = parseFile(r.file);
    expect(out.markdown).toBe(`Time: <!-- sel:aaa "add the time" -->noon<!-- /sel:aaa -->.\n\nOther ${btn("bbb", "x")}`);
    const a = out.block.tasks!.aaa!;
    expect(a).toMatchObject({ status: "pending", asked_again: 1, button: { every: 60_000 } });
    expect(a.suggestion).toBeUndefined();
    expect(out.block.meta.body_by).toBe("server");
  });
  test("not before its time, not without a schedule, not while its run or its card is under way", () => {
    expect(pressDueButtons(file(btn("aaa", "noon"), { aaa: rec(60_000, "2026-11-10T11:59:30.000Z") }), NOW)).toBeNull();
    expect(pressDueButtons(file(btn("aaa", "noon"), { aaa: rec() }), NOW)).toBeNull();
    expect(pressDueButtons(file('<!-- sel:aaa:ack "add the time" -->noon<!-- /sel:aaa:ack -->', { aaa: rec(60_000) }), NOW)).toBeNull();
    expect(pressDueButtons(file('<!-- sel:aaa:sug "add the time" -->noon<!-- /sel:aaa:sug -->', { aaa: rec(60_000) }), NOW)).toBeNull();
  });
});

describe("the server's schedule", () => {
  const project = projectDir("solip-schedules-");
  beforeAll(() => project.enter());
  afterAll(async () => { await stopAllPages("test over"); project.done(); });

  test("presses a due button on a page nobody has open, and starts that page's agents", async () => {
    writeFileSync(join(project.docs, "clock.md"), file(`Time: ${btn("aaa", "noon")}.`, { aaa: rec(60_000) }));
    writeFileSync(join(project.docs, "plain.md"), "Nothing scheduled here.\n");
    expect(pageAgents("clock")).toBeUndefined();
    expect(await runSchedules(NOW)).toEqual({ clock: ["aaa"] });
    expect(parseFile(readFileSync(join(project.docs, "clock.md"), "utf8")).markdown).toContain('<!-- sel:aaa "add the time" -->noon');
    expect(pageAgents("clock")).toBeDefined();
    // Pressed once: it waits for its run now.
    expect(await runSchedules(NOW)).toEqual({});
  });

  test("leaves alone a page whose agents the writer turned off", async () => {
    writeFileSync(join(project.docs, "off.md"), file(btn("ccc", "noon"), { ccc: rec(60_000) }, { on: false }));
    expect(await runSchedules(NOW)).toEqual({});
    expect(readFileSync(join(project.docs, "off.md"), "utf8")).toContain(":btn");
    expect(pageAgents("off")).toBeUndefined();
  });
});
