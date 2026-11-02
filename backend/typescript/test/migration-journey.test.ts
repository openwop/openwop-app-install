/**
 * Migration journey store (EP1 MG-0; CAS per ADR 0775 P4) — default shape,
 * merge-patch persistence, and tenant scoping (CTI-1).
 *
 * What breaks: a merge that rebuilds from defaults drops an earlier stage's
 * answers; a `!== undefined` check loosened to truthiness makes `null` unable to
 * clear a field; and a key without the tenant hands one tenant's data manifest
 * (data sources, sensitivity — financial PII) to another. The tenant lives in
 * TWO places — the collection's own key function and the read key — and they
 * must agree, so a probe has to move both (a read-only change just misses the
 * row and fails the write's CAS).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __clearMigrationJourneys,
  getMigrationJourney,
  patchMigrationJourney,
} from '../src/host/migrationService.js';
import { MIGRATION_STAGE_KEYS } from '../src/host/migrationJourney.js';

const WF = 'workforce.finance.invoice-exception';
const T = 'demo';

describe('migration journey', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearMigrationJourneys();
  });

  it('returns a default journey (all stages pending, nulls) when none exists', async () => {
    const j = await getMigrationJourney(T, WF);
    expect(j.workforceId).toBe(WF);
    expect(j.tenantId).toBe(T);
    expect(j.target).toBeNull();
    expect(j.dataManifest).toBeNull();
    expect(j.boundaries).toBeNull();
    for (const k of MIGRATION_STAGE_KEYS) {
      expect(j.stageStatus[k]).toBe('pending');
    }
  });

  it('merge-patches only the provided fields and persists', async () => {
    await patchMigrationJourney(T, WF, {
      target: { workflowId: 'wf.test.invoice-post', targetOutcome: 'clear exceptions in <1 day' },
      stageStatus: { target: 'done' },
    });
    // a second patch touches a different field; the first must survive
    await patchMigrationJourney(T, WF, {
      dataManifest: { dataSources: 'ERP, invoice inbox', sensitivity: 'financial PII', approvalModel: '>$5k → human' },
      stageStatus: { 'map-data': 'done' },
    });

    const j = await getMigrationJourney(T, WF);
    expect(j.target?.workflowId).toBe('wf.test.invoice-post');
    expect(j.dataManifest?.sensitivity).toBe('financial PII');
    expect(j.stageStatus.target).toBe('done');
    expect(j.stageStatus['map-data']).toBe('done');
    expect(j.stageStatus.assess).toBe('pending'); // untouched
  });

  it('supports clearing a field with null', async () => {
    await patchMigrationJourney(T, WF, { target: { workflowId: 'x', targetOutcome: 'y' } });
    await patchMigrationJourney(T, WF, { target: null });
    expect((await getMigrationJourney(T, WF)).target).toBeNull();
  });

  it('is tenant-scoped — one tenant cannot see another tenant journey (CTI-1)', async () => {
    await patchMigrationJourney('tenant-a', WF, {
      dataManifest: { dataSources: 'tenant-a ERP', sensitivity: 'financial PII', approvalModel: '>$5k' },
    });
    // Owner positive control: the row is really there for tenant-a, so tenant-b's
    // null below is isolation, not a write that never landed.
    expect((await getMigrationJourney('tenant-a', WF)).dataManifest?.dataSources).toBe('tenant-a ERP');
    const b = await getMigrationJourney('tenant-b', WF);
    expect(b.tenantId).toBe('tenant-b');
    expect(b.dataManifest).toBeNull(); // tenant-b sees a fresh journey, not tenant-a's content
  });
});
