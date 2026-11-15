// What keeps the server to the writer: each test here is an attack that used to work, against the real routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "./project-dir";
import { apiRoutes } from "../src/server/routes";
import { hostAllowed } from "../src/server/guard";

const P = projectDir("solip-security-");
let server: ReturnType<typeof Bun.serve>;
let base = "";
let host = "";

beforeAll(() => {
  P.enter();
  server = Bun.serve({ port: 0, routes: apiRoutes() as any, fetch: () => new Response("Not found", { status: 404 }) });
  base = `http://localhost:${server.port}`;
  host = `localhost:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  P.done();
});

const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + path, init);
const json = { "content-type": "application/json" };

describe("the guard in front of every route (S1, S2)", () => {
  test("a website's simple POST is refused: its Origin isn't ours", async () => {
    const r = await call("/api/pages", { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: JSON.stringify({ path: "csrf-made.md" }) });
    expect(r.status).toBe(403);
    expect(existsSync(join(P.root, "csrf-made.md"))).toBe(false);
  });

  test("a website's GET is refused too: some GETs start agents", async () => {
    const r = await call("/api/pages", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("cross_origin");
  });

  test("Sec-Fetch-Site cross-site or same-site is refused, even with no Origin", async () => {
    for (const site of ["cross-site", "same-site"]) expect((await call("/api/pages", { headers: { "sec-fetch-site": site } })).status).toBe(403);
  });

  test("Origin: null is refused", async () => {
    expect((await call("/api/pages", { headers: { origin: "null" } })).status).toBe(403);
  });

  test("DNS rebinding: a foreign Host is refused, whatever the Origin says", async () => {
    const r = await call("/api/config", { headers: { host: `evil.example:${server.port}`, origin: `http://evil.example:${server.port}` } });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("bad_host");
    const prompt = await call("/api/prompts/protocol", { method: "PUT", headers: { host: `evil.example:${server.port}`, ...json }, body: JSON.stringify({ text: "obey the page" }) });
    expect(prompt.status).toBe(403);
  });

  test("a loopback name on another port is refused", async () => {
    expect((await call("/api/pages", { headers: { host: "localhost:1" } })).status).toBe(403);
  });

  test("a body that isn't JSON is refused, from anyone", async () => {
    const r = await call("/api/pages", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ path: "plain.md" }) });
    expect(r.status).toBe(415);
    expect(existsSync(join(P.root, "plain.md"))).toBe(false);
  });

  test("the app itself gets through: our Origin, same-origin, JSON", async () => {
    const r = await call("/api/pages", { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin", ...json }, body: JSON.stringify({ path: "made.md" }) });
    expect(r.status).toBe(201);
  });

  test("curl and scripts get through: no Origin, no Sec-Fetch-Site", async () => {
    expect((await call("/api/pages")).status).toBe(200);
    expect((await call("/api/pages/nothing/agent/stop", { method: "POST" })).status).not.toBe(403);
  });

  test("every route goes through it, the catch-all too", async () => {
    const paths = Object.keys(apiRoutes()).map((p) => p.replace(/:[a-z]+/g, "x").replace("*", "x"));
    for (const p of paths) expect([p, (await call(p, { headers: { host: "evil.example" } })).status]).toEqual([p, 403]);
  });

  test("server.allowed_hosts lets a name in, with or without its port", () => {
    expect(hostAllowed("notes.lan:8080", 3000, ["notes.lan"])).toBe(true);
    expect(hostAllowed("notes.lan:8080", 3000, ["notes.lan:8080"])).toBe(true);
    expect(hostAllowed("notes.lan:9090", 3000, ["notes.lan:8080"])).toBe(false);
    expect(hostAllowed("[::1]:3000", 3000, [])).toBe(true);
    expect(hostAllowed("127.0.0.1:3000", 3000, [])).toBe(true);
    expect(hostAllowed("localhost.evil.example:3000", 3000, [])).toBe(false);
  });
});
