/**
 * Integration test for the Workforce host-ext service + demo seeding
 * (`src/host/workforceService.ts`, Workforce EP0 §3 telemetry + EP1 MG-5 shadow
 * eval, RFC 0081 `live-shadow` shape) against an in-memory sqlite storage.
 *
 * What breaks it: a seed that is not idempotent (entities, per-tenant history, the
 * self-healing showcase), a seed that aborts when the backend has no annotations
 * store, an aggregator that counts another workforce's runs, a trace search whose
 * empty query matches or whose cap drops rows without `capped`, or a shadow eval
 * that leaks a raw outcome value. The seed is deterministic (seed string per
 * tenant+workforce, fixed `NOW`), so the aggregates are pinned as exact numbers
 * measured from that seed — never recomputed with the aggregator under test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  __clearWorkforces,
  aggregateAutonomyGraduation,
  aggregateGovernancePosture,
  aggregateShadowEval,
  aggregateWorkforceMetrics,
  getWorkforce,
  listWorkforces,
  searchWorkforceTrace,
  seedShowcaseWorkforces,
  seedWorkforceEntities,
  seedWorkforceHistory,
  SHOWCASE_TENANT,
} from '../src/host/workforceService.js';
import type { Storage } from '../src/storage/storage.js';

const HERO = 'workforce.finance.invoice-exception';
const NOW = 1_700_000_000_000;

describe('workforceService', () => {
  let storage: Storage;

  beforeEach(async () => {
    storage = openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    await __clearWorkforces();
  });

  it('seedShowcaseWorkforces: seeds the showcase, is idempotent on completeness, and self-heals a partial', async () => {
    // All five workforces are instrumented now; the showcase total is the sum
    // of their historyRunCount.
    const TOTAL = 300 + 220 + 160 + 280 + 130; // 1090
    const count = async () =>
      (await storage.listRuns({ tenantId: SHOWCASE_TENANT, limit: 5000 })).filter(
        (r) => (r.metadata as { workforceId?: string }).workforceId,
      ).length;

    const first = await seedShowcaseWorkforces(storage, NOW);
    expect(first.healed).toBe(true);
    expect(first.runs).toBe(TOTAL);
    expect(await count()).toBe(TOTAL);

    // already complete → cheap no-op, no extra runs
    const second = await seedShowcaseWorkforces(storage, NOW);
    expect(second.healed).toBe(false);
    expect(await count()).toBe(TOTAL);

    // simulate an interrupted/partial seed → next call clears + reseeds to full
    const partial = (await storage.listRuns({ tenantId: SHOWCASE_TENANT, limit: 5000 })).slice(0, 60);
    for (const r of partial) await storage.deleteRun(r.runId);
    expect(await count()).toBe(TOTAL - 60);
    const third = await seedShowcaseWorkforces(storage, NOW);
    expect(third.healed).toBe(true);
    expect(await count()).toBe(TOTAL);
  });

  it('seeds the hero workforce entity idempotently', async () => {
    const first = await seedWorkforceEntities();
    expect(first).toBe(5);
    const second = await seedWorkforceEntities();
    expect(second).toBe(0); // already present

    const wf = await getWorkforce('demo', HERO);
    expect(wf?.name).toBe('Invoice Exception Workforce');
    expect(wf?.agents.some((a) => a.role === 'supervisor')).toBe(true);
    expect((await listWorkforces('demo')).length).toBeGreaterThan(0);
  });

  it('seeds history runs + event logs into the tenant', async () => {
    await seedWorkforceEntities();
    const res = await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 40 });
    expect(res.runs).toBe(40 * 5); // runCount applies per instrumented workforce (5 of them)

    const runs = await storage.listRuns({ tenantId: 'demo', limit: 1000 });
    const heroRuns = runs.filter(
      (r) => (r.metadata as { workforceId?: string }).workforceId === HERO,
    );
    expect(heroRuns.length).toBe(40);

    // every run has an event log starting with run.started
    const sample = heroRuns[0]!;
    const events = await storage.listEvents(sample.runId);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe('run.started');
    // appendEvent assigned monotone, strictly-increasing sequences
    for (let k = 1; k < events.length; k++) {
      expect(events[k]!.sequence).toBeGreaterThan(events[k - 1]!.sequence);
    }

    // the approval queue is non-empty (open runs at the head)
    const open = runs.filter((r) => r.status === 'waiting-approval');
    expect(open.length).toBeGreaterThan(0);
  });

  it('history seeding is idempotent per tenant', async () => {
    await seedWorkforceEntities();
    const a = await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 20 });
    expect(a.runs).toBe(20 * 5); // 5 instrumented workforces
    const b = await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 20 });
    expect(b.runs).toBe(0); // already seeded for this tenant
  });

  it('does not write history when only entities are seeded (anon-safe path)', async () => {
    await seedWorkforceEntities();
    // The tenants a history seed WOULD write to — the demo tenant and the showcase —
    // must hold no runs at all after an entity-only seed.
    for (const tenantId of ['demo', SHOWCASE_TENANT, 'anon:xyz']) {
      expect(await storage.listRuns({ tenantId, limit: 100 }), tenantId).toHaveLength(0);
    }
    // Positive control: the same read sees a history seed, so the empty reads above
    // are not an unreadable tenant.
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 2 });
    expect(await storage.listRuns({ tenantId: 'demo', limit: 100 })).toHaveLength(10);
  });

  it('seeds all runs even when the backend has no annotations store (best-effort; live-Postgres shape)', async () => {
    await seedWorkforceEntities();
    // Simulate a deploy whose schema omits the annotations table — insertAnnotation
    // throws, exactly as the live Postgres backend did (relation "annotations" does not exist).
    // Only `false-positive` runs carry an annotation, and 40 runs per workforce held
    // none, so the failing store was never called and this case could not fail
    // (probe `8fw5g4-wfs-annot`, vacuous in round 1). 300 runs does reach it, and the
    // call counter below proves the failure path actually ran.
    let annotationCalls = 0;
    storage.insertAnnotation = async () => {
      annotationCalls += 1;
      throw new Error('relation "annotations" does not exist');
    };
    const res = await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    expect(annotationCalls, 'the missing-annotations path must actually be exercised').toBeGreaterThan(0);
    // Skip on first failure, don't retry: at most one failed call per workforce.
    expect(annotationCalls).toBeLessThanOrEqual(5);
    expect(res.runs).toBe(300 * 5); // 5 instrumented workforces; runs + events persisted despite annotation failures
    const mine = (await storage.listRuns({ tenantId: 'demo', limit: 5000 })).filter(
      (r) => (r.metadata as { workforceId?: string }).workforceId === HERO,
    );
    expect(mine).toHaveLength(300);
  });

  it('aggregates the 8 telemetry metrics from seeded runs (no event fan-out)', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });

    const m = aggregateWorkforceMetrics(runs, HERO);
    // Exact values from the deterministic seed (seed `demo:<workforce>`, fixed NOW),
    // measured once (grade-tests wave 64) — never recomputed with the aggregator.
    expect(m.totalRuns).toBe(300);
    expect(m.openApprovals).toBe(8);
    expect(m.terminalRuns).toBe(292);
    expect(m.cycleTimeP50Ms).toBe(30990);
    expect(m.costPerClearedUsd).toBeCloseTo(0.006478, 6);
    expect(m.overrideRate).toBeCloseTo(0.2414, 4);
    expect(m.escalationRate).toBeCloseTo(0.1933, 4);

    // weekly override rate trends DOWN across the window (the graduation curve)
    expect(m.weekly.map((w) => Number(w.overrideRate.toFixed(4)))).toEqual([0.2667, 0.3636, 0.375, 0.125, 0, 0.1538]);
    expect(m.weekly[0]!.overrideRate).toBeGreaterThan(m.weekly[m.weekly.length - 1]!.overrideRate);
  });

  it('scopes metrics to the requested workforce only', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 20 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });
    const other = aggregateWorkforceMetrics(runs, 'workforce.nonexistent');
    expect(other.totalRuns).toBe(0);
  });

  it('derives the autonomy graduation timeline (review → guided → auto)', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });

    const g = aggregateAutonomyGraduation(runs, HERO);
    // initial tier + two promotions across the 6-week window
    expect(g.milestones.length).toBe(3);
    expect(g.milestones[0]!.fromTier).toBeNull();
    expect(g.milestones.map((m) => m.toTier)).toEqual(['review', 'guided', 'auto']);
    expect(g.currentTier).toBe('auto');
    expect(g.nextTier).toBeNull(); // fully graduated

    // each promotion's prior-window override incidence cleared the bar it unlocked
    for (const m of g.milestones.slice(1)) {
      expect(m.overrideIncidenceBefore).not.toBeNull();
      expect(m.unlockThreshold).not.toBeNull();
      expect(m.overrideIncidenceBefore!).toBeLessThanOrEqual(m.unlockThreshold!);
    }
  });

  it('summarizes governance posture with recent events', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });

    const p = aggregateGovernancePosture(runs, HERO);
    expect(p.totalRuns).toBe(300);
    expect(p.overrides).toBe(14);
    expect(p.escalations).toBe(58);
    expect(p.recentEvents).toHaveLength(8); // the cap: more than 8 qualifying events exist
    // events carry a runId + a known kind
    for (const e of p.recentEvents) {
      expect(e.runId).toBeTruthy();
      expect(['override', 'false-positive', 'recovery']).toContain(e.kind);
    }
    // recent events are newest-first
    for (let i = 1; i < p.recentEvents.length; i++) {
      expect(Date.parse(p.recentEvents[i - 1]!.atIso)).toBeGreaterThanOrEqual(Date.parse(p.recentEvents[i]!.atIso));
    }
  });

  it('cross-run trace search: batchId matches multiple runs, correlationId one', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });
    const sample = runs.find((r) => (r.metadata as { workforceId?: string }).workforceId === HERO)!;
    const meta = sample.metadata as { correlationId: string; batchId: string };

    // batchId groups runs started the same day → cross-run (>= 1, usually many)
    const byBatch = searchWorkforceTrace(runs, HERO, meta.batchId);
    expect(byBatch.matches.length).toBeGreaterThan(0);
    expect(byBatch.matches.every((m) => m.batchId === meta.batchId)).toBe(true);

    // correlationId is unique → exactly one run
    const byCorr = searchWorkforceTrace(runs, HERO, meta.correlationId);
    expect(byCorr.matches).toHaveLength(1);
    expect(byCorr.matches[0]!.runId).toBe(sample.runId);
  });

  it('trace search: empty query returns nothing; outcome filter works; cap is explicit', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });

    expect(searchWorkforceTrace(runs, HERO, '   ').matches).toHaveLength(0);

    // Uncapped first: how many overridden runs this workforce really has.
    const all = searchWorkforceTrace(runs, HERO, 'overridden', 5000);
    expect(all.capped).toBe(false);
    expect(all.matches).toHaveLength(14);
    expect(all.matches.every((m) => m.outcome === 'overridden')).toBe(true);
    // Capped at 5: exactly 5 returned, and the truncation is FLAGGED, not silent.
    const overrides = searchWorkforceTrace(runs, HERO, 'overridden', 5);
    expect(overrides.matches).toHaveLength(5);
    expect(overrides.matches.every((m) => m.outcome === 'overridden')).toBe(true);
    expect(overrides.capped).toBe(true);
    expect(overrides.scanned).toBe(300);
  });

  it('seeds five starter workforces; all are instrumented with history', async () => {
    const created = await seedWorkforceEntities();
    expect(created).toBe(5);
    const all = await listWorkforces('demo');
    expect(all.map((w) => w.workforceId).sort()).toEqual(
      [
        'workforce.finance.invoice-exception',
        'workforce.fulfillment.order-exception',
        'workforce.insurance.claims-review',
        'workforce.procurement.approval',
        'workforce.support.escalation-triage',
      ].sort(),
    );

    // All five carry historyRunCount > 0; the per-call override caps each at 10
    // for speed, so 5 workforces × 10 = 50 runs.
    const res = await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 10 });
    expect(res.workforces).toBe(5);
    expect(res.runs).toBe(50);

    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });
    const byWf = (id: string): number =>
      runs.filter((r) => (r.metadata as { workforceId?: string }).workforceId === id).length;
    expect(byWf(HERO)).toBe(10);
    expect(byWf('workforce.support.escalation-triage')).toBe(10); // now instrumented too
  });

  it('shadow eval (RFC 0081 live-shadow shape): content-free finding digests, no raw values', async () => {
    await seedWorkforceEntities();
    await seedWorkforceHistory(storage, 'demo', { nowMs: NOW, runCount: 300 });
    const runs = await storage.listRuns({ tenantId: 'demo', limit: 5000 });

    const c = aggregateShadowEval(runs, HERO);
    expect(c.mode).toBe('live-shadow'); // RFC 0081 vocabulary
    expect(c.status).toBe('pass');
    expect(c.aggregateScore).toBeCloseTo(0.9408, 4);
    expect(c.passed).toBe(true); // EvalSummary.passed — 0.9408 clears the 0.9 bar
    expect(c.divergenceCount).toBe(17);
    expect(c.findings).toHaveLength(17); // under the 20-finding limit, so all are listed

    for (const d of c.findings) {
      // digests differ (that IS the divergence) and are sha256-prefixed
      expect(d.agentDigest).toMatch(/^sha256:/);
      expect(d.baselineDigest).toMatch(/^sha256:/);
      expect(d.agentDigest).not.toBe(d.baselineDigest);
    }
    // content-free: the serialized findings carry NO raw outcome value
    const blob = JSON.stringify(c.findings);
    expect(blob).not.toMatch(/overridden|false-positive|cleared/);
  });

  it('shadow eval is pending for a workforce with no runs', async () => {
    const c = aggregateShadowEval([], 'workforce.nonexistent');
    expect(c.status).toBe('pending');
    expect(c.passed).toBe(false);
    expect(c.findings).toHaveLength(0);
  });
});
