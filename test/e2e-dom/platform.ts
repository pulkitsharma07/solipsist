// The suites play a Mac (happy-dom is registered with a Macintosh user agent, so `pressKey` sends ⌘ for `Mod`). The
// editor's keymap decides what `Mod` means once, when ProseMirror loads, from `navigator.platform` — and a suite loads
// it before happy-dom is registered, so it reads Bun's own navigator: a Mac on a Mac, Linux on CI, where ⌘-. then did
// nothing. Pinned here, every suite's first import, so the keymap and the keys agree on any machine.
Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true });
