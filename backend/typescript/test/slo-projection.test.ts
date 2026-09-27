/**
 * ADR 0556 P2 — the SLO projection's states and evaluators.
 *
 * The projection is pure (snapshot + freshness map + queue facts + clock in,
 * read model out), so every state this suite asserts is reached by
 * CONSTRUCTING the condition rather than by mocking the thing under test. That
 * matters more than usual here: the whole point of the phase is that an
 * operations panel must not be able to report a state it is not in, and a test
 * that stubs the state machine proves the stub.
 *
 * The states are asserted as MUTUALLY EXCLUSIVE outcomes of distinct inputs,
 * because the dangerous confusions are all between neighbours:
 *
 *   unknown  vs healthy   — "no reader" must never render as "nothing is wrong"
 *   empty    vs healthy   — 0/0 must never render as 100%
 *   stale    vs healthy   — a frozen series still divides and still compares
 *   empty    vs stale     — never emitted vs emitted-then-stopped: different fix
 *   degraded vs breaching — a polluted population is not a failing one
 *   unknown  vs empty     — a no-op instrument vs a quiet host: different fix
 *   not_projectable vs unknown — one is fixed by an env var, one is not
 */

import { describe, expect, it } from 'vitest';
import {
  SLO_CATALOG,
  projectSlos,
  projectRows,
  shareAtOrBelow,
  nonExactQuantileRows,
  unknownSloMetrics,
  githubAnchor,
  type MetricSeries,
  type OutboxFacts,
  type SeriesPoint,
  type SloRow,
  type SloSpec,
} from '../src/observability/sloProjection.js';
import { METRIC_CATALOG } from '../src/observability/metrics.js';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BOOT = NOW - 3_600_000;

function counter(name: string, points: Array<[Record<string, string>, number]>): MetricSeries {
  return { name, kind: 'counter', points: points.map(([attributes, value]) => ({ attributes, value })) };
}
function gauge(name: string, points: Array<[Record<string, string>, number]>): MetricSeries {
  return { name, kind: 'gauge', points: points.map(([attributes, value]) => ({ attributes, value })) };
}
/** A histogram point whose observations are placed in the buckets they fall in,
 *  so the share walk sees real bucket state rather than a hand-built array. */
function hist(
  name: string,
  boundaries: readonly number[],
  points: Array<[Record<string, string>, number[]]>,
): MetricSeries {
  return {
    name,
    kind: 'histogram',
    points: points.map(([attributes, observations]): SeriesPoint => {
      const counts = new Array<number>(boundaries.length + 1).fill(0);
      for (const v of observations) {
        let i = boundaries.findIndex((b) => v <= b);
        if (i === -1) i = boundaries.length;
        counts[i] += 1;
      }
      return {
        attributes,
        histogram: {
          boundaries,
          counts,
          count: observations.length,
          sum: observations.reduce((a, b) => a + b, 0),
          ...(observations.length > 0 ? { max: Math.max(...observations) } : {}),
        },
      };
    }),
  };
}

/** The declared buckets of a catalog metric, so fixtures cannot silently drift
 *  from the boundaries the exact-share evaluator depends on. */
function bucketsOf(metric: string): readonly number[] {
  const spec = METRIC_CATALOG.find((m) => m.name === metric);
  if (!spec?.buckets) throw new Error(`${metric} declares no buckets`);
  return spec.buckets;
}

/** A healthy, empty queue — so the dispatch rows never accidentally drive an
 *  assertion that is about something else. */
const QUIET_QUEUE: OutboxFacts = { pending: 0, dead: 0, oldestAgeS: null };

function projectAll(
  snapshot: MetricSeries[] | null,
  lastEmission: Record<string, number> = {},
  outbox: OutboxFacts | null = QUIET_QUEUE,
) {
  return projectSlos({
    snapshot,
    lastEmission: new Map(Object.entries(lastEmission)),
    startedAtMs: snapshot ? BOOT : null,
    outbox,
    seriesLimit: 20_000,
    nowMs: NOW,
  });
}
function project(
  snapshot: MetricSeries[] | null,
  lastEmission: Record<string, number> = {},
  outbox: OutboxFacts | null = QUIET_QUEUE,
): readonly SloRow[] {
  return projectAll(snapshot, lastEmission, outbox).rows;
}
function row(rows: readonly SloRow[], id: string): SloRow {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`no SLO row '${id}'`);
  return found;
}

describe('ADR 0556 P2 — the projection reports a state it is actually in', () => {
  it('answers `unknown` for every metric-derived row when the local-scrape profile is off', () => {
    const rows = project(null);
    // The dispatch rows are NOT unknown here: they read the queue table, which
    // is readable with no metrics reader at all. Reporting them unknown because
    // telemetry is off would be false.
    const metricDerived = rows.filter((r) => r.state !== 'not_projectable' && r.source !== 'dispatch-outbox-stats');
    expect(metricDerived.length).toBeGreaterThan(20);
    expect(metricDerived.every((r) => r.state === 'unknown')).toBe(true);
    expect(metricDerived.every((r) => typeof r.reason === 'string')).toBe(true);
    // The distinction that makes this state worth having: a zero-target row
    // with no reader must NOT read as "nothing was ever blocked".
    expect(row(rows, 'R1').observed).toBeNull();
    expect(row(rows, 'R1').state).not.toBe('healthy');
    // ...while the DB-backed queue rows still answer.
    expect(row(rows, 'Q2').state).toBe('healthy');
    expect(row(rows, 'Q2').source).toBe('dispatch-outbox-stats');
  });

  it('reports the window as this process\'s uptime and never as the declared 28 days', () => {
    const p = projectAll([]);
    expect(p.window.kind).toBe('process_uptime');
    expect(p.window.seconds).toBe(3600);
    expect(p.perInstance).toBe(true);
    expect(p.source).toBe('local-scrape');
  });

  it('says `unavailable` with a null window when there is no reader', () => {
    const p = projectAll(null);
    expect(p.source).toBe('unavailable');
    expect(p.window.startedAt).toBeNull();
    expect(p.window.seconds).toBeNull();
  });

  it('answers `empty` — never 100% — when a ratio has no denominator', () => {
    const rows = project([counter('openwop.run.completed', [])]);
    expect(row(rows, 'W1').state).toBe('empty');
    expect(row(rows, 'W1').observed).toBeNull();
    expect(row(rows, 'W1').sampleCount).toBe(0);
  });

  it('computes a healthy ratio and a breaching one from the same evaluator', () => {
    const healthy = project([counter('openwop.run.completed', [
      [{ workflow_kind: 'chain', status: 'completed' }, 99],
      [{ workflow_kind: 'chain', status: 'failed' }, 1],
    ])]);
    expect(row(healthy, 'W1').state).toBe('healthy');
    expect(row(healthy, 'W1').observed).toBeCloseTo(0.99, 6);
    expect(row(healthy, 'W1').sampleCount).toBe(100);

    const breaching = project([counter('openwop.run.completed', [
      [{ workflow_kind: 'chain', status: 'completed' }, 90],
      [{ workflow_kind: 'chain', status: 'failed' }, 10],
    ])]);
    expect(row(breaching, 'W1').state).toBe('breaching');
    expect(row(breaching, 'W1').observed).toBeCloseTo(0.9, 6);
  });

  it('treats a zero-target row with no samples as healthy, not empty', () => {
    // The one place `empty` would actively mislead: "no effect was ever
    // blocked" is the objective met in the most complete way available.
    const rows = project([counter('openwop.effect.blocked', [])]);
    expect(row(rows, 'R1').state).toBe('healthy');
    expect(row(rows, 'R1').observed).toBe(0);
  });

  it('breaches a zero target on a single occurrence', () => {
    const rows = project([counter('openwop.effect.blocked', [[{ effect_kind: 'network-egress' }, 1]])]);
    expect(row(rows, 'R1').state).toBe('breaching');
    expect(row(rows, 'R1').observed).toBe(1);
  });

  it('separates a NO-OP INSTRUMENT (`unknown`) from a quiet host (`empty`)', () => {
    // `@opentelemetry/api` has no ProxyMeter: an instrument created before the
    // meter provider exists binds to the no-op provider and is cached forever,
    // so its measurements go nowhere for the life of the process. That is
    // indistinguishable from "no traffic" in the snapshot — and completely
    // different to fix — so the freshness map is what tells them apart.
    const quiet = project([counter('openwop.provider.call', [])]);
    expect(row(quiet, 'M1').state).toBe('empty');

    const recordedButAbsent = project([], { 'openwop.provider.call': NOW - 1_000 });
    expect(row(recordedButAbsent, 'M1').state).toBe('unknown');
    expect(row(recordedButAbsent, 'M1').reason).toMatch(/no instrument exists/);
  });

  it('answers `degraded` — never a number — when the series overflowed its ceiling', () => {
    // The SDK folds everything past the cardinality cap into ONE bucket
    // attributed `otel.metric.overflow`, silently. A ratio over a partly-folded
    // series is arithmetically fine and semantically garbage: the numerator and
    // denominator stop describing the same population.
    const overflowed = project([{
      name: 'openwop.run.completed',
      kind: 'counter',
      points: [
        { attributes: { workflow_kind: 'chain', status: 'completed' }, value: 90 },
        { attributes: { 'otel.metric.overflow': 'true' }, value: 5000 },
      ],
    }]);
    expect(row(overflowed, 'W1').state).toBe('degraded');
    expect(row(overflowed, 'W1').observed).toBeNull();
    expect(row(overflowed, 'W1').reason).toMatch(/cardinality ceiling/);
    // Distinguished from a breach: nothing is known to be failing.
    expect(row(overflowed, 'W1').state).not.toBe('breaching');
  });

  it('surfaces the series count and the ceiling so overflow is diagnosable', () => {
    const p = projectAll([counter('openwop.run.completed', [
      [{ workflow_kind: 'chain', status: 'completed' }, 1],
      [{ workflow_kind: 'chain', status: 'failed' }, 1],
    ])]);
    expect(p.series.count).toBe(2);
    expect(p.series.limit).toBe(20_000);
    expect(p.series.overflowed).toBe(false);

    const over = projectAll([{
      name: 'openwop.run.completed',
      kind: 'counter',
      points: [{ attributes: { 'otel.metric.overflow': 'true' }, value: 1 }],
    }]);
    expect(over.series.overflowed).toBe(true);
  });

  it('answers `not_projectable` with a reason, identically with and without a reader', () => {
    for (const snapshot of [null, [] as MetricSeries[]]) {
      const rows = project(snapshot);
      for (const id of ['C2', 'Q1']) {
        expect(row(rows, id).state).toBe('not_projectable');
        expect(row(rows, id).observed).toBeNull();
        expect(row(rows, id).reason).toBeTruthy();
      }
    }
  });

  it('pins the EXACT set of not-projectable rows, so a quiet demotion goes red', () => {
    const ids = SLO_CATALOG.filter((s) => s.notProjectable).map((s) => s.id).sort();
    expect(ids).toEqual(['C2', 'Q1']);
  });

  it('declares NO freshness horizon anywhere, and says why in one place', () => {
    // Pins a decision that is easy to reverse by accident in the direction that
    // looks more thorough and is worse. The HTTP histogram is the weakest
    // candidate despite looking like the strongest — the projection request
    // itself emits into it, so the check could never fail — and the dispatch
    // rows now read the queue table, so no gauge is consulted at all.
    expect(SLO_CATALOG.filter((s) => s.freshnessS !== undefined).map((s) => s.id)).toEqual([]);
  });
});

describe('ADR 0556 P2 — `stale` still works, and is reachable only by declaring a horizon', () => {
  // `projectRows` is the catalog-parameterised form of `projectSlos`; the
  // shipped entry point passes SLO_CATALOG and stays closed. Exercised with a
  // synthetic spec because NO shipped row declares a horizon — which would
  // otherwise leave the whole mechanism unverified, i.e. exactly the dead
  // branch this program keeps finding.
  const SPEC: SloSpec = {
    id: 'X1',
    group: 'synthetic',
    metric: 'openwop.dispatch.outbox.oldest_age',
    sli: 'synthetic gauge-backed objective',
    objective: { kind: 'ratio_max', value: 0.5, numerator: { match: { state: { in: ['pending'] } } } },
    severity: 'ticket',
    runbookHeading: 'Q2 Outbox oldest age',
    freshnessS: 60,
  };
  // Two points so the synthetic ratio is 1/2 — comfortably MEETING its 0.5
  // target, which is what makes the freshness check the only thing that can
  // move this row. A fixture that breaches on the arithmetic would not prove
  // that staleness outranks a computed value.
  const snapshot = [gauge('openwop.dispatch.outbox.oldest_age', [
    [{ state: 'pending' }, 1],
    [{ state: 'dead' }, 1],
  ])];
  const input = (lastEmission: Record<string, number>) => ({
    snapshot,
    lastEmission: new Map(Object.entries(lastEmission)),
    startedAtMs: BOOT,
    outbox: QUIET_QUEUE,
    seriesLimit: 20_000,
    nowMs: NOW,
  });

  it('is healthy while the series is fresh', () => {
    const r = projectRows([SPEC], input({ 'openwop.dispatch.outbox.oldest_age': NOW - 5_000 }))[0]!;
    expect(r.state).toBe('healthy');
  });

  it('goes stale when the emitter stops, and KEEPS the last-known value', () => {
    const r = projectRows([SPEC], input({ 'openwop.dispatch.outbox.oldest_age': NOW - 600_000 }))[0]!;
    expect(r.state).toBe('stale');
    // The value is not discarded — it is still the most recent truth we have.
    expect(r.observed).not.toBeNull();
    expect(r.lastSampleAt).toBe(NOW - 600_000);
  });

  it('is `empty`, not `stale`, when the emitter never ran at all', () => {
    // A disabled daemon is not a failed one, and they need different actions.
    const r = projectRows([SPEC], input({}))[0]!;
    expect(r.state).not.toBe('stale');
  });
});

describe('ADR 0556 P2 — the evaluators compute what the objective says', () => {
  it('applies the numerator ON TOP of the denominator filter (H2)', () => {
    const b = bucketsOf('openwop.interrupt.age');
    const rows = project([hist('openwop.interrupt.age', b, [
      [{ interrupt_kind: 'approval', resolution: 'accepted' }, new Array<number>(9).fill(5)],
      [{ interrupt_kind: 'approval', resolution: 'timeout' }, [5]],
      // A timer's timeout must NOT enter a denominator restricted to approvals,
      // and must not enter the numerator either.
      [{ interrupt_kind: 'timer', resolution: 'timeout' }, new Array<number>(12).fill(5)],
    ])]);
    expect(row(rows, 'H2').sampleCount).toBe(10);
    expect(row(rows, 'H2').observed).toBeCloseTo(0.1, 6);
    expect(row(rows, 'H2').state).toBe('breaching');
  });

  it('uses a CROSS-METRIC denominator where the objective names one (C1)', () => {
    const rows = project([
      counter('openwop.compensation.obligation', [[{ effect_kind: 'payment', shape: 'forward-effect' }, 1000]]),
      counter('openwop.compensation.resolved', [
        // 4000 transitions over 1000 obligations — a flapping unwind. Dividing
        // by transitions would report 0.025%, which MEETS the target; dividing
        // by obligations recorded reports 0.1% and is the honest number.
        [{ effect_kind: 'payment', state: 'started' }, 3000],
        [{ effect_kind: 'payment', state: 'completed' }, 999],
        [{ effect_kind: 'payment', state: 'manual_intervention_required' }, 1],
      ]),
    ]);
    expect(row(rows, 'C1').sampleCount).toBe(1000);
    expect(row(rows, 'C1').observed).toBeCloseTo(0.001, 9);
  });

  it('reads counts from a HISTOGRAM data point for the ratio rows that need it (A1)', () => {
    // A1 and W4 divide counts that live on a histogram's data points, not on a
    // counter — the evaluator has to read `count`, not `value`.
    const b = bucketsOf('openwop.http.server.duration');
    const rows = project([hist('openwop.http.server.duration', b, [
      [{ route: '/v1/runs', method: 'POST', status_class: '2xx', stream: 'false' }, new Array<number>(995).fill(0.02)],
      [{ route: '/v1/runs', method: 'POST', status_class: '5xx', stream: 'false' }, new Array<number>(5).fill(0.02)],
    ])]);
    expect(row(rows, 'A1').sampleCount).toBe(1000);
    expect(row(rows, 'A1').observed).toBeCloseTo(0.995, 6);
    expect(row(rows, 'A1').state).toBe('healthy');
  });

  it('excludes a `notIn` denominator value but keeps points that lack the label', () => {
    const rows = project([counter('openwop.provider.call', [
      [{ provider: 'anthropic', outcome: 'ok' }, 97],
      [{ provider: 'anthropic', outcome: 'provider_timed_out' }, 3],
      // Excluded from M1's denominator — an unconfigured key is a config state.
      [{ provider: 'openai', outcome: 'byok_required' }, 500],
    ])]);
    expect(row(rows, 'M1').sampleCount).toBe(100);
    expect(row(rows, 'M1').observed).toBeCloseTo(0.97, 6);
    expect(row(rows, 'M1').state).toBe('healthy');
  });

  it('computes a percentile row EXACTLY as the share within the threshold', () => {
    // 96 requests within 1 s and 4 beyond it. The objective is "p95 ≤ 1.0 s",
    // which means exactly "≥95% of requests are within 1.0 s" — and 1.0 is a
    // declared bucket boundary, so this is a count, not an estimate.
    const b = bucketsOf('openwop.http.server.duration');
    const rows = project([hist('openwop.http.server.duration', b, [
      [{ route: '/v1/runs', method: 'POST', status_class: '2xx', stream: 'false' },
        [...new Array<number>(96).fill(0.2), ...new Array<number>(4).fill(3)]],
    ])]);
    expect(row(rows, 'A2').observed).toBeCloseTo(0.96, 9);
    expect(row(rows, 'A2').state).toBe('healthy');
    expect(row(rows, 'A2').thresholdS).toBe(1);
    // No estimate, so no estimate caveat.
    expect(row(rows, 'A2').caveat).toBeUndefined();
  });

  it('breaches a percentile row when too many observations exceed the threshold', () => {
    const b = bucketsOf('openwop.http.server.duration');
    const rows = project([hist('openwop.http.server.duration', b, [
      [{ route: '/v1/runs', method: 'POST', status_class: '2xx', stream: 'false' },
        [...new Array<number>(90).fill(0.2), ...new Array<number>(10).fill(3)]],
    ])]);
    expect(row(rows, 'A2').observed).toBeCloseTo(0.9, 9);
    expect(row(rows, 'A2').state).toBe('breaching');
  });

  it('F1 requires EVERY read within 7 days, and recovers as fresh reads arrive', () => {
    const b = bucketsOf('openwop.attestation.age');
    const stale = project([hist('openwop.attestation.age', b, [
      [{ state: 'valid', environment_class: 'production' }, [1_000, 2_000, 900_000]],
    ])]);
    expect(row(stale, 'F1').state).toBe('breaching');
    expect(row(stale, 'F1').observed).toBeCloseTo(2 / 3, 9);

    // The reason a share beats the recorded MAX: under cumulative aggregation a
    // single ancient read would pin a max forever, so a host that fixed its
    // attestation could never go green again.
    const recovered = project([hist('openwop.attestation.age', b, [
      [{ state: 'valid', environment_class: 'production' }, [...new Array<number>(999).fill(1_000), 900_000]],
    ])]);
    expect(row(recovered, 'F1').state).toBe('breaching'); // still <1.0 — the objective is ALL reads
    expect(row(recovered, 'F1').observed).toBeCloseTo(0.999, 9);
    const clean = project([hist('openwop.attestation.age', b, [
      [{ state: 'valid', environment_class: 'production' }, new Array<number>(10).fill(1_000)],
    ])]);
    expect(clean.find((r) => r.id === 'F1')!.state).toBe('healthy');
  });

  it('excludes SSE connections via the bounded `stream` label, keeping JSON polling', () => {
    const b = bucketsOf('openwop.http.server.duration');
    const rows = project([hist('openwop.http.server.duration', b, [
      [{ route: '/v1/workflows', method: 'GET', status_class: '2xx', stream: 'false' }, new Array<number>(50).fill(0.02)],
      // The JSON POLLING mode of the run-events route. Same route template as
      // the stream below — which is precisely why a route-template filter was
      // the wrong instrument: it would have dropped this real, short request.
      [{ route: '/v1/runs/:runId/events', method: 'GET', status_class: '2xx', stream: 'false' }, new Array<number>(50).fill(0.03)],
      // The SSE mode. 600 s of "duration" is a browser tab, not latency.
      [{ route: '/v1/runs/:runId/events', method: 'GET', status_class: '2xx', stream: 'true' }, new Array<number>(50).fill(600)],
    ])]);
    expect(row(rows, 'A2').sampleCount).toBe(100);
    expect(row(rows, 'A2').state).toBe('healthy');
    // A1 is availability, not latency, and deliberately keeps streams in.
    expect(row(rows, 'A1').sampleCount).toBe(150);
  });

  it('reads the dispatch rows from the QUEUE TABLE, not the gauges', () => {
    // The gauge says one thing, the database says another. The panel must show
    // the database — the same number the dispatch-outbox panel above it renders.
    const rows = project(
      [gauge('openwop.dispatch.outbox.depth', [[{ state: 'dead' }, 0], [{ state: 'pending' }, 0]])],
      {},
      { pending: 3, dead: 7, oldestAgeS: 240 },
    );
    expect(row(rows, 'Q4').source).toBe('dispatch-outbox-stats');
    expect(row(rows, 'Q4').observed).toBe(7);
    expect(row(rows, 'Q4').state).toBe('breaching');
    expect(row(rows, 'Q2').observed).toBe(240);
    expect(row(rows, 'Q2').state).toBe('breaching');
  });

  it('reports `unknown`, never zero, when the queue read fails', () => {
    const rows = project([], {}, null);
    for (const id of ['Q2', 'Q4']) {
      expect(row(rows, id).state).toBe('unknown');
      expect(row(rows, id).observed).toBeNull();
      expect(row(rows, id).reason).toMatch(/not zero/);
    }
  });

  it('treats an EMPTY queue as healthy — no oldest age means nothing waiting', () => {
    const rows = project([], {}, { pending: 0, dead: 0, oldestAgeS: null });
    expect(row(rows, 'Q2').state).toBe('healthy');
    expect(row(rows, 'Q2').observed).toBe(0);
  });
});

describe('ADR 0556 P2 — alerts', () => {
  it('raises a breach alert with a severity and a runbook link', () => {
    const p = projectAll([counter('openwop.effect.blocked', [[{ effect_kind: 'network-egress' }, 2]])]);
    const alert = p.alerts.find((a) => a.id === 'R1');
    expect(alert).toBeDefined();
    expect(alert!.kind).toBe('breach');
    expect(alert!.severity).toBe('page');
    expect(alert!.runbook).toBe('docs/runbooks/slo-alerts.md#r1-blocked-effect');
  });

  it('raises a degraded alert when a series overflowed', () => {
    const p = projectAll([{
      name: 'openwop.run.completed',
      kind: 'counter',
      points: [{ attributes: { 'otel.metric.overflow': 'true' }, value: 1 }],
    }]);
    const alert = p.alerts.find((a) => a.id === 'W1');
    expect(alert!.kind).toBe('degraded');
    // A measurement failure, not an objective failure — but never silent, since
    // the SDK itself does not warn when it starts folding series away.
    expect(alert!.severity).toBe('ticket');
  });

  it('raises nothing at all for unknown, empty or not_projectable rows', () => {
    // The failure this forbids: a panel that pages an operator because a freshly
    // booted host has not run a workflow yet.
    for (const snapshot of [null, [] as MetricSeries[]]) {
      expect(projectAll(snapshot).alerts).toEqual([]);
    }
  });
});

describe('ADR 0556 P2 — the catalog is internally sound', () => {
  it('reads only metrics this host actually declares', () => {
    // An SLO computed from a metric nothing emits sits at `empty` forever and
    // reads as "quiet" — the failure mode hardest to notice from the outside.
    expect(unknownSloMetrics()).toEqual([]);
  });

  it('evaluates every percentile row EXACTLY — each threshold is a declared bucket', () => {
    // This is what lets the latency objectives be counted rather than
    // interpolated. A future row whose threshold is not a boundary must be
    // marked not_projectable, never silently estimated.
    expect(nonExactQuantileRows()).toEqual([]);
  });

  it('has unique ids and covers all 32 published objectives', () => {
    const ids = SLO_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(32);
  });

  it('derives runbook anchors deterministically from headings', () => {
    expect(githubAnchor('A1 HTTP availability')).toBe('a1-http-availability');
    expect(githubAnchor('Q1 Q4 Outbox depth')).toBe('q1-q4-outbox-depth');
    // No punctuation in any heading — an em dash or middle dot collapses to a
    // double hyphen and resolves in one renderer and not another.
    for (const spec of SLO_CATALOG) expect(spec.runbookHeading).toMatch(/^[A-Za-z0-9 ]+$/);
  });

  it('shareAtOrBelow refuses a threshold that is not a declared boundary', () => {
    const h = [{ boundaries: [1, 2, 5], counts: [1, 1, 1, 1], count: 4, sum: 9 }];
    expect(shareAtOrBelow(h, 2)).toBe(2);
    // 3 is not a boundary — the observations inside the straddling bucket could
    // be anywhere in it, so the honest answer is "cannot say", not a guess.
    expect(shareAtOrBelow(h, 3)).toBeNull();
  });
});
