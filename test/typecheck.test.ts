// The editor tests run in a fake DOM and never render the page's React components, so a wrong prop or a missing name
// in one of them (a panel using a variable its parent never passed) only showed up in the browser. The compiler sees it.
import { expect, test } from "bun:test";

test("the whole project type-checks", async () => {
  const proc = Bun.spawn(["bun", "--bun", "node_modules/typescript/bin/tsc", "--noEmit"], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(out.trim()).toBe(""); // shows the errors when there are any
  expect(await proc.exited).toBe(0);
}, 60_000);
