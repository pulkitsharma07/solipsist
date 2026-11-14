// One floating panel at a time, anchored under an element, closed by a click elsewhere or Escape.
export interface OpenPopup {
  close(): void;
}

/** What a popup sits under: an element, or anything that says where it is (the selection, say). */
export type PopupAnchor = Pick<HTMLElement, "getBoundingClientRect" | "contains" | "isConnected">;

let current: OpenPopup | null = null;

export function openPopup(anchor: PopupAnchor, content: HTMLElement, onClose: () => void = () => {}): OpenPopup {
  current?.close();
  const box = document.createElement("div");
  box.className = "task-popup";
  box.setAttribute("role", "dialog");
  box.append(content);
  document.body.append(box);

  // Placed once, in page coordinates, so it scrolls with the page by itself. (Following the anchor from a scroll
  // handler runs a frame behind the scrolling and the panel wobbles against the page.)
  const place = () => {
    if (!anchor.isConnected) return handle.close();
    const a = anchor.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(8, Math.min(a.left - 12, window.innerWidth - w - 8));
    const below = a.bottom + 8;
    const top = below + h > window.innerHeight - 8 && a.top - h - 8 > 8 ? a.top - h - 8 : below;
    box.style.left = `${left + window.scrollX}px`;
    box.style.top = `${top + window.scrollY}px`;
  };
  const away = (e: Event) => { if (!box.contains(e.target as Node) && !anchor.contains(e.target as Node)) handle.close(); };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") handle.close(); };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("resize", place);

  const handle: OpenPopup = {
    close() {
      if (current === handle) current = null;
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", place);
      box.remove();
      onClose();
    },
  };
  current = handle;
  place();
  return handle;
}
