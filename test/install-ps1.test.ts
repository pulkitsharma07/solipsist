// install.ps1 run by PowerShell (`pwsh`), where there is one: GitHub's Linux runners have it, a Mac usually doesn't,
// and then these are skipped. The script is for Windows: on Linux it gets as far as the download and the checksum,
// served here from a local server, which is what these look at.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pwsh = Bun.which("pwsh");
const script = join(import.meta.dir, "..", "scripts", "install.ps1");
let root: string;
let files: Record<string, Uint8Array> = {};
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "install-ps1-"));
  if (!pwsh) return;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const body = files[new URL(req.url).pathname.slice(1)];
      return body ? new Response(body) : new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** Runs install.ps1 as `irm … | iex` would, in a session that then prints its own preferences; returns what it said. */
function install(env: Record<string, string>) {
  const scriptText = readFileSync(script, "utf8");
  const scriptFile = join(root, "script.txt");
  writeFileSync(scriptFile, scriptText);
  const command = [
    `$ErrorActionPreference = 'Continue'; $ProgressPreference = 'Continue'`,
    `try { Invoke-Expression (Get-Content -Raw '${scriptFile}') } catch { Write-Output "THROWN: $($_.Exception.Message)" }`,
    `Write-Output "AFTER: $ErrorActionPreference $ProgressPreference"`,
  ].join("; ");
  const r = Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, LOCALAPPDATA: join(root, "appdata"), SOLIPSIST_BASE_URL: `http://127.0.0.1:${server!.port}`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString() + r.stderr.toString();
}

test.skipIf(!pwsh)("a failed download throws, and leaves the shell's own preferences as they were", () => {
  files = {};
  const out = install({ SOLIPSIST_INSTALL_DIR: join(root, "none") });
  expect(out).toContain("THROWN: solipsist install: could not download");
  expect(out).toContain("AFTER: Continue Continue");
}, 60_000);

test.skipIf(!pwsh)("a checksum that doesn't match throws, and nothing is installed", () => {
  const stage = join(root, "stage", "solipsist-0.0.0-windows-x64");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "solipsist.exe"), "not really\n");
  Bun.spawnSync(["zip", "-qr", join(root, "w.zip"), "solipsist-0.0.0-windows-x64"], { cwd: join(root, "stage") });
  files = { "solipsist-windows-x64.zip": readFileSync(join(root, "w.zip")), SHA256SUMS: new TextEncoder().encode(`${"0".repeat(64)}  solipsist-windows-x64.zip\n`) };
  const dir = join(root, "bad");
  const out = install({ SOLIPSIST_INSTALL_DIR: dir });
  expect(out).toContain("THROWN: solipsist install: checksum mismatch");
  expect(out).toContain("AFTER: Continue Continue");
  expect(Bun.file(join(dir, "solipsist.exe")).size).toBe(0);
}, 60_000);
