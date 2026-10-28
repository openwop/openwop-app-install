/**
 * MyndHyve R7 — `OPENWOP_RETENTION_SWEEP_DRY_RUN=true` reports what each
 * destructive retention leg would delete, and deletes nothing:
 *  - a purger that declares `dryRun: 'rows-by-age'` is counted, and its delete
 *    callback is never called; one that does not declare it is never run and is
 *    reported `counted: false`; a held tenant is reported as held;
 *  - engine tables (ADR 0287), run retention (ADR 0371) and the anon-tenant
 *    teardown (ADR 0372) are counted from read-only queries;
 *  - in the daemon tick, a dry run wins over OPENWOP_RETENTION_SWEEP_ENABLED: no
 *    purger delete, no run deleted (neither by the ADR 0287 engine prune nor by
 *    the ADR 0371 run-retention leg), no `governance.retention.purged` audit row,
 *    no slot lease. The same tick without the dry-run flag DOES delete, and DOES
 *    take the lease (the control that shows each assertion can see the effect).
 *
 * Fixture note (wave 64): `r-stamped` is the only run the ADR 0371 leg can see.
 * `insertRun` never writes `removalAt` (only `updateRun` does), so the run is
 * stamped through `updateRun`; it is fresh, so the 90-day engine prune cannot
 * reach it. Before this, no run had a stamp and the leg's `&& !dryRun` guard
 * could be deleted with every case green (probe 8fw5g2-rd-run-leg, vacuous).
 *
 * Sabotage that turns it red: `purgeRowsByAge` ignoring the dry-run scope (the
 * delete callback runs); `countRetained` running an untagged purger; the tick's
 * `if (dryRun)` branch removed or placed after `processRetentionSweep`; the run
 * retention leg's `&& !dryRun` removed; the report's run-retention or anon
 * counts wrong.
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
const LEASE_CLASSIFICATION = 'confidential-pii';
const NOW = Date.now();
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

let storage: Storage;
let rows: Array<{ id: string; tenantId: string; updatedAt: string }>;
const deleted: string[] = [];
let untaggedRan = 0;

function run(runId: string, status: RunRecord['status'], updatedDaysAgo: number, tenantId = 't-dry'): RunRecord {
  return {
    runId, workflowId: 'wf-1', tenantId, status,
    inputs: {}, metadata: {}, configurable: {},
    createdAt: iso(updatedDaysAgo + 1), updatedAt: iso(updatedDaysAgo),
  };
}

/** A completed run that ONLY the ADR 0371 run-retention leg can delete: fresh
 *  (outside the engine prune's window), with a removal stamp already past. */
async function seedStampedRun(): Promise<void> {
  await storage.insertRun(run('r-stamped', 'completed', 2));
  await storage.updateRun('r-stamped', { removalAt: iso(1) });
}

/** Whether the tick took tenantA's retention slot lease. `claimOnce` reports an
 *  existing key; a fresh claim means no lease was written. Checked for the day
 *  slot on both sides of the tick, so a UTC-midnight crossing cannot hide it. */
async function leaseTaken(slots: readonly number[]): Promise<boolean> {
  let taken = false;
  for (const slot of new Set(slots)) {
    const c = await storage.claimOnce(`retention-sweep:tenantA:${LEASE_CLASSIFICATION}:${slot}`, new Date().toISOString());
    if (!c.claimed) taken = true;
  }
  return taken;
}

beforeEach(async () => {
  delete process.env.OPENWOP_RUN_RETENTION_WINDOW;
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
  for (const k of ['OPENWOP_RETENTION_SWEEP_DRY_RUN', 'OPENWOP_RETENTION_SWEEP_ENABLED', 'OPENWOP_RUN_RETENTION_DAYS', 'OPENWOP_WEBHOOK_DELIVERY_RETENTION_DAYS', 'OPENWOP_ANON_TENANT_RETENTION_DAYS', 'OPENWOP_RUN_RETENTION_WINDOW']) delete process.env[k];
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
    await seedStampedRun();
    // Two abandoned anon tenants (last human run 60 days ago, cutoff 30), one held:
    // an asymmetric fixture, so a wrong `held` count cannot equal the right one.
    await storage.insertRun(run('r-anon-held', 'completed', 59, 'anon:held'));
    await storage.insertRun(run('r-anon-free', 'completed', 59, 'anon:free'));
    await setRetentionHold('anon:held', 'litigation');
    process.env.OPENWOP_RUN_RETENTION_DAYS = '90';
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '30';

    const r = await reportRetentionDryRun({ storage }, NOW);
    expect(r.governance).toHaveLength(1);
    expect(r.governance[0]).toMatchObject({ tenantId: 'tenantA', classification: 'confidential-pii' });
    expect(r.governance[0]!.purgers.find((p) => p.feature === 'synthetic-rows-by-age')?.wouldDelete).toBe(2);
    expect(r.engine).toEqual({ terminalRuns: 1, webhookDeliveries: null });
    expect(r.runRetention).toEqual({ candidates: 1, capped: false });
    expect(r.anonTenants).toEqual({ candidates: 2, held: 1 });
    // Nothing was deleted.
    expect(rows).toHaveLength(4);
    expect(await storage.getRun('r-old')).not.toBeNull();
    expect(await storage.getRun('r-stamped')).not.toBeNull();
  });

  it('a leg whose knob is off is reported as null, not as zero', async () => {
    const r = await reportRetentionDryRun({ storage }, NOW);
    expect(r).toEqual({ governance: [], engine: { terminalRuns: null, webhookDeliveries: null }, runRetention: null, anonTenants: null });
  });
});

describe('the daemon tick under OPENWOP_RETENTION_SWEEP_DRY_RUN', () => {
  /** Seeds, ticks once, and returns the day slots the tick could have used. */
  async function seedAndTick(): Promise<number[]> {
    await setGovernancePolicy('tenantA', { retention: { confidentialPiiDays: 365 } });
    await storage.insertRun(run('r-old', 'completed', 120));
    await seedStampedRun();
    process.env.OPENWOP_RETENTION_SWEEP_ENABLED = 'true';
    process.env.OPENWOP_RUN_RETENTION_DAYS = '90';
    const before = Math.floor(Date.now() / DAY);
    const daemon = startRetentionSweepDaemon({ storage });
    try { await daemon.tickNow(); } finally { daemon.stop(); }
    return [before, Math.floor(Date.now() / DAY)];
  }

  it('dry run: deletes nothing and writes no purge audit row, even with the sweep enabled', async () => {
    process.env.OPENWOP_RETENTION_SWEEP_DRY_RUN = 'true';
    const slots = await seedAndTick();
    expect(deleted).toEqual([]);
    expect(untaggedRan).toBe(0);
    expect(await storage.getRun('r-old')).not.toBeNull();
    expect(await storage.getRun('r-stamped')).not.toBeNull();
    expect(await storage.listAudit({ actionPrefix: 'governance.retention.purged' })).toEqual([]);
    expect(await leaseTaken(slots)).toBe(false);
  });

  it('control: the same tick without the dry run deletes', async () => {
    const slots = await seedAndTick();
    expect(deleted.sort()).toEqual(['a-old', 'a-old2']);
    expect(untaggedRan).toBeGreaterThan(0);
    expect(await storage.getRun('r-old')).toBeNull();
    expect(await storage.getRun('r-stamped')).toBeNull();
    expect(await leaseTaken(slots)).toBe(true);
    expect((await storage.listAudit({ actionPrefix: 'governance.retention.purged' })).length).toBeGreaterThan(0);
  });
});
