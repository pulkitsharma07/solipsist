// A bare server for `agent-leftovers.test.ts`: opens the agent stream of the page named on the command line and reads
// it until it is killed. It runs in the project it is started in; `AGENT_CMD` comes from the environment.
// First, before anything reads a setting: no key, login or Pi of the developer's, even when started by hand.
import "./sandbox";
import { agentStream } from "../src/server/agent";

// Its only agent is the stand-in the test gives it: without one it would have none, or a real one.
if (!process.env.AGENT_CMD) {
  console.error("agent-server.ts runs only under agent-leftovers.test.ts, which gives it AGENT_CMD (a fake agent). Run: bun test test/agent-leftovers.test.ts");
  process.exit(1);
}

const id = process.argv[2]!;
const res = agentStream(Object.assign(new Request("http://x/"), { params: { id } }), { timeout() {} });
const reader = res.body!.getReader();
for (;;) {
  const r = await reader.read();
  if (r.done) break;
  process.stdout.write(r.value);
}
