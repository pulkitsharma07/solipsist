// Key hints name the key that works on the writer's keyboard: ⌘ and ⌥ on a Mac, Ctrl and Alt elsewhere.
import { expect, test } from "bun:test";
import { keyLabel } from "../src/app/keys";

test("a Mac's keys: its symbols, modifiers in ⌃⌥⇧⌘ order, no separator", () => {
  expect(keyLabel("Mod-.", true)).toBe("⌘.");
  expect(keyLabel("Mod-Alt-y", true)).toBe("⌥⌘Y");
  expect(keyLabel("Alt-Mod-]", true)).toBe("⌥⌘]");
  expect(keyLabel("Shift-↵", true)).toBe("⇧↵");
  expect(keyLabel("Ctrl-Shift-Mod-k", true)).toBe("⌃⇧⌘K");
});

test("Linux and Windows: Mod is Ctrl, words joined by +", () => {
  expect(keyLabel("Mod-.", false)).toBe("Ctrl+.");
  expect(keyLabel("Mod-Alt-y", false)).toBe("Ctrl+Alt+Y");
  expect(keyLabel("Mod-Alt-]", false)).toBe("Ctrl+Alt+]");
  expect(keyLabel("Shift-↵", false)).toBe("Shift+↵");
  expect(keyLabel("Escape", false)).toBe("Escape");
});

test("a key ending in a dash is the dash, and an unknown modifier is an error", () => {
  expect(keyLabel("Mod--", false)).toBe("Ctrl+-");
  expect(() => keyLabel("Hyper-x", false)).toThrow("unknown modifier");
});
