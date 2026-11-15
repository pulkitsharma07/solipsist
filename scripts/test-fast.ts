// `bun run test:fast`: the unit tests that finish in seconds, for the pre-commit hook (.githooks/pre-commit). Every
// test file runs except the slow ones below, so a new test is fast until it's listed here. `bun test` (and CI) still
// runs everything. Times are each file alone, measured 2026-11-14; the rest take about 20 s together.
import { Glob } from "bun";

const SLOW = new Set([
  "e2e-dom.test.ts", // 83 s: the real app in happy-dom, every suite
  "agent.test.ts", // 13 s
  "fuzz.test.ts", // 12 s
  "robustness.test.ts", // 10 s
  "session.test.ts", // 9 s
  "typecheck.test.ts", // 7 s
  "agent-contract.test.ts", // 7 s
  "persisting-agents.test.ts", // 6 s
  "project.test.ts", // 5 s
  "agent-leftovers.test.ts", // 5 s
  "lock.test.ts", // 8 s: two real servers on one folder
  "install-sh.test.ts", // 6 s: the real script, seven times
  "page-chat.test.ts", // 4 s
  "suggestion-ui.test.ts", // 4 s
  "plugins.test.ts", // 3 s
  "pi-engine.test.ts", // 3 s
]);

// Run in a process of their own: in one process with the rest they break others or are broken by them (a fake DOM
// left behind makes a later file read `Mod` as Ctrl, so its Cmd+. does nothing). `bun test`'s own order is fine.
const ALONE = new Set(["agent-feed.test.tsx", "model-picker.test.tsx", "settings-dialog.test.tsx"]);

const all = [...new Glob("*.test.{ts,tsx}").scanSync("test")].sort();
const gone = [...SLOW, ...ALONE].filter((f) => !all.includes(f));
if (gone.length) console.warn(`test-fast: listed but gone: ${gone.join(", ")}`);

const together = all.filter((f) => !SLOW.has(f) && !ALONE.has(f));
const runs = [together, ...[...ALONE].filter((f) => all.includes(f)).map((f) => [f])];
let code = 0;
for (const files of runs) {
  const run = Bun.spawnSync(["bun", "test", ...files.map((f) => `./test/${f}`)], { stdio: ["inherit", "inherit", "inherit"] });
  code ||= run.exitCode ?? 1;
}
process.exit(code);
