/**
 * The check in front of every `/api` route (`routes.ts` wraps each handler in it, so none can be left out).
 *
 * The server has no login, and what it serves can start agents that run commands. So a request must come from the app
 * itself, on this machine:
 * - its `Host` is a loopback name on our port, or one the writer listed in `server.allowed_hosts`. A website that
 *   points its own name at 127.0.0.1 (DNS rebinding) is same-origin to the browser, but its `Host` gives it away.
 * - a browser's request from another site is refused, by `Sec-Fetch-Site` and by `Origin`, GETs too: some start agents.
 * - a request with a body says it is JSON. A website can send `text/plain` with no preflight; it can't send
 *   `application/json` to us without one, and the preflight is never answered.
 * `curl` and scripts send no `Origin` and no `Sec-Fetch-Site`, and still work.
 */
import { config } from "./config";

const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `name` and `port` of a `Host` header (`localhost:3000`, `[::1]:3000`); null when it doesn't parse. */
function parseHost(host: string): { name: string; port: string } | null {
  const m = /^(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::(\d+))?$/i.exec(host.trim());
  return m ? { name: m[1]!.toLowerCase(), port: m[2] ?? "" } : null;
}

/** Whether a request to `host` is to us: a loopback name on our port, or a name the writer allowed. */
export function hostAllowed(host: string, port: number | undefined, allowed: string[] = config().server.allowed_hosts): boolean {
  const h = parseHost(host);
  if (!h) return false;
  if (LOOPBACK_NAMES.has(h.name) && (port === undefined || h.port === String(port))) return true;
  return allowed.some((a) => {
    const want = a.trim().toLowerCase();
    return want === h.name || want === `${h.name}:${h.port}`;
  });
}

const BODILESS = new Set(["GET", "HEAD", "OPTIONS"]);
const hasBody = (req: Request) => !BODILESS.has(req.method) && ((Number(req.headers.get("content-length")) || 0) > 0 || req.headers.has("transfer-encoding"));

/** Why a request is refused (a response to send instead of the handler's), or null when it may go on. */
export function refuseRequest(req: Request, srv?: { port?: number }): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!hostAllowed(host, srv?.port)) {
    return fail(403, "bad_host", `This server answers only to localhost. To reach it as "${host}", add that name to server.allowed_hosts.`);
  }
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return fail(403, "cross_origin", "Requests from other sites are refused.");
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let ours = false;
    try {
      const u = new URL(origin);
      ours = (u.protocol === "http:" || u.protocol === "https:") && u.host.toLowerCase() === host.toLowerCase();
    } catch {}
    if (!ours) return fail(403, "cross_origin", "Requests from other sites are refused.");
  }
  if (hasBody(req) && !/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "")) {
    return fail(415, "bad_content_type", "A request body must be sent as application/json.");
  }
  return null;
}
