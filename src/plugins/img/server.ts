import { defineTaskTypeServer } from "../../server/taskTypes";
import instructions from "./prompt.md" with { type: "text" };

/** `img`, on the server: a new image takes the old one's place. */
export default defineTaskTypeServer({
  taskType: "img",
  instructions,
  modes: ["replace"],
});
