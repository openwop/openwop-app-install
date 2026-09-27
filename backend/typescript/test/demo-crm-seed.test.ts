/**
 * `demo-crm` seeder round-trip (app-seeding-strategy.md §4 Phase 3, ADR 0191).
 *
 * Verifies the B2B anchor: companies + 75+ contacts, CDP identifiers, a
 * reversible merge (+ a proposable near-dup), probability-weighted pipelines and
 * deals, activities/tasks, overlapping segments, and backdated pipeline
 * snapshots — seeded idempotently and cleared surgically (no orphans).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoCrm, clearDemoCrm, countDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { listContacts } from '../src/features/crm/contactsService.js';
import { listCompanies, listPipelines, listDeals, listTasks } from '../src/features/crm/crmEntitiesService.js';
import { listSegments, resolveSegmentMembers } from '../src/features/crm/segmentsService.js';
import { listMergeEvents } from '../src/features/crm/crmMergeEventsService.js';
import { matchCandidates } from '../src/features/crm/matchCandidatesService.js';
import { SOLSTICE_COMPANIES, SOLSTICE_DEALS, demoCrmSegmentId, demoCrmCompanyId } from '../src/host/seed-data/solsticeDemo.js';

const snapshotStore = new DurableCollection<{ snapshotId: string; tenantId: string }>('crm:snapshot', (s) => s.snapshotId, undefined, (s) => s.tenantId);
const activityStore = new DurableCollection<{ activityId: string; tenantId: string; createdBy?: string }>('crm:activity', (a) => a.activityId, undefined, (a) => a.tenantId);
const stageHistoryStore = new DurableCollection<{ historyId: string; tenantId: string; actor?: string }>('crm:stagehistory', (r) => r.historyId, undefined, (r) => r.tenantId);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // The compiled toggle defaults are registered at app boot; register CRM's here
  // so the seeder's honest toggle gate resolves ON (default) in this unit test.
  registerToggleDefault({ id: 'crm', status: 'on', bucketUnit: 'tenant', salt: 'crm' });
});

describe('demo-crm seeder', () => {
  it('seeds the B2B anchor, idempotent; merge + snapshots + segments; clears clean', async () => {
    const tenantId = 'demo-crm-t1';
    await seedDemoPeople(tenantId); // owners resolve to seeded reps
    // The org has a random id (review #1344) — resolve it, don't hardcode.
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoCrm(tenantId);
    expect(first.created).toBeGreaterThan(100);

    // Companies + contacts.
    expect((await listCompanies(tenantId, orgId)).filter((c) => c.createdBy === 'demo:crm')).toHaveLength(SOLSTICE_COMPANIES.length);
    const contacts = (await listContacts(tenantId)).filter((c) => c.contactId.startsWith('crm:demo-crm-'));
    expect(contacts.length).toBeGreaterThanOrEqual(75);
    // CDP-A: some contacts carry multiple identifiers.
    expect(contacts.filter((c) => (c.identifiers?.length ?? 0) >= 3).length).toBeGreaterThanOrEqual(15);

    // CDP-B: exactly one reversible merge event; the typo'd pair is proposable.
    const merges = (await listMergeEvents(tenantId)).filter((e) => e.actor === 'demo:crm');
    expect(merges).toHaveLength(1);
    const candidates = (await matchCandidates(tenantId)).candidates;
    expect(candidates.length).toBeGreaterThanOrEqual(1);

    // Pipelines + deals.
    expect((await listPipelines(tenantId, orgId)).length).toBeGreaterThanOrEqual(4);
    expect((await listDeals(tenantId, orgId)).filter((d) => d.createdBy === 'demo:crm')).toHaveLength(SOLSTICE_DEALS.length);
    // Tasks.
    expect((await listTasks(tenantId, orgId)).filter((t) => t.createdBy === 'demo:crm').length).toBe(25);

    // Segments compute non-empty, overlapping membership.
    const segs = (await listSegments(tenantId)).filter((s) => s.segmentId.startsWith('seg:demo-crm-'));
    expect(segs).toHaveLength(6);
    const hotels = await resolveSegmentMembers(tenantId, demoCrmSegmentId(tenantId, 'hotel-buyers'));
    const west = await resolveSegmentMembers(tenantId, demoCrmSegmentId(tenantId, 'west-territory'));
    expect(hotels.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);

    // Backdated weekly snapshots + activities present.
    expect((await snapshotStore.listForTenantIndexed(tenantId)).length).toBeGreaterThanOrEqual(40);
    expect((await activityStore.listForTenantIndexed(tenantId)).filter((a) => a.createdBy === 'demo:crm').length).toBe(SOLSTICE_DEALS.length * 2);
    // Stage-history rows are stamped actor='demo:crm' (createDeal's actor←createdBy).
    expect((await stageHistoryStore.listForTenantIndexed(tenantId)).filter((r) => r.actor === 'demo:crm').length).toBeGreaterThanOrEqual(SOLSTICE_DEALS.length);

    // Idempotent re-seed — nothing net-new, count holds.
    const countBefore = await countDemoCrm(tenantId);
    const second = await seedDemoCrm(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoCrm(tenantId)).toBe(countBefore);

    // Clear removes everything (no orphans left in activities/snapshots either).
    await clearDemoCrm(tenantId);
    expect(await countDemoCrm(tenantId)).toBe(0);
    expect((await listCompanies(tenantId, orgId)).filter((c) => c.createdBy === 'demo:crm')).toHaveLength(0);
    expect((await listDeals(tenantId, orgId)).filter((d) => d.createdBy === 'demo:crm')).toHaveLength(0);
    expect((await snapshotStore.listForTenantIndexed(tenantId)).length).toBe(0);
    expect((await activityStore.listForTenantIndexed(tenantId)).filter((a) => a.createdBy === 'demo:crm').length).toBe(0);
    expect((await stageHistoryStore.listForTenantIndexed(tenantId)).filter((r) => r.actor === 'demo:crm')).toHaveLength(0);
    expect((await listMergeEvents(tenantId)).filter((e) => e.actor === 'demo:crm')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoCrm(tenantId);
    expect(third.created).toBeGreaterThan(100);
  });

  it('is tenant-isolated: two tenants seed the same catalog without id collision', async () => {
    const a = 'demo-crm-iso-a', b = 'demo-crm-iso-b';
    await seedDemoPeople(a); await seedDemoPeople(b);
    // Both seeds must SUCCEED (the fixed ids used to make tenant B throw
    // "Company not found" on the shared crm:company store).
    expect((await seedDemoCrm(a)).created).toBeGreaterThan(100);
    expect((await seedDemoCrm(b)).created).toBeGreaterThan(100);
    // Distinct, tenant-scoped ids; each tenant sees only its own 75 contacts.
    expect(demoCrmCompanyId(a, 'harborview-hotels')).not.toBe(demoCrmCompanyId(b, 'harborview-hotels'));
    expect(await countDemoCrm(a)).toBeGreaterThanOrEqual(75);
    expect(await countDemoCrm(b)).toBeGreaterThanOrEqual(75);
    // Clearing A leaves B intact.
    await clearDemoCrm(a);
    expect(await countDemoCrm(a)).toBe(0);
    expect(await countDemoCrm(b)).toBeGreaterThanOrEqual(75);
  });
});
