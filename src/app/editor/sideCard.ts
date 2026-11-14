/**
 * The suggestion card, floating in the right margin beside its diff (everything a suggestion draws, `[data-sug]`): it
 * shows while the pointer is on the diff or on the card, and stays while the card is pinned (a click on the diff, the
 * keys). However large the diff, the card stays in view beside it as the page scrolls (`stickyTop`). One per editor.
 */
export interface SideCard {
  /** Shows `content` for suggestion `id` beside its diff (replacing what was shown). */
  show(id: string, content: HTMLElement): void;
  hide(): void;
  /** Places it again, after the page changed under it. */
  place(): void;
  readonly id: string | null;
  /** Whether `node` is in the card. */
  contains(node: Node | null): boolean;
  destroy(): void;
}

const GAP = 16;
const EDGE = 8;

/**
 * Where the card's top goes, in viewport pixels: level with the diff's top, then, as the page scrolls the diff up,
 * held at the top of the visible area, whole, while any of the diff shows. `diff` is the diff's extent, `h` the card's height, `visible` the part of the viewport not under the bars.
 * Null when none of the diff is visible.
 */
export function stickyTop(diff: { top: number; bottom: number }, h: number, visible: { top: number; bottom: number }): number | null {
  if (diff.bottom <= visible.top || diff.top >= visible.bottom) return null;
  let y = Math.max(diff.top, visible.top);
  y = Math.max(Math.min(y, diff.bottom - h), diff.top); // not past the diff's bottom, unless the diff is shorter
  return Math.max(visible.top, Math.min(y, visible.bottom - h));
}

/** The extent of everything suggestion `id` draws in `root`, in viewport pixels (null: nothing drawn). */
export function diffExtent(root: HTMLElement, id: string): { top: number; bottom: number } | null {
  let top = Infinity, bottom = -Infinity;
  for (const el of root.querySelectorAll<HTMLElement>(`[data-sug="${id}"]`)) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  return top <= bottom ? { top, bottom } : null;
}

/** The part of the viewport not under the page's sticky toolbar and fixed status bar. */
function visibleArea() {
  const bar = document.querySelector(".toolbar")?.getBoundingClientRect();
  const status = document.querySelector(".statusbar")?.getBoundingClientRect();
  return { top: Math.max(0, bar?.bottom ?? 0) + EDGE, bottom: Math.min(window.innerHeight, status?.top || window.innerHeight) - EDGE };
}

export function sideCard(root: HTMLElement): SideCard {
  const box = document.createElement("div");
  box.className = "sug-side";
  box.setAttribute("role", "dialog");
  // The thin line from the card to the end of its diff's first line (as a question's popover has to its passage).
  const NS = "http://www.w3.org/2000/svg";
  const link = document.createElementNS(NS, "svg");
  link.setAttribute("class", "sug-link");
  link.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("r", "3.5");
  link.append(path, dot);
  const drawLink = (left: number, y: number) => {
    const cy = y + 18;
    // The part of the diff level with the card (or nearest to it), so a tall diff is joined where the card is.
    let hit: DOMRect | null = null, best = Infinity;
    for (const el of id ? root.querySelectorAll<HTMLElement>(`[data-sug="${id}"]`) : []) {
      for (const r of el.getClientRects()) {
        if (!r.width && !r.height) continue;
        const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        if (d < best) { best = d; hit = r; }
      }
    }
    if (!hit || hit.right + 10 >= left) { link.remove(); return; } // the card is over the page: nothing to join
    const x = hit.right + 2, ty = Math.min(Math.max(cy, hit.top + 4), Math.max(hit.top + 4, hit.bottom - 4)), mx = (x + left) / 2;
    path.setAttribute("d", `M${left} ${cy} C${mx} ${cy}, ${mx} ${ty}, ${x} ${ty}`);
    dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(ty));
    if (!link.isConnected) document.body.append(link);
  };
  let id: string | null = null;

  /** The agent's notes share this margin: one the card would cut across steps aside until the card has gone. */
  const coverNotes = (card: DOMRect | null) => {
    for (const note of document.querySelectorAll<HTMLElement>(".agent-note")) {
      const r = note.getBoundingClientRect();
      note.toggleAttribute("data-covered", !!card && r.left < card.right && card.left < r.right && r.top < card.bottom && card.top < r.bottom);
    }
  };

  const place = () => {
    if (!id) return;
    if (!box.isConnected) document.body.append(box);
    const diff = diffExtent(root, id);
    const y = diff && stickyTop(diff, box.offsetHeight, visibleArea());
    if (y === null || y === undefined) { box.style.visibility = "hidden"; link.remove(); coverNotes(null); return; }
    // Right of the page, in its margin; on a screen too narrow for that, over the page's right edge.
    const sheet = (root.closest(".sheet") ?? root).getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(sheet.right + GAP, window.innerWidth - box.offsetWidth - EDGE));
    box.style.visibility = "";
    box.style.left = `${left}px`;
    box.style.top = `${y}px`;
    drawLink(left, y);
    coverNotes(box.getBoundingClientRect());
  };
  // Following the scroll from a handler: the card is fixed, so it doesn't move with the page by itself.
  const onScroll = () => place();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);

  return {
    get id() { return id; },
    show(next, content) {
      id = next;
      box.replaceChildren(content);
      box.dataset.for = next;
      box.dataset.kind = content.dataset.kind ?? "";
      document.body.append(box);
      place();
    },
    hide() {
      id = null;
      box.remove();
      link.remove();
      coverNotes(null);
    },
    place,
    contains: (node) => !!node && box.contains(node),
    destroy() {
      id = null;
      box.remove();
      link.remove();
      coverNotes(null);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    },
  };
}
