// What keeps the server to the writer: each test here is an attack that used to work, against the real routes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseFile, serializeFile } from "../src/shared/docfile";
import { addFiles, syncPage } from "../src/server/project";
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

describe("Sync copies a page's images only from its own folder, to beside the page (S4)", () => {
  // The project sits in a folder of its own, so a link that climbs out of it lands somewhere the test can see.
  let outer = "";
  let proj = "";
  const put = (path: string, text: string) => { mkdirSync(dirname(join(proj, path)), { recursive: true }); writeFileSync(join(proj, path), text); };
  const link = async (id: string, href: string) => {
    const file = join(proj, ".solipsist/pages", `${id}.md`);
    const { markdown, block } = parseFile(readFileSync(file, "utf8"));
    const rev = block.meta.rev + 1;
    writeFileSync(file, serializeFile(`${markdown}\n\n![x](${href})\n`, { ...block, meta: { rev, body_rev: rev, body_by: "t_a" } }));
  };
  beforeAll(() => {
    outer = realpathSync(mkdtempSync(join(tmpdir(), "solip-s4-")));
    proj = join(outer, "proj");
    mkdirSync(proj);
    process.env.SOLIPSIST_PROJECT_ROOT = proj;
  });
  afterAll(() => {
    P.enter();
    rmSync(outer, { recursive: true, force: true });
  });

  test("a link with .. copies nothing out of the project", async () => {
    put("README.md", "# Readme\n");
    put(".zshrc", "planted");
    writeFileSync(join(outer, ".zshrc"), "mine");
    await addFiles(["README.md"]);
    // k = 3 climbs from the store to the project's own .zshrc, and from beside the page to the folder above it.
    await link("README", "images/README/../../../.zshrc");
    expect((await syncPage("README")).ok).toBe(true);
    expect(readFileSync(join(outer, ".zshrc"), "utf8")).toBe("mine");
    expect(existsSync(join(proj, "images"))).toBe(false);
  });

  test("a symlink in the image folder isn't followed", async () => {
    put("b.md", "# B\n");
    await addFiles(["b.md"]);
    writeFileSync(join(outer, "secret.txt"), "secret");
    mkdirSync(join(proj, ".solipsist/images/b"), { recursive: true });
    symlinkSync(join(outer, "secret.txt"), join(proj, ".solipsist/images/b/leak.png"));
    await link("b", "images/b/leak.png");
    expect((await syncPage("b")).ok).toBe(true);
    expect(existsSync(join(proj, "images/b/leak.png"))).toBe(false);
  });

  test("a symlink where the image would go isn't written through", async () => {
    put("c.md", "# C\n");
    await addFiles(["c.md"]);
    put(".solipsist/images/c/pic.png", "picture");
    writeFileSync(join(outer, "target.txt"), "untouched");
    mkdirSync(join(proj, "images/c"), { recursive: true });
    symlinkSync(join(outer, "target.txt"), join(proj, "images/c/pic.png"));
    await link("c", "images/c/pic.png");
    expect((await syncPage("c")).ok).toBe(true);
    expect(readFileSync(join(outer, "target.txt"), "utf8")).toBe("untouched");
  });

  test("an image of the page's own still reaches the repo", async () => {
    put("d.md", "# D\n");
    await addFiles(["d.md"]);
    put(".solipsist/images/d/sub/chart.svg", "<svg/>");
    await link("d", "images/d/sub/chart.svg");
    expect((await syncPage("d")).ok).toBe(true);
    expect(readFileSync(join(proj, "images/d/sub/chart.svg"), "utf8")).toBe("<svg/>");
  });
});

describe("a folder's .env can't pick a command for the server to run (S3)", () => {
  const was = { cmd: process.env.AGENT_CMD, env: process.env.NODE_ENV, cwd: process.cwd() };
  let dir = "";
  beforeAll(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "solip-s3-"))); });
  afterAll(() => {
    process.chdir(was.cwd);
    if (was.cmd === undefined) delete process.env.AGENT_CMD; else process.env.AGENT_CMD = was.cmd;
    process.env.NODE_ENV = was.env;
    rmSync(dir, { recursive: true, force: true });
  });

  test("outside a test AGENT_CMD is ignored, and the fake engine isn't offered", async () => {
    const { fakeCommand } = await import("../src/server/agent/engines/cmd");
    const { engines } = await import("../src/server/agent/engines");
    process.env.AGENT_CMD = JSON.stringify(["touch", join(dir, "ran")]);
    process.env.NODE_ENV = "production";
    expect(fakeCommand()).toBeUndefined();
    expect(engines().map((e) => e.name)).not.toContain("fake");
    process.env.NODE_ENV = "development";
    expect(fakeCommand()).toBeUndefined();
  });

  test("in a test it is read, unless a .env in the working directory names it or NODE_ENV", async () => {
    const { fakeCommand } = await import("../src/server/agent/engines/cmd");
    process.env.AGENT_CMD = '["sh"]';
    process.env.NODE_ENV = "test";
    process.chdir(dir);
    expect(fakeCommand()).toBe('["sh"]');
    for (const line of ["AGENT_CMD=[\"sh\"]", "export NODE_ENV=test"]) {
      writeFileSync(join(dir, ".env"), `PORT=1\n${line}\n`);
      expect(fakeCommand()).toBeUndefined();
    }
    rmSync(join(dir, ".env"));
    writeFileSync(join(dir, ".env.local"), "AGENT_CMD=x\n");
    expect(fakeCommand()).toBeUndefined();
  });
});

describe("an asset can't run on the app's origin (S10)", () => {
  test("an SVG holding a script is served sandboxed, with no scripts, loading nothing, not sniffed", async () => {
    mkdirSync(join(P.root, "images"), { recursive: true });
    writeFileSync(join(P.root, "images", "evil.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/config")</script></svg>`);
    const r = await call("/api/assets/images/evil.svg");
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("so does every other kind of asset", async () => {
    writeFileSync(join(P.root, "images", "a.png"), "png");
    const r = await call("/api/assets/images/a.png");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("nothing serves the project's folder but the asset route (S12)", () => {
  test("/public/.env isn't served", async () => {
    mkdirSync(join(P.root, "public"), { recursive: true });
    writeFileSync(join(P.root, "public", ".env"), "SECRET=sk-or-fake");
    expect(Object.keys(apiRoutes()).some((p) => p.startsWith("/public"))).toBe(false);
    expect(await (await call("/public/.env")).text()).not.toContain("sk-or-fake");
  });
});
