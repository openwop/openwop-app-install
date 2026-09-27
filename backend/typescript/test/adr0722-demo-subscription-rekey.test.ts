import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  LEGACY_DEMO_AUTO_INGEST_PREFIX,
  __resetTriggerBridgeStore,
  demoAutoIngestSubscriptionId,
  getSubscription,
  registerSubscription,
} from '../src/host/triggerBridgeService.js';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';

/**
 * ADR 0722 A.7 — migration 21 re-keys the demo auto-ingest subscription from the
 * `:`-carrying id to the grammar-safe one, so the idempotent-by-id seed finds the
 * row instead of registering a SECOND demo subscription per tenant.
 */
describe('migration 21 — re-key demo auto-ingest subscription ids', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => { initHostExtPersistence(storage); });
  afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });
  beforeEach(() => { __resetTriggerBridgeStore(); });

  const found = APP_MIGRATIONS.find((m) => m.version === 21);
  if (!found) throw new Error('migration 21 is missing');
  const m21 = found;

  it('exists and is the highest version', () => {
    expect(m21.name).toBe('rekey-demo-auto-ingest-subscription-ids');
    expect(Math.max(...APP_MIGRATIONS.map((m) => m.version))).toBe(21);
  });

  it('moves a legacy row to the new id and keeps its fields; a re-seed then finds it', async () => {
    const tenantId = 'acme';
    const legacy = await registerSubscription({
      subscriptionId: `${LEGACY_DEMO_AUTO_INGEST_PREFIX}${tenantId}`, tenantId, source: 'webhook',
      workflowId: 'feature.agent-knowledge.auto-ingest', verificationMode: 'none', label: 'legacy demo row',
    });
    await m21.run(storage);
    const newId = demoAutoIngestSubscriptionId(tenantId);
    expect(await getSubscription(legacy.subscriptionId), 'the legacy id is gone').toBeNull();
    const moved = await getSubscription(newId);
    expect(moved?.label).toBe('legacy demo row');
    expect(moved?.workflowId).toBe('feature.agent-knowledge.auto-ingest');
    // The seed's idempotence: registering the NEW id again returns the moved row, not a second one.
    const again = await registerSubscription({ subscriptionId: newId, tenantId, source: 'webhook' });
    expect(again.label, 'no duplicate demo subscription').toBe('legacy demo row');
  });

  it('is idempotent and never fatal — a second run finds nothing to do', async () => {
    await expect(m21.run(storage)).resolves.toBeUndefined();
  });

  it('does NOT touch a subscription that is not the demo row', async () => {
    const other = await registerSubscription({ subscriptionId: 'customer-sub-0123456789abcdef', tenantId: 'acme', source: 'webhook' });
    await m21.run(storage);
    expect(await getSubscription(other.subscriptionId)).toBeDefined();
  });
});
