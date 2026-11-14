// The pictures for the states of a marker. Each is SVG that animates itself (SMIL), so none needs CSS to move.
const NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Element[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

const frame = (label: string, cls: string, ...kids: Element[]) =>
  el("svg", { viewBox: "0 0 24 24", width: "18", height: "18", role: "img", "aria-label": label, class: cls }, ...kids);

/** Waiting to be picked up: a dot that fades in and out, slowly. */
export function blinkingDot(): SVGSVGElement {
  return frame("Waiting", "gen-dot",
    el("circle", { cx: "12", cy: "12", r: "5", fill: "currentColor" },
      el("animate", { attributeName: "opacity", values: "0.2;1;0.2", dur: "2.4s", repeatCount: "indefinite", calcMode: "spline", keyTimes: "0;0.5;1", keySplines: "0.4 0 0.6 1;0.4 0 0.6 1" })));
}

/** Being worked on: a faint ring with an arc turning around it. */
export function spinner(): SVGSVGElement {
  return frame("Completing", "gen-spinner",
    el("circle", { cx: "12", cy: "12", r: "9", fill: "none", stroke: "currentColor", "stroke-opacity": "0.2", "stroke-width": "3" }),
    el("path", { d: "M12 3a9 9 0 0 1 9 9", fill: "none", stroke: "currentColor", "stroke-width": "3", "stroke-linecap": "round" },
      el("animateTransform", { attributeName: "transform", type: "rotate", from: "0 12 12", to: "360 12 12", dur: "0.8s", repeatCount: "indefinite" })));
}

export const nothing = (): Element => document.createElement("span");
