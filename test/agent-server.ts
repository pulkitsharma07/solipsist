// A bare server for `agent-leftovers.test.ts`: opens the agent stream of the page named on the command line and reads
// it until it is killed. It runs in the project it is started in; `AGENT_CMD` comes from the environment.
// First, before anything reads a setting: no key, login or Pi of the developer's, even when started by hand.
import "./sandbox";

// Its only agent is the stand-in the test gives it: without one it would have none, or a real one. Checked before the
// agent code is loaded (a static import would load all of it, Pi too, first): refusing takes no time.
if (!process.env.AGENT_CMD) {
  console.error("agent-server.ts runs only under agent-leftovers.test.ts, which gives it AGENT_CMD (a fake agent). Run: bun test test/agent-leftovers.test.ts");
  process.exit(1);
}
const { agentStream } = await import("../src/server/agent");

const id = process.argv[2]!;
const res = agentStream(Object.assign(new Request("http://x/"), { params: { id } }), { timeout() {} });
const reader = res.body!.getReader();
for (;;) {
  const r = await reader.read();
  if (r.done) break;
  process.stdout.write(r.value);
}
