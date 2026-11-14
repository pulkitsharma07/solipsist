import { definePlugin } from "../../shared/plugin";

/** `<!-- sel:abc "instruction" -->text<!-- /sel:abc -->`: text the writer asks the agent about, or to act on. Mod-. on a selection. */
export default definePlugin({
  taskType: "sel",
  shape: "range",
  title: "Request",
  instruction: "optional",
  reusable: true,
  inputLabel: "Ask or tell the agent…",
  keys: ["Mod-."],
});
