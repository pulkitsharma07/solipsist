// The app's own server with Pi as its only engine, on the scripted model of `pi-script.ts`, for `pi.e2e.ts`.
// First: no key, login or Pi of the developer's, even when started by hand (`test/sandbox.ts`).
import "../sandbox";
import { setEngines } from "../../src/server/agent/engines";
import { scriptedPi } from "./pi-script";

setEngines([await scriptedPi(process.env.E2E_ROOT!, process.env.PI_CODING_AGENT_DIR!)]);

await import("../../src/index.ts");
