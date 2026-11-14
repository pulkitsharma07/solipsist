// Greedy shrinking: drop items while the failure persists, biggest chunks first. The result still fails, and removing
// any single item from it makes it pass.

/** Shrinks `items` to a smaller list for which `fails` is still true. `fails(items)` must be true to start with. */
export function shrink<T>(items: T[], fails: (items: T[]) => boolean): T[] {
  let cur = items;
  for (let chunk = Math.max(1, Math.floor(cur.length / 2)); chunk >= 1; chunk = Math.floor(chunk / 2)) {
    for (let i = 0; i + chunk <= cur.length; ) {
      const next = [...cur.slice(0, i), ...cur.slice(i + chunk)];
      if (next.length < cur.length && safely(fails, next)) cur = next;
      else i += chunk;
    }
  }
  return cur;
}

/** A shrink candidate that throws a different error still counts as failing: it is still a bug. */
function safely<T>(fails: (items: T[]) => boolean, items: T[]) {
  try { return fails(items); } catch { return true; }
}

/** Runs count: `FUZZ_RUNS` scales every property test (`FUZZ_RUNS=10000 bun test test/fuzz.test.ts`). */
export const runs = (byDefault: number) => {
  const n = Number(process.env.FUZZ_RUNS);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round((n / 200) * byDefault)) : byDefault;
};
