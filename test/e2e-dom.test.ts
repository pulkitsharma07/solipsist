// The end-to-end suites in a fake DOM (`test/e2e-dom/`), run in a process of their own: other test files replace
// modules the app uses (`browser-tab.ts` mocks `client.ts`), and in bun that holds for the whole process.
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

const dir = `${import.meta.dir}/e2e-dom`;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".dom.tsx")).sort()) {
  test(`e2e in a fake DOM: ${f}`, async () => {
    const proc = Bun.spawn(["bun", "test", `./test/e2e-dom/${f}`], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    // bun prints its report on stderr: the failures (and their seed, for the fuzz) show here when there are any.
    expect(code, `${err}\n${out}`.split("\n").filter((l) => /\(fail\)|error:|Expected|Received|seed|timed out|Unhandled/.test(l)).join("\n")).toBe(0);
    expect(err).not.toMatch(/Unhandled error/);
  }, 180_000);
}
