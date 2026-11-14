// The loaded settings, as the settings dialog shows them: the list from what the server loaded, the tab, and the endpoint behind it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as api from "../src/server/api";
import { configView, loadConfig } from "../src/server/config";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const dir = mkdtempSync(join(tmpdir(), "solip-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const view = () => configView(loadConfig({ cwd: dir, home: dir, env: { AGENT_CONCURRENCY: "2", SOLIPSIST_OPENROUTER_KEY: "sk-or-v1-SECRETSECRETSECRET" } }));

test("the list shows each setting by section, with its value and where it came from", async () => {
  const { SettingsList } = await import("../src/app/pages/SettingsPane");
  const html = renderToStaticMarkup(<SettingsList config={view()} />);
  expect(html).toContain("No config file");
  expect(html).toContain('<section aria-label="agent">');
  expect(html).toMatch(/<dt>agent\.concurrency<\/dt><dd><span>2<\/span><\/dd><span class="source"[^>]*>AGENT_CONCURRENCY<\/span>/);
  expect(html).toMatch(/<dt>agent\.max_runs<\/dt><dd><span>6<\/span><\/dd><span class="source"[^>]*>default<\/span>/);
  expect(html).toContain("setting src-env");
  expect(html).toMatch(/<dt>agent\.cost_limit_usd<\/dt><dd><span class="unset">unset<\/span>/);
  expect(html).toContain("<span>read</span><span>grep</span>"); // a list has a line per item
});

test("a secret shows only as set, and the filter narrows the list", async () => {
  const { SettingsList } = await import("../src/app/pages/SettingsPane");
  const html = renderToStaticMarkup(<SettingsList config={view()} />);
  expect(html).toContain('<span class="secret">set</span>');
  expect(html).not.toContain("SECRETSECRET");
  const some = renderToStaticMarkup(<SettingsList config={view()} filter="concurr" />);
  expect(some).toContain("agent.concurrency");
  expect(some).not.toContain("agent.max_runs");
  expect(renderToStaticMarkup(<SettingsList config={view()} filter="zzz" />)).toContain("No setting matches");
});

test("GET /api/config returns the settings in effect and never a key", async () => {
  process.env.SOLIPSIST_PROJECT_ROOT = dir;
  const savedKey = process.env.SOLIPSIST_OPENROUTER_KEY;
  process.env.SOLIPSIST_OPENROUTER_KEY = "sk-or-v1-SECRETSECRETSECRET";
  try {
    const res = await api.getConfig(new Request("http://x/api/config"), { requestIP: () => ({ address: "127.0.0.1" }) });
    expect((await api.getConfig(new Request("http://x/api/config"), { requestIP: () => ({ address: "10.0.0.5" }) })).status).toBe(403);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("SECRETSECRET");
    const body = JSON.parse(text);
    const key = body.settings.find((s: any) => s.key === "pi.openrouter_key");
    expect(key).toMatchObject({ value: ["set"], source: "env:SOLIPSIST_OPENROUTER_KEY", secret: true });
    expect(body.settings.find((s: any) => s.key === "server.port")).toMatchObject({ value: ["3000"], source: expect.stringMatching(/default|env:PORT/) });
  } finally {
    if (savedKey === undefined) delete process.env.SOLIPSIST_OPENROUTER_KEY; else process.env.SOLIPSIST_OPENROUTER_KEY = savedKey;
  }
});
