import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * A browser for the generator: the app's modules (ProseMirror, the editor's widgets) need a DOM when they load, so one
 * is registered first, and the modules are imported after (`load`). Left registered while the page is built; `done`
 * puts the process back as it was (tests share it with others that register their own).
 */
let registered = false;
export function register() {
  if (typeof document !== "undefined" && !registered) return false; // someone else's DOM: use it, leave it alone
  // A Mac's user agent: the pictures name keys in a Mac's words (src/app/keys.ts), whatever machine builds them.
  if (!registered) { GlobalRegistrator.register({ width: 1100, height: 800, settings: { navigator: { userAgent: "Mozilla/5.0 (Macintosh)" } } as any }); registered = true; }
  return true;
}
export async function done() {
  if (registered) { await GlobalRegistrator.unregister(); registered = false; }
}
