/**
 * ADR 0118 Phase 2 / Phase 5 — usage rollup (`features/usage-analytics/usageRollupService.ts`).
 *
 * What turns each case red (wave-24 probes): resetting `calls` or reversing the
 * total-token sort (accumulates); dropping the negative clamp or the `'unknown'`
 * provider/model defaults (clamps); reading the store without the `${tenantId}:` prefix
 * (tenant isolation — the case seeds its OWN rows, so it does not depend on order);
 * mapping an unpriced model to `costUsd: 0` (UA-G1, cost).
 *
 * Every case uses its own tenant, so the file passes alone and shuffled.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordUsage, getUsageRollup, getUsageRollupWithCost } from '../src/features/usage-analytics/usageRollupService.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('usage rollup', () => {
  it('accumulates tokens + calls per (provider, model)', async () => {
    const T = 'usage-accum';
    await recordUsage(T, { provider: 'anthropic', model: 'opus', inputTokens: 100, outputTokens: 50, at: 't1' });
    await recordUsage(T, { provider: 'anthropic', model: 'opus', inputTokens: 20, outputTokens: 10, at: 't2' });
    await recordUsage(T, { provider: 'openai', model: 'gpt', inputTokens: 5, outputTokens: 5, at: 't3' });
    const rollup = await getUsageRollup(T);
    expect(rollup.map((r) => r.model)).toEqual(['opus', 'gpt']); // ranked by total tokens
    expect(rollup[0]).toMatchObject({ provider: 'anthropic', inputTokens: 120, outputTokens: 60, calls: 2, updatedAt: 't2' });
    expect(rollup[1]).toMatchObject({ provider: 'openai', inputTokens: 5, outputTokens: 5, calls: 1 });
  });

  it('clamps negatives + defaults missing fields', async () => {
    const T = 'usage-clamp';
    const r = await recordUsage(T, { provider: '', model: '', inputTokens: -5, at: 't4' });
    expect(r).toMatchObject({ provider: 'unknown', model: 'unknown', inputTokens: 0, outputTokens: 0, calls: 1 });
    // and that is what was persisted
    expect(await getUsageRollup(T)).toEqual([r]);
  });

  it('tenant isolation', async () => {
    await recordUsage('iso-a', { provider: 'p', model: 'ma', inputTokens: 1, at: 't' });
    // `iso-a2` shares the `iso-a` string prefix — the `:` delimiter must keep it out.
    await recordUsage('iso-a2', { provider: 'p', model: 'ma2', inputTokens: 1, at: 't' });
    await recordUsage('iso-b', { provider: 'p', model: 'mb', inputTokens: 1, at: 't' });
    expect((await getUsageRollup('iso-a')).map((r) => r.model)).toEqual(['ma']);
    expect((await getUsageRollup('iso-b')).map((r) => r.model)).toEqual(['mb']);
    expect(await getUsageRollup('iso-empty')).toEqual([]);
  });
});

describe('getUsageRollupWithCost (ADR 0118 Phase 5)', () => {
  // UA-G1 — this expectation MOVED, deliberately. It used to assert
  // `unpriced.costUsd === 0` under the title "no fabricated cost". That test was
  // encoding the bug: 0 IS a fabricated cost, and on a spend dashboard it is the
  // one number that asserts the model was FREE. `computeCostUsd` returns
  // undefined for "no rate for this model", and that distinction now survives to
  // the client. Rewritten rather than deleted so the reasoning is visible.
  it('estimates costUsd from the rate table; an UNPRICED model has no cost at all', async () => {
    const CT = 'usage-cost-tenant';
    await recordUsage(CT, { provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000, at: 't1' });
    await recordUsage(CT, { provider: 'mystery', model: 'mystery-model-9000', inputTokens: 500, outputTokens: 500, at: 't2' });
    const rows = await getUsageRollupWithCost(CT);
    const priced = rows.find((r) => r.model === 'gpt-4o')!;
    // (1M*2.5 + 1M*10) / 1M = 12.5
    expect(priced.costUsd).toBeCloseTo(12.5, 4);
    const unpriced = rows.find((r) => r.model === 'mystery-model-9000')!;
    // Absent, not zero — the row exists and its token counts are real; only the
    // price is unknown.
    expect(unpriced.costUsd).toBeUndefined();
    expect('costUsd' in unpriced).toBe(false);
    expect(unpriced.inputTokens).toBe(500);
  });
});
