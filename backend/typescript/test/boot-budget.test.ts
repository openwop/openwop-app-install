/**
 * A best-effort boot step must be BOUNDED (bootBudget.ts). On 2026-09-21 the
 * showcase seed outran Cloud Run's 4-minute startup probe once the table it had
 * been failing on existed, and no instance could boot. The call site in
 * `index.ts` main() is only reachable as the process entry point, so the bound
 * is pinned here and the call site by a source check.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withinBootBudget } from '../src/host/bootBudget.js';

describe('withinBootBudget', () => {
  it('returns the value when the step settles inside the budget', async () => {
    await expect(withinBootBudget(Promise.resolve(7), 1_000)).resolves.toEqual({ settled: true, value: 7 });
  });

  it('returns unsettled at the budget when the step never finishes', async () => {
    const t0 = Date.now();
    const out = await withinBootBudget(new Promise<never>(() => {}), 50);
    expect(out).toEqual({ settled: false });
    expect(Date.now() - t0).toBeLessThan(1_000);
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
