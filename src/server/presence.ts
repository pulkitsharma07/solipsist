/**
 * Whether anyone has the app open: every view of it (the file picker, the pages list, a page) holds one stream here
 * (`GET /api/presence`, opened by `frontend.tsx`). The terminal view (`tui.ts`) shows the full dashboard only while
 * there is at least one, and otherwise says plainly which address to open.
 */
interface Presence { open: number }
// On globalThis so a `bun --hot` reload keeps the count of the streams still open.
const presence: Presence = ((globalThis as any).__solipPresence ??= { open: 0 } as Presence);

/** How many browser windows have the app open now. */
export const viewers = () => presence.open;

export function presenceStream(req: Request, server?: { timeout(r: Request, s: number): void }) {
  server?.timeout(req, 0);
  const enc = new TextEncoder();
  let ping: Timer | undefined;
  let counted = false;
  const leave = () => { if (counted) { counted = false; presence.open = Math.max(0, presence.open - 1); } if (ping) clearInterval(ping); };
  const stream = new ReadableStream({
    start(c) {
      presence.open++;
      counted = true;
      const send = (s: string) => { try { c.enqueue(enc.encode(s)); } catch { leave(); } };
      send("retry: 2000\n\n");
      ping = setInterval(() => send(": ping\n\n"), 15_000);
      req.signal.addEventListener("abort", () => { leave(); try { c.close(); } catch {} });
    },
    cancel: leave,
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } });
}
