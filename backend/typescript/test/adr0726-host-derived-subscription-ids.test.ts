/** ADR 0726 — host-derived trigger subscription ids are inside the corpus opaque grammar, and a legacy colon-spelled row moves on first use. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetTriggerBridgeStore, getSubscription, hostDerivedSubscriptionId, registerHostDerivedSubscription, registerSubscription } from '../src/host/triggerBridgeService.js';
import { V2_OPAQUE_ID } from '../src/host/v2Ids.js';

describe('ADR 0726 — host-derived subscription ids', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(async () => { initHostExtPersistence(storage); await __resetTriggerBridgeStore(); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  it('kanban + connection ids match the opaque grammar (they carried colons and could never bind)', () => {
    const k = hostDerivedSubscriptionId('kanban', 'board-53de82e8-9873-437f-8f43-a31795a6a5f5');
    const c = hostDerivedSubscriptionId('connections', 'conn:87d39b42-a499-4c73-b1ec-54e7d5648b1a');
    for (const x of [k, c]) { expect(V2_OPAQUE_ID.test(x.id), x.id).toBe(true); expect(x.legacyId).toMatch(/^host:(kanban|connections):/); }
    expect(hostDerivedSubscriptionId('kanban', 'board-1').id, 'deterministic').toBe(hostDerivedSubscriptionId('kanban', 'board-1').id);
  });
  it('a legacy-spelled row is moved to the new id on register; a fresh register is idempotent', async () => {
    const { id, legacyId } = hostDerivedSubscriptionId('kanban', 'board-legacy-0000000001');
    await registerSubscription({ subscriptionId: legacyId, tenantId: 't1', source: 'queue', label: 'legacy' });
    const got = await registerHostDerivedSubscription('kanban', 'board-legacy-0000000001', { tenantId: 't1', source: 'queue', label: 'new' });
    expect(got).toBe(id);
    expect(await getSubscription(legacyId), 'the legacy row is gone').toBeFalsy();
    expect((await getSubscription(id))?.tenantId).toBe('t1');
    expect(await registerHostDerivedSubscription('kanban', 'board-legacy-0000000001', { tenantId: 't1', source: 'queue', label: 'again' })).toBe(id);
  });
});
