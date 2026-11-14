import { definePlugin } from "../../shared/plugin";

/** `<!-- gen:abc -->`: a spawn point: the agent decides what belongs there (text, a list, a table, an image). Mod-. (⌘. or Ctrl+.) at a caret. */
export default definePlugin({
  taskType: "gen",
  shape: "point",
  title: "Completion",
  keys: ["Mod-."],
  reviewText: "[complete]",
});
