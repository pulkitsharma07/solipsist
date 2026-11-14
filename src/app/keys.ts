/**
 * Key hints in the writer's own keyboard's words. A binding is written once, in Tiptap's notation (`Mod-Alt-y`), and
 * `Mod` is ⌘ on a Mac and Ctrl elsewhere — so a hint that says ⌥⌘Y is wrong on Linux and Windows, where the key that
 * works is Ctrl+Alt+Y.
 */

/** Whether the keys are a Mac's: the test ProseMirror's keymap makes, so a hint names the key that works. */
export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

const MAC: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const OTHER: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Super" };
/** The order each platform writes its modifiers in: ⌃⌥⇧⌘ on a Mac, Ctrl+Alt+Shift elsewhere. */
const ORDER = ["ctrl", "alt", "shift", "meta"];

/** A key as a hint shows it: `Mod-Alt-y` is `⌥⌘Y` on a Mac and `Ctrl+Alt+Y` elsewhere; `Mod-.` is `⌘.` or `Ctrl+.`. */
export function keyLabel(key: string, mac = isMac()): string {
  const parts = key.split(/-(?!$)/);
  const last = parts.pop()!;
  const mods = new Set(parts.map((p) => {
    const m = p.toLowerCase();
    if (m === "mod") return mac ? "meta" : "ctrl";
    if (m === "cmd") return "meta";
    if (m === "control") return "ctrl";
    return m;
  }));
  for (const m of mods) if (!ORDER.includes(m)) throw new Error(`keyLabel: unknown modifier in ${key}`);
  const name = last.length === 1 ? last.toUpperCase() : last;
  const held = ORDER.filter((m) => mods.has(m));
  return mac ? held.map((m) => MAC[m]).join("") + name : [...held.map((m) => OTHER[m]), name].join("+");
}
