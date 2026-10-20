/**
 * MyndHyve R7 — `OPENWOP_RETENTION_SWEEP_DRY_RUN=true` reports what each
 * destructive retention leg would delete, and deletes nothing:
 *  - a purger that declares `dryRun: 'rows-by-age'` is counted, and its delete
 *    callback is never called; one that does not declare it is never run and is
 *    reported `counted: false`; a held tenant is reported as held;
 *  - engine tables (ADR 0287), run retention (ADR 0371) and the anon-tenant
 *    teardown (ADR 0372) are counted from read-only queries;
 *  - in the daemon tick, a dry run wins over OPENWOP_RETENTION_SWEEP_ENABLED: no
 *    purger delete, no run deleted, no `governance.retention.purged` audit row,
 *    no lease. The same tick without the dry-run flag DOES delete (the control
 *    that shows the assertions can see a delete).
 *
 * Sabotage that turns it red: `purgeRowsByAge` ignoring the dry-run scope (the
 * delete callback runs); `countRetained` running an untagged purger; the tick's
 * `if (dryRun)` branch removed or placed after `processRetentionSweep`; the run
 * retention leg's `&& !dryRun` removed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  reportRetentionDryRun, startRetentionSweepDaemon,
} from '../src/host/retentionSweepDaemon.js';
import { countRetained, purgeRowsByAge, registerRetentionPurger, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { setGovernancePolicy, __resetGovernanceStore } from '../src/host/governanceService.js';
import { setRetentionHold } from '../src/host/retentionHold.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

let storage: Storage;
let rows: Array<{ id: string; tenantId: string; updatedAt: string }>;
const deleted: string[] = [];
let untaggedRan = 0;

function run(runId: string, status: RunRecord['status'], updatedDaysAgo: number): RunRecord {
  return {
    runId, workflowId: 'wf-1', tenantId: 't-dry', status,
    inputs: {}, metadata: {}, configurable: {},
    createdAt: iso(updatedDaysAgo + 1), updatedAt: iso(updatedDaysAgo),
  };
}

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetRetentionPurgers();
  await __resetGovernanceStore();
  deleted.length = 0;
  untaggedRan = 0;
  rows = [
    { id: 'a-old', tenantId: 'tenantA', updatedAt: iso(400) },
    { id: 'a-old2', tenantId: 'tenantA', updatedAt: iso(500) },
    { id: 'a-fresh', tenantId: 'tenantA', updatedAt: iso(5) },
    { id: 'b-old', tenantId: 'tenantB', updatedAt: iso(400) },
  ];
  registerRetentionPurger({
    feature: 'synthetic-rows-by-age',
    dryRun: 'rows-by-age',
    async purge(tenantId, classification, cutoffIso) {
      if (classification !== 'confidential-pii') return 0;
      return purgeRowsByAge('synthetic-rows-by-age', rows, tenantId, cutoffIso, (r) => r,
        async (id) => { deleted.push(id); rows = rows.filter((r) => r.id !== id); });
    },
  });
  registerRetentionPurger({
    feature: 'synthetic-untagged',
    async purge() { untaggedRan += 1; return 0; },
  });
});

afterEach(() => {
  for (const k of ['OPENWOP_RETENTION_SWEEP_DRY_RUN', 'OPENWOP_RETENTION_SWEEP_ENABLED', 'OPENWOP_RUN_RETENTION_DAYS', 'OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS', 'OPENWOP_ANON_TENANT_RETENTION_DAYS']) delete process.env[k];
});

describe('countRetained — the purger seam in count-only mode', () => {
  it('counts a rows-by-age purger without calling its delete, and never runs an untagged one', async () => {
    const out = await countRetained('tenantA', 'confidential-pii', iso(365));
    expect(out).toEqual([
      { feature: 'synthetic-rows-by-age', counted: true, wouldDelete: 2 },
      { feature: 'synthetic-untagged', counted: false },
    ]);
    expect(deleted).toEqual([]);
    expect(untaggedRan).toBe(0);
    expect(rows).toHaveLength(4);
  });

  it('a tenant under legal hold is reported as held', async () => {
    await setRetentionHold('tenantA', 'litigation');
    expect(await countRetained('tenantA', 'confidential-pii', iso(365)))
      .toEqual([{ feature: 'legal-hold', counted: false, error: 'legal_hold:litigation' }]);
  });
});

describe('reportRetentionDryRun — every leg, read-only', () => {
  it('reports governance slots, engine tables, run retention and anon tenants', async () => {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    await storage.insertRun(run('r-old', 'completed', 120));
    await storage.insertRun(run('r-old-running', 'running', 120));
    await storage.insertRun(run('r-new', 'completed', 2));
    process.env.OPENWOP_RUN_RETENTION_DAYS = '90';
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '30';

    const r = await reportRetentionDryRun({ storage }, NOW);
    expect(r.governance).toHaveLength(1);
    expect(r.governance[0]).toMatchObject({ tenantId: 'tenantA', classification: 'confidential-pii' });
    expect(r.governance[0]!.purgers.find((p) => p.feature === 'synthetic-rows-by-age')?.wouldDelete).toBe(2);
    expect(r.engine).toEqual({ terminalRuns: 1, webhookDeliveries: null });
    expect(r.runRetention).not.toBeNull();
    expect(r.anonTenants).toEqual({ candidates: 0, held: 0 });
    // Nothing was deleted.
    expect(rows).toHaveLength(4);
    expect(await storage.getRun('r-old')).not.toBeNull();
  });

  it('a leg whose knob is off is reported as null, not as zero', async () => {
    const r = await reportRetentionDryRun({ storage }, NOW);
    expect(r).toEqual({ governance: [], engine: { terminalRuns: null, webhookDeliveries: null }, runRetention: null, anonTenants: null });
  });
});

describe('the daemon tick under OPENWOP_RETENTION_SWEEP_DRY_RUN', () => {
  async function seedAndTick(): Promise<void> {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    await storage.insertRun(run('r-old', 'completed', 120));
    process.env.OPENWOP_RETENTION_SWEEP_ENABLED = 'true';
    process.env.OPENWOP_RUN_RETENTION_DAYS = '90';
    const daemon = startRetentionSweepDaemon({ storage });
    try { await daemon.tickNow(); } finally { daemon.stop(); }
  }

  it('dry run: deletes nothing and writes no purge audit row, even with the sweep enabled', async () => {
    process.env.OPENWOP_RETENTION_SWEEP_DRY_RUN = 'true';
    await seedAndTick();
    expect(deleted).toEqual([]);
    expect(untaggedRan).toBe(0);
    expect(await storage.getRun('r-old')).not.toBeNull();
    expect(await storage.listAudit({ actionPrefix: 'governance.retention.purged' })).toEqual([]);
  });

  it('control: the same tick without the dry run deletes', async () => {
    await seedAndTick();
    expect(deleted.sort()).toEqual(['a-old', 'a-old2']);
    expect(untaggedRan).toBeGreaterThan(0);
    expect(await storage.getRun('r-old')).toBeNull();
    expect((await storage.listAudit({ actionPrefix: 'governance.retention.purged' })).length).toBeGreaterThan(0);
  });
});
