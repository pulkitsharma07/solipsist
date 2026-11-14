// The chat modal on its own in a browser, against the fake agent (`agent.ts`): `bun test/chat-harness/server.ts` (PORT,
// default 3990; `SPEED=0.2` streams five times faster). `test/e2e/chat.e2e.ts` drives it.
// First: no key, login or Pi of the developer's (`test/sandbox.ts`), though this harness has no real engine to reach.
import "../sandbox";
import { serve } from "bun";
import { chatRoutes } from "./agent";
import page from "./index.html";

const server = serve({
  port: Number(process.env.PORT ?? 3990),
  routes: { ...chatRoutes(Number(process.env.SPEED ?? 1)), "/*": page } as any,
  development: { hmr: false, console: true },
});
console.log(`Chat harness on ${server.url}`);
