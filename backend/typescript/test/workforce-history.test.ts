/**
 * The deterministic Workforce history generator (`src/host/workforceHistory.ts`),
 * which seeds the Workforce timeline (`host/workforceService.ts` history seed)
 * against the replay.md determinism contract: a seeded PRNG and a fixed logical
 * epoch, never the wall clock, so the same options are byte-identical on every
 * deploy and under the +1-year clock-shift lane.
 * Sabotages witnessed (/grade-tests 8f W5, 8fw5g6-wfh-*): a wall-clock or
 * unseeded PRNG, a run-count off by one, a shared event id within a run
 * (8fw5g6-wfh-event-id-r2), out-of-order timestamps, the open-approval tail, the
 * decision enum, a terminal run without `completedAt`, a flat override curve, a
 * zero / unsummed provider cost, and a seed that no longer varies placement.
 */
import { describe, expect, it } from 'vitest';
import {
  generateWorkforceHistory,
  type RunOutcome,
  type WorkforceHistoryOptions,
} from '../src/host/workforceHistory.js';

/** Read one named field off an event payload (typed `unknown` by the generator). */
function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null ? Reflect.get(payload, key) : undefined;
}

const BASE: WorkforceHistoryOptions = {
  workforceId: 'workforce.finance.invoice-exception',
  tenantId: 'demo',
  // An opaque id here; production passes `heroWorkflowId(w)` (workforceService.ts).
  workflowId: 'workforce.invoice-exception.hero',
  seed: 'ep0-fixed-seed',
  epochMs: 1_700_000_000_000, // fixed logical epoch — never the wall clock
  runCount: 240,
  weeks: 6,
};

describe('generateWorkforceHistory', () => {
  it('is byte-identical across re-runs (replay.md §C determinism)', () => {
    const a = generateWorkforceHistory(BASE);
    const b = generateWorkforceHistory(BASE);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('emits the requested number of runs', () => {
    const h = generateWorkforceHistory(BASE);
    expect(h.runs).toHaveLength(240);
    expect(h.stats.total).toBe(240);
  });

  it('every event carries its own eventId + timestamp (fixed history, replay.md L112)', () => {
    const h = generateWorkforceHistory(BASE);
    const everyId = new Set<string>();
    let total = 0;
    for (const run of h.runs) {
      // "its OWN" eventId: distinct within the run and across the whole history.
      expect(new Set(run.events.map((e) => e.eventId)).size, run.record.runId).toBe(run.events.length);
      for (const e of run.events) {
        everyId.add(e.eventId);
        total++;
        expect(e.eventId).toMatch(/^evt_/);
        expect(typeof e.timestamp).toBe('string');
        expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
        expect(e.runId).toBe(run.record.runId);
      }
      // first event is always run.started
      expect(run.events[0]?.type).toBe('run.started');
    }
    expect(everyId.size).toBe(total);
  });

  it('event timestamps are monotonically non-decreasing within a run', () => {
    const h = generateWorkforceHistory(BASE);
    for (const run of h.runs) {
      let prev = 0;
      for (const e of run.events) {
        const t = Date.parse(e.timestamp);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });

  it('leaves a non-empty open-approval queue at the head of the timeline', () => {
    const h = generateWorkforceHistory(BASE);
    const open = h.runs.filter((r) => r.record.status === 'waiting-approval');
    expect(open.length).toBeGreaterThan(0);
    expect(h.stats.openApprovals).toBe(open.length);
    for (const r of open) {
      // openwop#1742 — the protocol pair, not the v1-invalid kind-specific types.
      expect(r.events.some((e) => e.type === 'interrupt.requested')).toBe(true);
      expect(r.events.some((e) => e.type === 'interrupt.resolved')).toBe(false);
    }
  });

  it('approval decisions use the corpus enum granted | rejected | overridden (RFC 0183 §A.3)', () => {
    const h = generateWorkforceHistory(BASE);
    const allowed = new Set(['granted', 'rejected', 'overridden']);
    const decisions = h.runs.flatMap((r) => r.events)
      .filter((e) => e.type === 'interrupt.resolved')
      .map((e) => field(e.payload, 'decision'));
    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) expect(typeof d === 'string' && allowed.has(d), String(d)).toBe(true);
  });

  it('terminal runs are completed or failed and stamp completedAt', () => {
    const h = generateWorkforceHistory(BASE);
    let completed = 0;
    let failed = 0;
    for (const r of h.runs) {
      if (r.record.status === 'completed' || r.record.status === 'failed') {
        if (r.record.status === 'completed') completed++; else failed++;
        // completedAt is the run's last event (the generator's contract).
        expect(r.record.completedAt, r.record.runId).toBe(r.events[r.events.length - 1]?.timestamp);
      } else {
        expect(r.record.completedAt, `${r.record.runId} is ${r.record.status}`).toBeUndefined();
      }
    }
    // Positive control: both terminal statuses occur, so the loop asserted something.
    expect(completed).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);
  });

  it('override rate per run declines as the agent earns autonomy (the graduation curve)', () => {
    const h = generateWorkforceHistory(BASE);
    const third = Math.floor(h.runs.length / 3);
    // Per-run override rate (design: 8% → 4% → 2% across the 3 autonomy bands).
    // Measured per run, not conditioned on having an approval, so it tracks the
    // graduation curve robustly rather than amplifying small-sample noise.
    const overrideRate = (slice: typeof h.runs): number =>
      slice.filter((r) => r.record.metadata.outcome === 'overridden').length /
      Math.max(slice.length, 1);
    const early = overrideRate(h.runs.slice(0, third));
    const late = overrideRate(h.runs.slice(2 * third));
    expect(early).toBeGreaterThan(late);
  });

  it('produces provider.usage cost events on every run for the telemetry dashboard', () => {
    const h = generateWorkforceHistory(BASE);
    for (const r of h.runs) {
      const usage = r.events.filter((e) => e.type === 'provider.usage');
      expect(usage.length).toBeGreaterThan(0);
      let sum = 0;
      for (const u of usage) {
        const cost = field(u.payload, 'costEstimateUsd');
        if (typeof cost !== 'number') throw new Error(`${r.record.runId}: provider.usage without a numeric costEstimateUsd`);
        expect(cost).toBeGreaterThan(0);
        sum += cost;
      }
      // The run's metadata carries the summed cost the /metrics endpoint aggregates.
      expect(r.record.metadata.costUsd).toBeCloseTo(sum, 6);
    }
  });

  it('aggregate outcome distribution is seed-independent (clean curve every deploy)', () => {
    const a = generateWorkforceHistory(BASE);
    const b = generateWorkforceHistory({ ...BASE, seed: 'a-different-seed' });
    const sig = (h: ReturnType<typeof generateWorkforceHistory>): string =>
      (Object.keys(h.stats.byOutcome) as RunOutcome[])
        .map((k) => `${k}:${h.stats.byOutcome[k]}`)
        .join(',');
    // Counts are allocated by construction, so they match across seeds...
    expect(sig(a)).toEqual(sig(b));
    // ...but the seed still varies placement + ids (so it's not a constant).
    const order = (h: ReturnType<typeof generateWorkforceHistory>): string =>
      h.runs.map((r) => r.record.metadata.outcome).join(',');
    expect(order(a)).not.toEqual(order(b));
    expect(a.runs[0]?.record.runId).not.toEqual(b.runs[0]?.record.runId);
  });
});
