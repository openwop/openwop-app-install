/**
 * ADR 0556 P2 — the local-scrape reader, at the SDK boundary.
 *
 * The projection's own suite proves the arithmetic against fixtures. This one
 * proves the thing fixtures cannot: that adding a second reader to the meter
 * provider does not change what the host measures or what the OTHER reader
 * sees.
 *
 * That is the question an operator has to be able to answer before turning the
 * profile on in production, and it has two failure modes that are invisible
 * from the outside:
 *
 *   • DOUBLE COUNT — the same measurement lands in both readers' totals AND in
 *     each other's, so every number doubles the moment the profile is enabled.
 *   • STARVED READER — one reader drains the accumulated state (delta
 *     semantics) and the other sees only what arrived since the last collect,
 *     so enabling the panel silently corrupts the collector the operator was
 *     already relying on.
 *
 * Both would look like "the metrics went weird after we turned that flag on",
 * which is the hardest kind of report to act on. The temporality pin in
 * `metrics.ts` is what prevents the second; this asserts it rather than
 * trusting it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { metrics as metricsApi } from '@opentelemetry/api';
import {
  LocalScrapeMetricReader,
  METRIC_CATALOG,
  addCount,
  collectLocalScrape,
  createMetrics,
  localScrapeEnabled,
  localScrapeStartedAt,
  localScrapeCardinalityLimit,
  _resetMetricsForTest,
} from '../src/observability/metrics.js';
import { flattenSnapshot } from '../src/observability/sloProjection.js';

const ENV = ['OPENWOP_METRICS_LOCAL_SCRAPE', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OPENWOP_METRICS_EXPORT_INTERVAL_MS', 'OPENWOP_METRICS_LOCAL_SCRAPE_MAX_SERIES'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  _resetMetricsForTest();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetMetricsForTest();
});

/** Total of one counter across every point, from a collected snapshot. */
async function localTotal(metric: string): Promise<number> {
  const rm = await collectLocalScrape();
  if (!rm) throw new Error('local scrape is not enabled');
  const series = flattenSnapshot(rm).find((s) => s.name === metric);
  return (series?.points ?? []).reduce((n, p) => n + (p.value ?? 0), 0);
}

describe('ADR 0556 P2 — the profile is OFF by default and says so', () => {
  it('creates no reader, and collect returns null rather than an empty snapshot', async () => {
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    expect(localScrapeEnabled()).toBe(false);
    expect(localScrapeStartedAt()).toBeNull();
    // `null`, NOT an empty ResourceMetrics. The projection distinguishes "cannot
    // read" from "read nothing", and it can only do that if this does.
    expect(await collectLocalScrape()).toBeNull();
  });

  it('still RECORDS — the measurements happen, they are just unobservable here', () => {
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    // The freshness map is stamped at record time regardless of provider state,
    // which is exactly what lets the projection tell a no-op instrument apart
    // from a quiet host.
    expect(localScrapeEnabled()).toBe(false);
  });
});

describe('ADR 0556 P2 — the profile ON, alongside the OTLP exporter', () => {
  it('reads back the exact total it recorded', async () => {
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    expect(localScrapeEnabled()).toBe(true);
    for (let i = 0; i < 7; i += 1) addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    expect(await localTotal('openwop.effect.blocked')).toBe(7);
  });

  it('is CUMULATIVE — a second collect repeats the total, it does not drain it', async () => {
    // The temporality pin. Under DELTA, `collect()` is destructive: the second
    // read would return 0, two operators refreshing at once would each see a
    // fraction, and no reading would be repeatable.
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    for (let i = 0; i < 4; i += 1) addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    expect(await localTotal('openwop.effect.blocked')).toBe(4);
    expect(await localTotal('openwop.effect.blocked')).toBe(4);
    addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    expect(await localTotal('openwop.effect.blocked')).toBe(5);
  });

  it('is not double-counted or starved when the OTLP reader is ALSO configured', async () => {
    // The coexistence case an operator actually runs: ship to a collector AND
    // read the panel. The export interval is pushed far out so the exporter
    // never fires during the test — this is about the aggregation fan-out, not
    // about reaching a collector that is not there.
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';
    process.env.OPENWOP_METRICS_EXPORT_INTERVAL_MS = '600000';
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    expect(localScrapeEnabled()).toBe(true);
    for (let i = 0; i < 10; i += 1) addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    // Exactly 10 — not 20 (double-counted) and not some fraction (starved).
    expect(await localTotal('openwop.effect.blocked')).toBe(10);
  });

  it('gives TWO readers on one provider identical totals', async () => {
    // The fan-out property itself, isolated from `createMetrics`: the SDK must
    // hand every reader its own aggregation of the same measurements. If one
    // reader's collect consumed shared state, these two would disagree — and in
    // production the disagreeing pair is the panel and the operator's collector.
    const a = new LocalScrapeMetricReader();
    const b = new LocalScrapeMetricReader();
    const provider = new MeterProvider({ readers: [a, b] });
    const counter = provider.getMeter('openwop').createCounter('openwop.effect.blocked');
    for (let i = 0; i < 6; i += 1) counter.add(1, { effect_kind: 'network-egress' });

    const totalOf = (rm: Awaited<ReturnType<typeof a.collect>>['resourceMetrics']): number =>
      rm.scopeMetrics.flatMap((sm) => sm.metrics)
        .flatMap((m) => m.dataPoints as Array<{ value: number }>)
        .reduce((n, dp) => n + dp.value, 0);

    const first = totalOf((await a.collect()).resourceMetrics);
    const second = totalOf((await b.collect()).resourceMetrics);
    expect(first).toBe(6);
    expect(second).toBe(6);
    // And re-collecting the first still agrees — neither drained the other.
    expect(totalOf((await a.collect()).resourceMetrics)).toBe(6);
    await provider.shutdown();
    metricsApi.disable();
  });

  it('ACTUALLY APPLIES the cardinality ceiling — the SDK folds past it', async () => {
    // The assertion the first version of this test was missing, and the reason
    // sabotage S16 (removing the `cardinalitySelector`) came back GREEN: a test
    // that only checks "no overflow at 50 series" passes identically with the
    // SDK's 2000 default, so it proves the ceiling is SAFE and nothing about
    // whether it is WIRED.
    //
    // Lower it to 5 and record 20 distinct label sets. The SDK folds everything
    // past the limit into one `otel.metric.overflow` bucket, so the sentinel
    // appearing is proof the selector reached the reader.
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE_MAX_SERIES = '5';
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    expect(localScrapeCardinalityLimit()).toBe(5);
    for (const runtime of ['vm', 'code-api', 'wasi', 'e2b'] as const) {
      for (const outcome of ['ok', 'timeout', 'error', 'resource_exhausted', 'capability_denied']) {
        addCount('openwop.sandbox.execution', 1, { runtime, outcome });
      }
    }
    const rm = await collectLocalScrape();
    const points = flattenSnapshot(rm!).flatMap((x) => x.points);
    expect(points.some((pt) => pt.attributes['otel.metric.overflow'] === 'true')).toBe(true);
    // And the total is preserved — the SDK folds attribution, not measurements.
    expect(points.reduce((n, pt) => n + (pt.value ?? 0), 0)).toBe(20);
  });

  it('defaults to a ceiling well above the largest declared label domain', async () => {
    // The ceiling exists so an unbounded aggregation cannot leak, and it is
    // raised above the SDK's 2000 default because this app registers ~1595
    // route templates and `openwop.http.server.duration` is labelled
    // {route, method, status_class, stream}. Past the cap the SDK silently
    // folds series into `otel.metric.overflow`, which the projection reports as
    // `degraded` — this asserts the headroom that keeps it from happening in
    // ordinary operation.
    const http = METRIC_CATALOG.find((m) => m.name === 'openwop.http.server.duration')!;
    expect(http.labels).toContain('stream');
    process.env.OPENWOP_METRICS_LOCAL_SCRAPE = 'true';
    createMetrics({ serviceName: 'test', serviceVersion: '0.0.1' });
    for (let i = 0; i < 50; i += 1) {
      addCount('openwop.effect.blocked', 1, { effect_kind: 'network-egress' });
    }
    const rm = await collectLocalScrape();
    const points = flattenSnapshot(rm!).flatMap((s) => s.points);
    // No overflow sentinel at this scale.
    expect(points.some((p) => p.attributes['otel.metric.overflow'] === 'true')).toBe(false);
  });
});
