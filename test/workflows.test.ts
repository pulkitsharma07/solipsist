// Rules the GitHub workflows (`.github/workflows/`) keep, read from their YAML: nothing here runs on GitHub, so this
// is what stops a rule from quietly going away.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const DIR = join(import.meta.dir, "..", ".github", "workflows");
type Step = { uses?: string; run?: string; with?: Record<string, unknown>; [k: string]: unknown };
type Job = { steps?: Step[]; uses?: string; [k: string]: unknown };
type Workflow = { jobs: Record<string, Job>; concurrency?: { group: string }; [k: string]: unknown };

const workflows = Object.fromEntries(
  readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, YAML.parse(readFileSync(join(DIR, f), "utf8")) as Workflow]),
);
const steps = function* () {
  for (const [file, wf] of Object.entries(workflows)) for (const [job, j] of Object.entries(wf.jobs)) for (const s of j.steps ?? []) yield { file, job, step: s };
};

test("every action is pinned to a full commit", () => {
  const loose = [...steps()].filter(({ step }) => step.uses && !step.uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(step.uses));
  expect(loose.map(({ file, step }) => `${file}: ${step.uses}`)).toEqual([]);
});

test("no checkout leaves its token in .git/config for the steps after it", () => {
  const kept = [...steps()].filter(({ step }) => step.uses?.startsWith("actions/checkout@") && step.with?.["persist-credentials"] !== false);
  expect(kept.map(({ file, job }) => `${file} (${job})`)).toEqual([]);
});

test("what a release ships is built without a restored cache, which any run on main can fill", () => {
  const release = workflows["release.yml"]!;
  const cached = Object.entries(release.jobs).filter(([, j]) => (j.steps ?? []).some((s) => s.uses?.startsWith("actions/cache@")));
  expect(cached.map(([name]) => name)).toEqual([]);
});

test("CI called by the release workflow can't cancel, or be cancelled by, a push's CI on the same ref", () => {
  const ci = workflows["ci.yml"]!;
  expect(ci.on).toHaveProperty("workflow_call");
  expect(ci.concurrency?.group).toContain("${{ github.workflow }}");
});

describe("the nightly fuzz's failure step", () => {
  const step = workflows["fuzz.yml"]!.jobs.fuzz!.steps!.find((s) => s.uses?.startsWith("actions/github-script@"))!;
  const script = String(step.with!.script);

  /** Runs the step's script as github-script would, on a fake GitHub holding `issues`; returns what it asked for. */
  async function failWith(issues: { number: number; title: string; pull_request?: object }[]) {
    const calls: { call: string; args: Record<string, unknown> }[] = [];
    const record = (call: string) => async (args: Record<string, unknown>) => { calls.push({ call, args }); return { data: {} }; };
    const listForRepo = async () => ({ data: issues });
    const github = {
      rest: { issues: { listForRepo, create: record("create"), createComment: record("createComment") } },
      paginate: async (fn: typeof listForRepo, args: Record<string, unknown>) => { calls.push({ call: "list", args }); return (await fn()).data; },
    };
    const context = { serverUrl: "https://github.com", repo: { owner: "o", repo: "r" }, runId: 7 };
    const fs = { readFileSync: () => "line\nseed 1234\n" };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("github", "context", "require", script)(github, context, (m: string) => (m === "fs" ? fs : undefined));
    return calls.filter((c) => c.call !== "list");
  }

  test("opens an issue, with the run and the log's tail, when none is open", async () => {
    const calls = await failWith([{ number: 3, title: "Something else" }, { number: 4, title: "Nightly fuzz failed (2026-01-01)", pull_request: {} }]);
    expect(calls.map((c) => c.call)).toEqual(["create"]);
    expect(calls[0]!.args.labels).toEqual(["bug"]);
    expect(String(calls[0]!.args.body)).toContain("https://github.com/o/r/actions/runs/7");
    expect(String(calls[0]!.args.body)).toContain("seed 1234");
  });

  test("comments on the open one instead of opening another", async () => {
    const calls = await failWith([{ number: 9, title: "Nightly fuzz failed (2026-11-01)" }]);
    expect(calls.map((c) => c.call)).toEqual(["createComment"]);
    expect(calls[0]!.args.issue_number).toBe(9);
    expect(String(calls[0]!.args.body)).toContain("seed 1234");
  });
});

test("the release smoke-tests each archive with scripts/smoke.sh: Linux x64 always, all five systems when switched on", () => {
  const smoke = workflows["release.yml"]!.jobs.smoke!;
  expect((smoke.steps ?? []).map((s) => s.run ?? "").join("\n")).toContain("bash scripts/smoke.sh");
  const include = String((smoke.strategy as { matrix: { include: string } }).matrix.include);
  expect(include).toContain("vars.SMOKE_ALL_SYSTEMS == 'true'");
  const [all, linuxOnly] = [...include.matchAll(/'(\[.*?\])'/g)].map((m) => JSON.parse(m[1]!) as { target: string; os: string }[]);
  expect(all!.map((e) => e.target)).toEqual(["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"]);
  expect(linuxOnly).toEqual([{ target: "linux-x64", os: "ubuntu-latest" }]);
});

test("the smoke script starts the binary in a folder with a planted .env and bunfig.toml preload, and fails if it reads either", () => {
  const script = readFileSync(join(import.meta.dir, "..", "scripts", "smoke.sh"), "utf8");
  expect(script).toContain("preload = [");
  expect(script).toContain("the binary ran the folder's bunfig.toml preload");
  expect(script).toContain("the binary read the folder's .env");
});

test("the release attests and uploads the install scripts with the archives and SHA256SUMS", () => {
  const publish = workflows["release.yml"]!.jobs.publish!.steps!;
  const attest = String(publish.find((s) => s.uses?.startsWith("actions/attest-build-provenance@"))!.with!["subject-path"]);
  const create = publish.map((s) => s.run ?? "").join("\n");
  for (const f of ["release/install.sh", "release/install.ps1", "release/SHA256SUMS"]) {
    expect(attest).toContain(f);
    expect(create).toContain(f);
  }
});
