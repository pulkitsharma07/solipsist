/**
 * Requests only this machine may make: whoever can change a prompt or the model's key steers agents that run commands.
 * The server sees the peer's address; a request from anywhere but loopback is refused.
 */
export type Peer = { requestIP(req: Request): { address: string } | null };
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const notLocal = (req: Request, srv?: Peer) =>
  LOOPBACK.has(srv?.requestIP(req)?.address ?? "")
    ? null
    : Response.json({ error: { code: "local_only", message: "Settings, keys and prompts can be read and changed only from the machine the server runs on." } }, { status: 403 });
