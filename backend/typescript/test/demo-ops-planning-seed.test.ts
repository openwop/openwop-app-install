/**
 * `demo-ops-planning` round-trip (app-seeding-strategy.md §4 Phase 10).
 *
 * The connective tissue + exec demo: strategies with live-metric KRs, projects +
 * kanban, priority-matrix, CSM accounts, the Iris assistant graph, and a
 * strategy-bound advisory board — seeded idempotently and cleared clean.
 *
 * TST-CUE-7. Red when a re-seed re-creates CSM accounts, or when a seeded account's
 * stored health score is not the weighted mean of the factors stamped beside it
 * (R2 CS-SP-4 — the service only requires a score to ACCOMPANY factors, so the
 * agreement is checked here, recomputed from the stored factors).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoOpsPlanning, clearDemoOpsPlanning, countDemoOpsPlanning } from '../src/host/demoOpsPlanningSeed.js';
import { listStrategies } from '../src/features/strategy/strategyService.js';
import { listProjects } from '../src/features/projects/projectsService.js';
import { listLists } from '../src/features/priority-matrix/priorityMatrixService.js';
import { listAccounts } from '../src/features/csm/accountsService.js';
import { listStakeholders, listCommitments, listMeetings, listPendingActions } from '../src/features/assistant/assistantService.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };
/** Counts on a fresh tenant — MEASURED 2026-10-29 (the seed tables are not exported). */
const MEASURED = { created: 22, stakeholders: 8, commitments: 12 };

let storage: Awaited<ReturnType<typeof openStorage>>;
const isDemoPayload = (p: unknown): boolean => typeof p === 'object' && p !== null && 'demo' in p && p.demo === true;

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-ops-')) });
  for (const id of ['crm', 'strategy', 'priority-matrix', 'csm', 'advisory-board']) {
    registerToggleDefault({ id, salt: id, ...ON });
  }
});

describe('demo-ops-planning seeder', () => {
  it('seeds strategy/projects/priority/csm/assistant, idempotent; clears clean', async () => {
    const tenantId = 'demo-ops-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);

    const first = await seedDemoOpsPlanning(tenantId);
    expect(first.created).toBe(MEASURED.created);

    // Strategy with a live-metric-bound KR.
    const strategies = (await listStrategies(tenantId, { includeArchived: true })).filter((s) => s.createdBy === 'demo:ops-planning');
    expect(strategies).toHaveLength(2);
    expect(strategies.some((s) => s.objectives.some((o) => o.keyResults.some((k) => k.measure?.source?.kind === 'commerce-revenue')))).toBe(true);

    // Projects + priority-matrix + CSM.
    expect((await listProjects(tenantId)).filter((p) => ['Storefront Revamp', 'Wholesale Expansion Program', 'Subscription Growth', 'Q4 Holiday Campaign', 'Roastery Capacity'].includes(p.name))).toHaveLength(5);
    expect((await listLists(tenantId)).filter((l) => l.createdBy === 'demo:ops-planning')).toHaveLength(2);
    const seededAccounts = (await listAccounts(tenantId)).filter((a) => a.crmRef?.companyId?.startsWith('cmp:demo-crm-'));
    expect(seededAccounts).toHaveLength(10);
    // R2 CS-SP-4 — the seed's factor write must SURVIVE the fail-closed
    // factors⇒score rule (a count-only assertion let a swallowed
    // validation_error silently hollow out the computed-stamp demo).
    for (const a of seededAccounts) {
      expect(a.healthFactors, a.name).toBeDefined();
      expect(a.healthComputedAt, a.name).toBeDefined();
      // the stamped score IS the weighted mean of the stamped factors (independent arithmetic)
      const f = a.healthFactors ?? [];
      const totalWeight = f.reduce((n, x) => n + x.weight, 0);
      expect(totalWeight, a.name).toBeGreaterThan(0);
      expect(a.healthScore, a.name).toBe(Math.round(f.reduce((n, x) => n + x.weight * x.value, 0) / totalWeight));
    }

    // Assistant graph (stakeholders / commitments / meetings / 3 pending).
    expect((await listStakeholders(tenantId)).length).toBe(MEASURED.stakeholders);
    expect((await listCommitments(tenantId)).filter((c) => c.source?.externalId?.startsWith('demo-ops-')).length).toBe(MEASURED.commitments);
    expect((await listMeetings(tenantId)).filter((m) => m.calendarEventId?.startsWith('demo-ops-'))).toHaveLength(6);
    expect((await listPendingActions(tenantId)).filter((a) => isDemoPayload(a.payload))).toHaveLength(3);

    // Idempotent re-seed.
    const before = await countDemoOpsPlanning(tenantId);
    const second = await seedDemoOpsPlanning(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoOpsPlanning(tenantId)).toBe(before);

    // Clear.
    await clearDemoOpsPlanning(tenantId, storage);
    expect(await countDemoOpsPlanning(tenantId)).toBe(0);
    expect((await listProjects(tenantId)).filter((p) => p.name === 'Storefront Revamp')).toHaveLength(0);
    expect((await listAccounts(tenantId)).filter((a) => a.crmRef?.companyId?.startsWith('cmp:demo-crm-'))).toHaveLength(0);
    expect((await listPendingActions(tenantId)).filter((a) => isDemoPayload(a.payload))).toHaveLength(0);
    expect((await listCommitments(tenantId)).filter((c) => c.source?.externalId?.startsWith('demo-ops-'))).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoOpsPlanning(tenantId);
    expect(third.created).toBe(MEASURED.created);
  });
});
