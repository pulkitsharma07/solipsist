/**
 * The Pi mark, as Pi draws it (`pi-logo.js` in `@earendil-works/pi-coding-agent`): a 4×4 grid of square pixels in its
 * brand colours, fixed across themes. Each row's cells: c coral, b blue, y yellow, . empty.
 */
const PI_ROWS = ["ccc.", "b.c.", "bb.y", "b..y"];
const PI_COLOURS: Record<string, string> = { c: "#e48a7a", b: "#4f8eb3", y: "#eab65d" };

export const piPixels = PI_ROWS.flatMap((row, y) => [...row].flatMap((c, x) => (PI_COLOURS[c] ? [{ x, y, fill: PI_COLOURS[c]! }] : [])));

export const piLogo = (size = 16) =>
  `<svg class="pi-logo" viewBox="0 0 4 4" width="${size}" height="${size}" aria-hidden="true" shape-rendering="crispEdges">${piPixels.map((p) => `<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.fill}"/>`).join("")}</svg>`;
