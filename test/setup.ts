// Runs before every test file (bunfig.toml). Everything it does is `sandbox.ts`, shared with the test helpers that run
// as a process of their own (`agent-server.ts`), so they can't reach the developer's settings, logins or keys either.
import "./sandbox";
