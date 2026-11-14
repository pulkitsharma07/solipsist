import { registerTaskTypeServer } from "../server/taskTypes";
import "./index"; // their browser halves: a server half counts only for a registered task type
import gen from "./gen/server";
import img from "./img/server";
import sel from "./sel/server";

/**
 * The built-in task types' server halves (`src/server/taskTypes.ts`), registered on import, with their browser halves.
 * Server only: the browser imports `./index`, never this. A new built-in task type adds a `server.ts` and a line here.
 */
export const BUILTIN_SERVERS = [gen, sel, img];
for (const s of BUILTIN_SERVERS) registerTaskTypeServer(s);
