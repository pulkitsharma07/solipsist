import { defineTaskTypeServer } from "../../server/taskTypes";
import instructions from "./prompt.md" with { type: "text" };

/** `sel`, on the server: a new version of the text, or an answer or addition after it. */
export default defineTaskTypeServer({
  taskType: "sel",
  instructions,
  modes: ["replace", "after"],
});
