/**
 * ANL-4 (grade-code 2026-08-18 → 2026-09-10) — the REAL analytics retention purger
 * had no test. `retention-sweep.test.ts` registered a synthetic purger literally
 * named `feature: 'analytics'` over an in-memory array, so a grep for "the analytics
 * purger's test" read green over a fixture that never touched `analytics:event`
 * (that fixture is renamed `synthetic-sweep-fixture` in the same change).
 *
 * This witness drives `processRetentionSweep` over the purger `analyticsService.ts`
 * registers at import, against rows in the real store: a past-window row is
 * deleted, a fresh row and another tenant's past-window row survive.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { processRetentionSweep } from '../src/host/retentionSweepDaemon.js';
import { setGovernancePolicy } from '../src/host/governanceService.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __resetAnalyticsStore, __putRawEventForTests, listEvents } from '../src/features/analytics/analyticsService.js';

const DAY = 86_400_000;
const now = 1_900_000_000_000; // fixed clock

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetAnalyticsStore();
});

describe('analytics retention purger (ADR 0077 P3) — the real one', () => {
  it('deletes this tenant\'s past-window events on `ts`, keeps fresh rows and other tenants', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    const row = (eventId: string, tenantId: string, ageDays: number) => ({
      eventId, tenantId, orgId: 'o1', type: 'pageview' as const, path: `/${eventId}`, sessionKey: `s-${eventId}`,
      ts: new Date(now - ageDays * DAY).toISOString(),
    });
    await __putRawEventForTests(row('old', 'tenantA', 400));
    await __putRawEventForTests(row('fresh', 'tenantA', 10));
    await __putRawEventForTests(row('foreign-old', 'tenantB', 400)); // tenantB has NO policy ⇒ untouched
    expect((await listEvents('tenantA', 'o1', 10)).length).toBe(2);

    const total = await processRetentionSweep({ storage }, now);
    expect(total, 'exactly the one past-window analytics row is purged').toBeGreaterThanOrEqual(1);
    expect((await listEvents('tenantA', 'o1', 10)).map((e) => e.eventId)).toEqual(['fresh']);
    expect((await listEvents('tenantB', 'o1', 10)).map((e) => e.eventId), 'no policy ⇒ no purge; never cross-tenant').toEqual(['foreign-old']);
  });

  it('is a no-op on a blank tenant and on the wrong classification (fail-closed)', async () => {
    const { purgeRetained } = await import('../src/host/retentionPurger.js');
    await __putRawEventForTests({ eventId: 'x', tenantId: 'tenantC', orgId: 'o1', type: 'pageview', ts: new Date(now - 400 * DAY).toISOString() });
    const cutoff = new Date(now - 365 * DAY).toISOString();
    const blank = await purgeRetained('', 'confidential-pii', cutoff);
    const internal = await purgeRetained('tenantC', 'internal', cutoff);
    expect(JSON.stringify(blank)).not.toMatch(/"analytics":[1-9]/);
    expect(JSON.stringify(internal)).not.toMatch(/"analytics":[1-9]/);
    expect((await listEvents('tenantC', 'o1', 10)).length).toBe(1);
  });
});
