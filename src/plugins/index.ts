import { registerPlugin } from "../shared/plugin";
import gen from "./gen";
import img from "./img";
import sel from "./sel";

/**
 * The built-in task type plugins, registered on import. To add one: a folder `<taskType>/` with an `index.ts` (see
 * `src/shared/plugin.ts`), the agent's instructions for it in `prompt.md`, its server half in `server.ts` (see
 * `src/server/taskTypes.ts`), and a line here and in `./server.ts`. The browser imports this file: never import a
 * `server.ts` from it.
 */
export const BUILTIN_PLUGINS = [gen, sel, img];
for (const p of BUILTIN_PLUGINS) registerPlugin(p);
