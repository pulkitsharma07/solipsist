import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { config } from "../src/server/config";

// config() is loadConfig on the real environment, cached until the environment changes.
test("config() sees a variable set before the call and one changed after", () => {
  const had = { settle: process.env.AGENT_SETTLE_MS };
  try {
    delete process.env.AGENT_SETTLE_MS;
    expect(config().agent.settle_ms).toBe(2000);
    process.env.AGENT_SETTLE_MS = "50";
    expect(config().agent.settle_ms).toBe(50);
    expect(config()).toBe(config()); // cached while nothing changes
    process.env.AGENT_SETTLE_MS = "soon";
    expect(() => config()).toThrow(/AGENT_SETTLE_MS/);
  } finally {
    if (had.settle === undefined) delete process.env.AGENT_SETTLE_MS; else process.env.AGENT_SETTLE_MS = had.settle;
  }
});
