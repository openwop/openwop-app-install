/**
 * ADR 0820 §7 / strategy G10 — background daemons and observers check their
 * owning feature PER TENANT (toggle + plan), skipping a tenant silently and
 * cheaply. Each lane: a plan-lapsed tenant's work does not happen (RED before
 * this change), and an entitled tenant's does (the positive control, so a gate
 * that blocks everyone cannot pass).
 *
 * The data owners each daemon calls are spied (not replaced wholesale): the
 * spy IS the observation of "did this tenant's work run".
 *
 * Sabotage witnesses (w35): each lane's own `mayUse`/`tenantMayUseFeature` check
 * removed, the shared `tenantFeatureGate` answering true, the host-event gate
 * skipped or applied to core events, and funnels gating on 'crm' instead of
 * 'funnels' (red only since the plan became feature-specific) each red a leg.
 *
 * W35-CDP-CLAIM-1 (grade-code): `segmentEntryDaemon.ts` tested `if (!claim)` on the
 * object `claimOnce` returns, so the fleet-wide fire-once claim never skipped — the
 * only one of the ten `claimOnce` callers that did not read `.claimed`. FIXED
 * (`if (!claim.claimed)`); the pin below is now a passing `it`, and the concurrent
 * two-instance race is witnessed in `cdp-segment-entry-fleet-claim.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const listWatchedSegments = vi.fn(async () => [
  { tenantId: 'lapsed-cdp', segmentId: 'seg-a' },
  { tenantId: 'acme-cdp', segmentId: 'seg-b' },
]);
const resolveSegmentMembers = vi.fn(async (_tenantId: string, _segmentId: string) => [] as Array<{ contactId: string }>);
vi.mock('../src/features/crm/segmentsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/crm/segmentsService.js')>()),
  listWatchedSegments: () => listWatchedSegments(),
  resolveSegmentMembers: (t: string, s: string) => resolveSegmentMembers(t, s),
}));

const listPipelines = vi.fn(async (_tenantId: string, _orgId: string) => []);
vi.mock('../src/features/crm/crmEntitiesService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/crm/crmEntitiesService.js')>()),
  listPipelines: (t: string, o: string) => listPipelines(t, o),
}));

const listOrders = vi.fn(async (_tenantId: string, _orgId: string) => []);
vi.mock('../src/features/commerce/commerceService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/commerce/commerceService.js')>()),
  listOrders: (t: string, o: string) => listOrders(t, o),
}));

const listFunnelScopes = vi.fn(async () => [
  { tenantId: 'lapsed-fun', orgId: 'o1' },
  { tenantId: 'acme-fun', orgId: 'o2' },
]);
const listFunnels = vi.fn(async (_tenantId: string, _orgId: string) => []);
vi.mock('../src/features/funnels/funnelsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/funnels/funnelsService.js')>()),
  listFunnelScopes: () => listFunnelScopes(),
  listFunnels: (t: string, o: string) => listFunnels(t, o),
}));

const getConnection = vi.fn(async (_tenantId: string, _connectionId: string) => null);
vi.mock('../src/features/connections/connectionsService.js', async (orig) => ({
  ...(await orig<typeof import('../src/features/connections/connectionsService.js')>()),
  getConnection: (t: string, c: string) => getConnection(t, c),
}));

import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { OpenwopError } from '../src/types.js';
import { sweepSegmentEntries } from '../src/features/cdp/segmentEntryDaemon.js';
import { processDueCrmSnapshots } from '../src/features/crm/snapshotDaemon.js';
import { createPlacement, rebuildAllAffinity } from '../src/features/recommendations/recommendationsService.js';
import { sweepFunnelStats } from '../src/features/funnels/funnelStats.js';
import { onVerifiedWebinarWebhook } from '../src/features/webinars/webinarProcessor.js';
import { recordNoTrainAttestation, whatsappDispatchAllowed } from '../src/features/whatsapp/compliance.js';
import {
  __clearHostEventBindings, __resetHostEventDispatcher, createHostEventBinding, emitHostEvent, initHostEventDispatcher,
} from '../src/host/hostEventDispatcher.js';
import type { StartRunDeps } from '../src/host/runStarter.js';

const FEATURES = ['cdp', 'crm', 'recommendations', 'funnels', 'webinars', 'whatsapp'];
const storage = openSqliteStorage(':memory:');

/**
 * Each lapsed tenant's plan excludes ONLY the feature its lane must gate on, so a
 * lane that checked the wrong (but registered) feature id would serve it and red.
 * (w35: a plan refusing every feature made a swapped id invisible.) `lapsed-core`
 * is refused everything: it is the "no feature owns this event" leg.
 */
const LAPSED_FEATURE: Record<string, string> = {
  'lapsed-cdp': 'cdp', 'lapsed-crm': 'crm', 'lapsed-reco': 'recommendations', 'lapsed-fun': 'funnels',
  'lapsed-web': 'webinars', 'lapsed-wa': 'whatsapp', 'lapsed-hev': 'crm',
};
function installPlan(): void {
  registerTenantEntitlementCheck(async (tenantId, featureId) => {
    if (tenantId === 'lapsed-core' || LAPSED_FEATURE[tenantId] === featureId) {
      throw new OpenwopError('forbidden', `plan excludes ${featureId}`, 403, { feature: featureId });
    }
  });
}

beforeAll(() => {
  initHostExtPersistence(storage);
  for (const id of FEATURES) registerToggleDefault({ id, status: 'on', bucketUnit: 'tenant', salt: id });
});
afterAll(async () => { __resetHostExtPersistence(); __resetHostEventDispatcher(); await storage.close(); });
beforeEach(async () => {
  initHostExtPersistence(storage);
  await __clearToggleStore();
  for (const id of FEATURES) await saveConfig({ id, status: 'on', bucketUnit: 'tenant', salt: id }, 'test');
  installPlan();
  vi.clearAllMocks();
});

const tenantsCalled = (fn: { mock: { calls: unknown[][] } }): string[] => fn.mock.calls.map((c) => c[0] as string);

describe('G10 — CDP segment-entry daemon', () => {
  it('resolves membership only for tenants that may use cdp', async () => {
    await sweepSegmentEntries(storage, Date.now());
    expect(tenantsCalled(resolveSegmentMembers)).toEqual(['acme-cdp']);
  });

  it('a toggle switched off for a tenant is skipped the same way', async () => {
    await saveConfig({ id: 'cdp', status: 'on', bucketUnit: 'tenant', salt: 'cdp', tenantOverrides: { 'acme-cdp': { status: 'off' } } }, 'test');
    await sweepSegmentEntries(storage, Date.now() + 60_000 * 5);
    expect(resolveSegmentMembers).not.toHaveBeenCalled();
  });
});

describe('W35-CDP-CLAIM-1 — the segment-entry sweep honours the fleet-wide slot claim', () => {
  it('a slot another instance already claimed is skipped: no membership resolve, nothing emitted', async () => {
    const now = Date.UTC(2031, 0, 15, 10, 30, 0); // a slot no other leg uses
    const slot = Math.floor(now / 60_000); // the daemon's one-minute slot
    const first = await storage.claimOnce(`cdp:segment-entry:acme-cdp:seg-b:${slot}`, new Date(now).toISOString());
    expect(first.claimed, 'the pre-claim must take the slot').toBe(true);
    expect(await sweepSegmentEntries(storage, now)).toBe(0);
    expect(resolveSegmentMembers).not.toHaveBeenCalled();
  });
});

describe('G10 — CRM snapshot daemon', () => {
  it('snapshots only tenants that may use crm', async () => {
    await processDueCrmSnapshots({ storage }, async () => [
      { tenantId: 'lapsed-crm', orgId: 'o1' },
      { tenantId: 'acme-crm', orgId: 'o2' },
    ], Date.now());
    expect(tenantsCalled(listPipelines)).toEqual(['acme-crm']);
  });
});

describe('G10 — recommendations affinity rebuild', () => {
  it('rebuilds only for tenants that may use recommendations', async () => {
    await createPlacement({ tenantId: 'lapsed-reco', orgId: 'o1', createdBy: 'u', slot: 'pdp', source: 'trending', active: true });
    await createPlacement({ tenantId: 'acme-reco', orgId: 'o2', createdBy: 'u', slot: 'pdp', source: 'trending', active: true });
    await rebuildAllAffinity();
    expect(tenantsCalled(listOrders)).toContain('acme-reco');
    expect(tenantsCalled(listOrders)).not.toContain('lapsed-reco');
  });
});

describe('G10 — funnel stats sweep', () => {
  it('rebuilds only for tenants that may use funnels', async () => {
    expect(await sweepFunnelStats()).toBe(1);
    expect(tenantsCalled(listFunnels)).toEqual(['acme-fun']);
  });
});

describe('G10 — Zoom webhook observer', () => {
  const body = { event: 'webinar.registration_created', payload: { object: { id: 'w1', registrant: { email: 'a@example.com' } } } };

  it('a lapsed tenant\'s event is not ingested (the observer returns before any read; the route ACKs regardless)', async () => {
    await expect(onVerifiedWebinarWebhook({ tenantId: 'lapsed-web', connectionId: 'c1', body, now: Date.now() })).resolves.toBeUndefined();
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('POSITIVE: an entitled tenant\'s event proceeds to ingestion', async () => {
    await onVerifiedWebinarWebhook({ tenantId: 'acme-web', connectionId: 'c1', body, now: Date.now() });
    expect(tenantsCalled(getConnection)).toEqual(['acme-web']);
  });
});

describe('G10 — WhatsApp inbound workflow dispatch', () => {
  it('a lapsed tenant does not dispatch, even with the attestation recorded', async () => {
    await recordNoTrainAttestation('lapsed-wa', 'admin');
    expect(await whatsappDispatchAllowed('lapsed-wa')).toEqual({ allow: false, reason: 'feature_unavailable' });
  });

  it('POSITIVE: an entitled, attested tenant dispatches; the attestation gate still applies', async () => {
    await recordNoTrainAttestation('acme-wa', 'admin');
    expect(await whatsappDispatchAllowed('acme-wa')).toEqual({ allow: true });
    expect(await whatsappDispatchAllowed('acme-wa-unattested')).toEqual({ allow: false, reason: 'no_train_attestation_missing' });
  });
});

describe('G10 — host-event dispatcher bindings', () => {
  const startRun = vi.fn(async (_d: StartRunDeps, input: { tenantId: string }) => `run-${input.tenantId}`);
  beforeEach(async () => {
    await __clearHostEventBindings();
    initHostEventDispatcher({
      storage,
      hostSuite: {
        workflowCatalog: { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
        providerPolicyResolver: { resolveForRun: async () => [] },
      },
      deliverWebhooks: async () => undefined,
      startRun,
    });
  });

  it('a crm event starts the bound workflow only for a tenant that may use crm', async () => {
    for (const tenantId of ['lapsed-hev', 'acme-hev']) {
      await createHostEventBinding({ tenantId, eventType: 'host.crm.contact.created', workflowId: 'wf.bound', createdBy: 'u' });
      await emitHostEvent({ type: 'host.crm.contact.created', tenantId, payload: { contactId: 'c1' } });
    }
    expect(startRun.mock.calls.map((c) => c[1].tenantId)).toEqual(['acme-hev']);
  });

  it('an event no feature owns (a core namespace) still fires for a lapsed tenant', async () => {
    await createHostEventBinding({ tenantId: 'lapsed-core', eventType: 'host.kanban.card.moved', workflowId: 'wf.bound', createdBy: 'u' });
    await emitHostEvent({ type: 'host.kanban.card.moved', tenantId: 'lapsed-core', payload: {} });
    expect(startRun.mock.calls.map((c) => c[1].tenantId)).toEqual(['lapsed-core']);
  });
});
