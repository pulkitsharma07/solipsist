// Rules the GitHub workflows (`.github/workflows/`) keep, read from their YAML: nothing here runs on GitHub, so this
// is what stops a rule from quietly going away.
import { expect, test } from "bun:test";
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
