/**
 * ADR 0118 Phase 2 — usage rollup.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordUsage, getUsageRollup } from '../src/features/usage-analytics/usageRollupService.js';

const T = 'usage-tenant';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('usage rollup', () => {
  it('accumulates tokens + calls per (provider, model)', async () => {
    await recordUsage(T, { provider: 'anthropic', model: 'opus', inputTokens: 100, outputTokens: 50, at: 't1' });
    await recordUsage(T, { provider: 'anthropic', model: 'opus', inputTokens: 20, outputTokens: 10, at: 't2' });
    await recordUsage(T, { provider: 'openai', model: 'gpt', inputTokens: 5, outputTokens: 5, at: 't3' });
    const rollup = await getUsageRollup(T);
    const opus = rollup.find((r) => r.model === 'opus')!;
    expect(opus).toMatchObject({ inputTokens: 120, outputTokens: 60, calls: 2 });
    expect(rollup[0]!.model).toBe('opus'); // ranked by total tokens
  });

  it('clamps negatives + defaults missing fields', async () => {
    const r = await recordUsage(T, { provider: '', model: '', inputTokens: -5, at: 't4' });
    expect(r.provider).toBe('unknown');
    expect(r.inputTokens).toBe(0); // negative clamped
  });

  it('tenant isolation', async () => {
    expect(await getUsageRollup('empty-tenant')).toEqual([]);
  });
});

import { getUsageRollupWithCost } from '../src/features/usage-analytics/usageRollupService.js';
describe('getUsageRollupWithCost (ADR 0118 Phase 5)', () => {
  it('estimates costUsd from the rate table; unpriced model → 0 (no fabricated cost)', async () => {
    const CT = 'usage-cost-tenant';
    await recordUsage(CT, { provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000, at: 't1' });
    await recordUsage(CT, { provider: 'mystery', model: 'mystery-model-9000', inputTokens: 500, outputTokens: 500, at: 't2' });
    const rows = await getUsageRollupWithCost(CT);
    const priced = rows.find((r) => r.model === 'gpt-4o')!;
    // (1M*2.5 + 1M*10) / 1M = 12.5
    expect(priced.costUsd).toBeCloseTo(12.5, 4);
    const unpriced = rows.find((r) => r.model === 'mystery-model-9000')!;
    expect(unpriced.costUsd).toBe(0);
  });
});
