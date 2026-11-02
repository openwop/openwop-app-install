/**
 * A best-effort boot step must be BOUNDED (bootBudget.ts). On 2026-09-21 the
 * showcase seed outran Cloud Run's 4-minute startup probe once the table it had
 * been failing on existed, and no instance could boot. The call site in
 * `index.ts` main() is only reachable as the process entry point, so the bound
 * is pinned here and the call site by a source check.
 *
 * Tracker TST-BEF-1 (w66). Red when: the budget timer stops firing at
 * `budgetMs` (fake clock advanced exactly 50 ms); a rejection is swallowed as
 * "unsettled"; `main()` awaits the seed without `withinBootBudget`.
 * Ceiling: the call-site cases are source checks, because `main()` runs only
 * as the process entry point and no test can reach it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { withinBootBudget } from '../src/host/bootBudget.js';

describe('withinBootBudget', () => {
  it('returns the value when the step settles inside the budget', async () => {
    await expect(withinBootBudget(Promise.resolve(7), 1_000)).resolves.toEqual({ settled: true, value: 7 });
  });

  it('returns unsettled at the budget when the step never finishes', async () => {
    vi.useFakeTimers();
    try {
      let out: { settled: boolean } | undefined;
      void withinBootBudget(new Promise<never>(() => {}), 50).then((v) => { out = v; });
      await vi.advanceTimersByTimeAsync(49);
      expect(out).toBeUndefined(); // not before the budget
      await vi.advanceTimersByTimeAsync(1);
      expect(out).toEqual({ settled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a rejection that lands inside the budget (the caller logs it)', async () => {
    await expect(withinBootBudget(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });
});

describe('index.ts main() bounds the showcase seed', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('never awaits seedShowcaseWorkforces directly', () => {
    expect(src).toMatch(/seedShowcaseWorkforces\(storage, Date\.now\(\)\)\.then\(/);
    expect(src).not.toMatch(/await\s+seedShowcaseWorkforces\(/);
  });

  it('awaits it only through withinBootBudget', () => {
    expect(src).toMatch(/await withinBootBudget\(seeding, budgetMs\)/);
  });
});
