/**
 * ADR 0458 P0 — the enrollment→wearable-rules lifecycle subscription. The
 * ordering-proof path: whichever eraser runs first, deleting an enrollment
 * fires the owner's lifecycle seam and the enrollment's wearable rules follow.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { fireEnrollmentDeleted } from '../src/features/kicktodo-core/enrollmentLifecycle.js';
// Importing the service registers the keyed subscription (module-load side effect).
import { __test as integrations } from '../src/features/kicktodo-integrations/integrationService.js';

const TENANT = 'user:lifecycle-test';
const OTHER_TENANT = 'user:lifecycle-other';

describe('onEnrollmentDeleted → wearable-rule cleanup', () => {
  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });
  beforeEach(async () => {
    for (const r of await integrations.rules.list()) {
      await integrations.rules.delete(`${r.tenantId}::${r.enrollmentId}::${r.stableActivityId}`);
    }
  });

  it('deletes exactly the deleted enrollment’s rules, tenant-scoped', async () => {
    const mk = (tenantId: string, enrollmentId: string, stableActivityId: string) =>
      integrations.rules.put({ tenantId, enrollmentId, stableActivityId, metric: 'steps', threshold: 5000, createdAt: new Date().toISOString() });
    await mk(TENANT, 'enr-1', 'walk-d2');
    await mk(TENANT, 'enr-1', 'walk-d4');
    await mk(TENANT, 'enr-2', 'walk-d2');
    await mk(OTHER_TENANT, 'enr-1', 'walk-d2'); // same enrollment id, different tenant

    await fireEnrollmentDeleted({ tenantId: TENANT, enrollmentId: 'enr-1' });

    const left = await integrations.rules.list();
    const keys = left.map((r) => `${r.tenantId}::${r.enrollmentId}`).sort();
    expect(keys).toEqual([`${OTHER_TENANT}::enr-1`, `${TENANT}::enr-2`]);
  });

  it('is idempotent — a second fire matches nothing and does not throw', async () => {
    await integrations.rules.put({ tenantId: TENANT, enrollmentId: 'enr-1', stableActivityId: 'walk-d2', metric: 'steps', threshold: 5000, createdAt: '2026-01-01T00:00:00.000Z' });
    await integrations.rules.put({ tenantId: TENANT, enrollmentId: 'enr-2', stableActivityId: 'walk-d2', metric: 'steps', threshold: 5000, createdAt: '2026-01-01T00:00:00.000Z' });
    // The handler ran both times (fireEnrollmentDeleted counts handlers that did
    // NOT throw — it swallows, so a throwing re-run would show as 0, not a throw).
    expect(await fireEnrollmentDeleted({ tenantId: TENANT, enrollmentId: 'enr-1' })).toBe(1); // the one subscriber (integrations' wearable-rules)
    expect(await fireEnrollmentDeleted({ tenantId: TENANT, enrollmentId: 'enr-1' })).toBe(1); // the one subscriber (integrations' wearable-rules)
    // …and the repeat removed nothing else: enr-2's rule survives.
    expect((await integrations.rules.list()).map((r) => `${r.tenantId}::${r.enrollmentId}`)).toEqual([`${TENANT}::enr-2`]);
  });
});
