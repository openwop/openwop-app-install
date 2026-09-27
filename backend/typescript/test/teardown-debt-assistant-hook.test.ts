/**
 * Teardown-reachability RECORDED_DEBT shrink (baseline 7→5): the assistant
 * commitment SECONDARY INDEXES (`assistant:commitment:by-tenant` /
 * `:by-status`) key `ixId=`${tenantId}:…`` with no top-level `tenantId`, so the
 * generic `purgeTenantHostExt` walk cannot reach them and they orphaned on
 * account deletion. A `tenantOf` cannot parse the tenant out (tenant ids contain
 * `:`), so `feature.ts` registers a `purgeTenantHostExt` pre-hook
 * (`purgeTenantAssistantIndexes`, ADR 0590) that exact-scans via
 * `listByPrefix(`${tenantId}:`)`.
 *
 * Two parts:
 *  1. BEHAVIORAL — register the hook the way `feature.ts` does, seed via the real
 *     service, purge, and assert both index rows are reached AND the prefix-sibling
 *     tenant survives (the trailing-colon guard: `org:asst2` must outlive a purge
 *     of `org:asst`; a `startsWith(tenantId)` sans colon — or a `split(':')[0]` —
 *     would corrupt one of them). Born-red: drop the hook registration → A's rows
 *     survive the purge.
 *  2. WIRING — assert `feature.ts` actually calls
 *     `registerTenantPurgeHook('assistant', purgeTenantAssistantIndexes)`, so
 *     deleting the wiring (leaving the function orphaned) fails the build.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  initHostExtPersistence,
  purgeTenantHostExt,
  hostExtStorage,
  registerTenantPurgeHook,
} from '../src/host/hostExtPersistence.js';
import { upsertCommitmentBySource, purgeTenantAssistantIndexes } from '../src/features/assistant/assistantService.js';

// A is a proper prefix of B (`org:asst` vs `org:asst2`): the trailing-colon guard
// is the ONLY thing that stops A's purge from eating B's rows.
const A = 'org:asst';
const B = 'org:asst2';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // Mirror feature.ts's boot wiring so purgeTenantHostExt invokes the hook.
  registerTenantPurgeHook('assistant', purgeTenantAssistantIndexes);
});

async function seed(tenant: string): Promise<void> {
  await upsertCommitmentBySource(tenant, {
    owner: { kind: 'self' },
    description: `commitment for ${tenant}`,
    source: { kind: 'manual', externalId: `m-${tenant}`, contentHash: 'h', capturedAt: '2026-01-01T00:00:00Z' },
    status: 'open',
  });
}

// Index rows key `${tenant}:…`; match the exact tenant segment (with the colon)
// so `org:asst` does not spuriously match `org:asst2`.
function residual(rows: ReadonlyArray<{ key: string; value: string }>, ns: string, tenant: string) {
  return rows.filter(({ key }) => key.includes(ns) && key.includes(`:${tenant}:`));
}

describe('teardown-debt assistant hook — commitment indexes are teardown-reachable', () => {
  it('purges tenant A\'s by-tenant + by-status index rows; the prefix-sibling tenant B survives', async () => {
    await seed(A);
    await seed(B);

    let rows = await hostExtStorage().kvList('hostext:');
    expect(residual(rows, 'assistant:commitment:by-tenant', A).length).toBeGreaterThan(0);
    expect(residual(rows, 'assistant:commitment:by-status', A).length).toBeGreaterThan(0);

    await purgeTenantHostExt(A);

    rows = await hostExtStorage().kvList('hostext:');
    // A's index rows are GONE — the hook reached them (born-red without the hook).
    expect(residual(rows, 'assistant:commitment:by-tenant', A)).toEqual([]);
    expect(residual(rows, 'assistant:commitment:by-status', A)).toEqual([]);
    // B (`org:asst2`, a prefix-extension of A) is UNTOUCHED — the colon guard holds.
    expect(residual(rows, 'assistant:commitment:by-tenant', B).length).toBeGreaterThan(0);
    expect(residual(rows, 'assistant:commitment:by-status', B).length).toBeGreaterThan(0);
  });

  it('feature.ts wires the hook (deleting the registration must fail this test)', () => {
    const featureSrc = readFileSync(join(__dirname, '..', 'src', 'features', 'assistant', 'feature.ts'), 'utf8');
    expect(featureSrc).toMatch(/registerTenantPurgeHook\(\s*['"]assistant['"]\s*,\s*purgeTenantAssistantIndexes\s*\)/);
  });
});
