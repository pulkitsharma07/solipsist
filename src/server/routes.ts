import { agentStream, forgetOpenRouterKey, getModels, saveOpenRouterKey, setAgentModel, setButtonSchedule, stopAgents } from "./agent";
import { chatForget, chatSay, chatStop, chatStream } from "./chat";
import * as api from "./api";
import { events } from "./live";
import { presenceStream } from "./presence";
import { NewerPageError } from "./files";
import { refuseRequest } from "./guard";
import { devRoutesOn } from "./devMode";

type Handler = (req: any, srv: any) => unknown;
/**
 * Every handler is wrapped twice: first the request check (`guard.ts`: our host, our origin, JSON bodies), then a write
 * refused because the page is from a newer Solipsist (`NewerPageError`) becomes a 423 with why, from any route.
 */
// One wrapper per handler: a handler serving two routes is still one function.
const wrapped = new WeakMap<Handler, Handler>();
const refusingNewer = (h: Handler): Handler => {
  let w = wrapped.get(h);
  if (!w) {
    w = async (req, srv) => {
      const refused = refuseRequest(req, srv);
      if (refused) return refused;
      try {
        return await h(req, srv);
      } catch (e) {
        if (e instanceof NewerPageError) return Response.json({ error: { code: "newer_format", message: e.message }, format: e.format }, { status: 423 });
        throw e;
      }
    };
    wrapped.set(h, w);
  }
  return w;
};
const devOnly = <H extends (req: any, srv?: any) => Response | Promise<Response>>(h: H): H =>
  ((req: any, srv: any) => (devRoutesOn() ? h(req, srv) : Response.json({ error: { code: "not_found", message: "Dev only." } }, { status: 404 }))) as H;
const guard = <T,>(route: T): T =>
  (typeof route === "function" ? refusingNewer(route as Handler) : Object.fromEntries(Object.entries(route as object).map(([m, h]) => [m, refusingNewer(h)]))) as T;

/**
 * Every route of the server but the page itself (`index.ts` adds `/*`, the app's HTML). Kept apart so the end-to-end
 * tests in a fake DOM (`test/e2e-dom/`) serve the same API the app talks to, in-process.
 */
export function apiRoutes() {
  const routes = {
    "/api/pages": { GET: api.listPages, POST: api.createPage },
    "/api/pages/:id": { GET: api.getPage, PUT: api.putPage },
    "/api/setup": { GET: api.getSetup, POST: api.postSetup },
    "/api/pages/:id/sync": { GET: api.getSync, POST: api.postSync },
    "/api/pages/:id/reload": { POST: api.postReload },
    "/api/pages/:id/events": (req: any, srv: any) => events(req, srv),
    "/api/pages/:id/agent": { GET: (req: any, srv: any) => agentStream(req, srv), POST: setAgentModel },
    "/api/pages/:id/agent/stop": { POST: stopAgents },
    "/api/pages/:id/tasks/:task/schedule": { POST: setButtonSchedule },
    // One review of the page: questions in the margin, nothing written in the page (`review/`).
    "/api/pages/:id/review": { POST: api.startReview },
    // One chat channel (`chat/index.ts`): `:target` is a task's id or `page`.
    "/api/pages/:id/chat/:target": { GET: (req: any, srv: any) => chatStream(req, srv), POST: chatSay, DELETE: chatForget },
    "/api/pages/:id/chat/:target/stop": { POST: chatStop },
    "/api/agent/models": { GET: getModels },
    // Held open by every view of the app, so the terminal view knows someone is there (`presence.ts`).
    "/api/presence": { GET: (req: any, srv: any) => presenceStream(req, srv) },
    // The OpenRouter key pasted on a page (`keyStore.ts`). Local only.
    "/api/agent/key": { POST: saveOpenRouterKey, DELETE: forgetOpenRouterKey },
    "/api/support": { GET: api.getSupport, POST: api.postSupport },
    "/api/config": { GET: (req: any, srv: any) => api.getConfig(req, srv) },
    "/api/prompts": { GET: (req: any, srv: any) => api.getPrompts(req, srv) },
    "/api/prompts/:id": { PUT: (req: any, srv: any) => api.putPrompt(req, srv), DELETE: (req: any, srv: any) => api.resetPromptRoute(req, srv) },
    // For the tests and `bun run dev` only (`devOnly`): a 404 anywhere else, the released binary included.
    "/api/dev/changed/:id": { POST: devOnly(api.pageTouched) },
    "/api/dev/mock-comment/:id": { POST: devOnly(api.mockComment) },
    "/api/dev/comments/:id": { POST: devOnly(api.addComments) },
    "/api/assets/*": api.assetFile,
    "/api/*": api.notImplemented,
  } as const;
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => [path, guard(route)])) as typeof routes;
}
