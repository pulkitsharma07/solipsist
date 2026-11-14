import { asState, MarkerPoint } from "../../shared/docfile";
import { createLoader } from "./markers/loader";

/**
 * A point marker as the writer sees it: a loader that follows its state (waiting, acknowledged, done), drawn as
 * its plugin says. The same point keeps its element when only its surroundings change, and when its state changes it
 * moves on in place.
 */
export const PointWithLoader = MarkerPoint.extend({
  addNodeView() {
    return ({ node }) => {
      const loader = createLoader(node.attrs.taskType, node.attrs.id, asState(node.attrs.state));
      const dom = document.createElement("span");
      dom.className = "task-point";
      dom.contentEditable = "false";
      dom.dataset.ph = "point";
      dom.dataset.taskType = node.attrs.taskType;
      dom.dataset.id = node.attrs.id;
      dom.append(loader.el);
      return {
        dom,
        update: (next) => {
          if (next.type !== node.type || next.attrs.id !== node.attrs.id || next.attrs.taskType !== node.attrs.taskType) return false;
          loader.setState(asState(next.attrs.state), { live: true });
          return true;
        },
        ignoreMutation: () => true,
        stopEvent: (e) => loader.el.contains(e.target as Node),
        destroy: () => loader.destroy(),
      };
    };
  },
});
