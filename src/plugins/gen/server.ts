import { defineTaskTypeServer } from "../../server/taskTypes";
import instructions from "./prompt.md" with { type: "text" };

/** `gen`, on the server: its suggestion goes at the point. */
export default defineTaskTypeServer({
  taskType: "gen",
  instructions,
  modes: ["at"],
});
