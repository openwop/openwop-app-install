/**
 * `demo-cdp` round-trip (app-seeding-strategy.md §4 Phase 7, ADR 0262-0270).
 *
 * Verifies: versioned event schemas, backdated collected + analytics event
 * volume, identity stitching, consent (opted-out records), CDC + event syncs,
 * a segment-enrolled journey with a holdout, and scoped developer keys — seeded
 * idempotently and cleared with no orphans.
 *
 * Sabotage-witnessed (/grade-tests w38): every marketing opt-in forced on, the analytics
 * idempotency guard bypassed, the clear skipping identity links / event schemas / developer keys,
 * and the 20% holdout skip removed each turn the case red.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoCdp, clearDemoCdp, countDemoCdp } from '../src/host/demoCdpSeed.js';
import { listEventSchemas } from '../src/features/cdp/eventSchemaService.js';
import { listConsent } from '../src/features/consent/consentService.js';
import { listDestinationSyncs } from '../src/features/destination-sync/destinationSyncService.js';
import { listEnrollments, resolveSegment } from '../src/features/campaign-journeys/journeyService.js';
import { demoCrmSegmentId } from '../src/host/seed-data/solsticeDemo.js';
import { holdoutArm } from '../src/features/campaign-journeys/surface.js';
import { listApiKeys } from '../src/features/developer-keys/apiKeyService.js';

const analyticsStore = new DurableCollection<{ eventId: string; tenantId: string }>('analytics:event', (e) => e.eventId, undefined, (e) => e.tenantId);
const identityStore = new DurableCollection<{ key: string; tenantId: string; sessionKey: string }>('analytics:identity-link', (l) => l.key, undefined, (l) => l.tenantId);
const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-cdp-')) });
  for (const id of ['crm', 'analytics', 'cdp', 'consent', 'destination-sync', 'campaign-journeys', 'developer-keys']) {
    registerToggleDefault({ id, salt: id, ...ON });
  }
});

describe('demo-cdp seeder', () => {
  it('seeds schemas/events/identity/consent/syncs/journey/keys, idempotent; clears clean', async () => {
    const tenantId = 'demo-cdp-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);

    const first = await seedDemoCdp(tenantId);
    expect(first.created).toBeGreaterThan(2000);

    // Event schemas: checkout_completed has two versions.
    const schemas = await listEventSchemas(tenantId);
    expect(schemas.some((s) => s.eventType === 'checkout_completed' && s.version === 2)).toBe(true);
    expect(new Set(schemas.map((s) => s.eventType))).toEqual(new Set(['page_view', 'product_viewed', 'checkout_completed']));

    // Backdated volume + identity stitching.
    expect(await countDemoCdp(tenantId)).toBe(400);
    const analytics = (await analyticsStore.listForTenantIndexed(tenantId)).filter((e) => e.eventId.startsWith('evt:demo-cdp-a-'));
    expect(analytics.length).toBe(1800);
    expect((await identityStore.listForTenantIndexed(tenantId)).filter((l) => l.sessionKey.startsWith('demo-cdp-sess-'))).toHaveLength(40);

    // Consent — 40 records incl. opted-out marketing.
    const consent = (await listConsent(tenantId)).filter((c) => c.subjectKey.startsWith('demo-cdp-sess-'));
    expect(consent).toHaveLength(40);
    expect(consent.some((c) => c.categories.marketing === false)).toBe(true);

    // Destination syncs (CDC + event) + journey enrollments (with holdout < segment).
    const syncs = (await listDestinationSyncs(tenantId)).filter((s) => s.name.startsWith('Demo — '));
    expect(syncs).toHaveLength(2);
    expect(syncs.some((s) => s.syncMode === 'cdc')).toBe(true);
    const enrollments = await listEnrollments(tenantId, 'demo-cdp-welcome-series');
    expect(enrollments.length).toBeGreaterThan(0);
    // The holdout: no control-arm member is enrolled, and the fixture really has
    // one. A count comparison (enrolled < members) could not fail: enroll() also
    // declines some members for its own reasons, so removing the seed's holdout
    // skip kept the count below the segment (w38 probe ds-holdout-r2 was vacuous).
    const { contactIds: segmentMembers } = await resolveSegment(tenantId, demoCrmSegmentId(tenantId, 'cafe-accounts'));
    const control = segmentMembers.filter((id) => holdoutArm(id, 'demo-cdp-welcome-series', 20).arm === 'control');
    expect(control.length).toBeGreaterThan(0);
    const enrolledIds = new Set(enrollments.map((e) => e.contactId));
    expect(control.filter((id) => enrolledIds.has(id))).toEqual([]);

    // Developer keys — 2 (one revoked); only hashes persist.
    const keys = (await listApiKeys(tenantId, { callerSubject: 'demo:cdp', isAdmin: true })).filter((k) => k.createdBy === 'demo:cdp');
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.revokedAt)).toBe(true);
    expect(keys.every((k) => !('tokenHash' in k))).toBe(true); // no secret leaks

    // Idempotent re-seed.
    const before = await countDemoCdp(tenantId);
    const second = await seedDemoCdp(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoCdp(tenantId)).toBe(before);

    // Clear — everything demo-scoped removed.
    await clearDemoCdp(tenantId);
    expect(await countDemoCdp(tenantId)).toBe(0);
    expect((await analyticsStore.listForTenantIndexed(tenantId)).filter((e) => e.eventId.startsWith('evt:demo-cdp-a-'))).toHaveLength(0);
    expect((await listConsent(tenantId)).filter((c) => c.subjectKey.startsWith('demo-cdp-sess-'))).toHaveLength(0);
    expect((await listDestinationSyncs(tenantId)).filter((s) => s.name.startsWith('Demo — '))).toHaveLength(0);
    expect(await listEnrollments(tenantId, 'demo-cdp-welcome-series')).toHaveLength(0);
    // …and the three stores the original clear leg never read (w38: their deletes were unguarded).
    expect((await identityStore.listForTenantIndexed(tenantId)).filter((l) => l.sessionKey.startsWith('demo-cdp-sess-'))).toHaveLength(0);
    expect(await listEventSchemas(tenantId)).toEqual([]);
    expect((await listApiKeys(tenantId, { callerSubject: 'demo:cdp', isAdmin: true })).filter((k) => k.createdBy === 'demo:cdp')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoCdp(tenantId);
    expect(third.created).toBeGreaterThan(2000);
  });
});

// ADR 0955 D1 — the demo provisions campaign-ops (with agency clients) AND campaign-journeys
// into the same workspace. A client-less enroll is refused `client_required` there, so the
// demo journey names the workspace root (the agency's house account).
describe('demo-cdp seeder in a workspace that has clients', () => {
  it('still enrolls the demo journey, and clears it', async () => {
    const { createOrg } = await import('../src/host/accessControlService.js');
    const { createClient } = await import('../src/features/campaign-ops/clientService.js');
    const tenantId = 'demo-cdp-t-agency';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    const org = (await createOrg({ tenantId, createdBy: 'seed', name: 'Client (synthetic)' })).orgId;
    await createClient({ tenantId, orgId: org, name: 'Client (synthetic)', createdBy: 'seed' });
    await seedDemoCdp(tenantId);
    expect((await listEnrollments(tenantId, 'demo-cdp-welcome-series')).length).toBeGreaterThan(0);
    await clearDemoCdp(tenantId);
    expect(await listEnrollments(tenantId, 'demo-cdp-welcome-series')).toHaveLength(0);
  });
});
