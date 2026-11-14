import { definePlugin } from "../../shared/plugin";

/**
 * `<!-- img:abc "instruction" -->![alt](images/x.svg)<!-- /img:abc -->`: an image the writer wants drawn again, with
 * what to change. Mod-. on a selection that holds nothing but an image (vim: `v` or `V` on its line, where the page
 * shows the hint over it).
 */
export default definePlugin({
  taskType: "img",
  shape: "range",
  subject: "image",
  title: "Image",
  instruction: "required", // an image is only redrawn for a reason: the writer says what to change
  inputLabel: "Change this image…",
  keys: ["Mod-."],
  phases: {
    pending: { label: "Waiting to be drawn again" },
    ack: { label: "Being drawn again" },
  },
});
