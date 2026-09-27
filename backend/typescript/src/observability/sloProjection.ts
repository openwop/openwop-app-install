/**
 * ADR 0556 P2 — the OPERATIONS SLO PROJECTION.
 *
 * Turns the host's own OTel instruments into the read model the Operations hub
 * renders: one row per `docs/SLO.md` objective, each carrying the observed
 * value, the state it is in, and — when it is breaching or has gone quiet — an
 * alert with a severity and a runbook pointer.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * Not a metrics database, not a query engine and not a second telemetry path.
 * It reads ONE snapshot of the instruments declared in `METRIC_CATALOG`,
 * collected through the local-scrape reader on the EXISTING meter provider, and
 * arithmetic-only: ratios of counter points, quantiles read off the histogram
 * buckets the catalog already declares, gauge comparisons. There is no storage,
 * no retention, no second definition of any SLI. ADR 0556's decision section
 * draws exactly this line ("it does not become a second metrics database or
 * tracing UI") and the whole module is the shape of honouring it.
 *
 * ── THE HONESTY THAT COST THE MOST TO GET RIGHT ────────────────────────────
 *
 * `docs/SLO.md` declares a **28-day rolling, fleet-wide** window. A local
 * scrape can deliver neither half of that: the SDK's cumulative aggregation
 * starts when the reader is created, and it aggregates only what THIS process
 * recorded. So a naive panel labelled "SLO attainment" would be wrong in the
 * most flattering possible direction — a freshly restarted instance shows 100%
 * availability, because it has served four requests and none of them failed.
 *
 * Three consequences, all load-bearing:
 *
 *  1. Every response reports `window.kind: 'process_uptime'` with the instant
 *     aggregation began, and `perInstance: true` — matching the honesty the DLQ
 *     and system-health panels beside it already carry.
 *  2. Nothing here is called "attainment" or "compliance". A row that meets its
 *     target is `healthy`, which is a statement about the CURRENT INSTANCE,
 *     not a claim that the error budget is intact.
 *  3. A row with too few samples to mean anything is `empty`, never a ratio of
 *     0/0 rendered as 100%. Division is guarded, and the sample count travels
 *     with every value so a reader can discount it.
 *
 * ── AND THE ROWS THAT CANNOT BE COMPUTED AT ALL ────────────────────────────
 *
 * Two of the 31 objectives cannot be derived from the catalog as `docs/SLO.md`
 * words them, and they are marked `not_projectable` with the reason rather than
 * approximated. C2 asks how many obligations are still open AFTER 24 HOURS —
 * the counters carry no obligation age, and `recorded − completed` is a
 * different question with the same shape, which is precisely what makes
 * substituting it dangerous. Q1 asks for a level SUSTAINED over five minutes,
 * and a point-in-time gauge cannot distinguish a sustained backlog from a
 * single deep scrape. A number that answers a different question than its label
 * claims is worse than no number, because nobody audits the ones that look
 * plausible.
 */

import { DataPointType, type MetricData, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { METRIC_CATALOG } from './metrics.js';

/* ── the flattened snapshot the evaluators read ───────────────────────────── */

/** Histogram state as the SDK aggregates it — explicit boundaries + per-bucket
 *  counts, exactly the buckets `METRIC_CATALOG` declared. */
export interface HistogramPoint {
  readonly boundaries: readonly number[];
  readonly counts: readonly number[];
  readonly count: number;
  readonly sum: number;
  readonly max?: number;
}

/** One label-set of one metric. */
export interface SeriesPoint {
  readonly attributes: Readonly<Record<string, string>>;
  /** Counter / gauge value. Absent for histograms. */
  readonly value?: number;
  readonly histogram?: HistogramPoint;
}

export interface MetricSeries {
  readonly name: string;
  readonly kind: 'counter' | 'gauge' | 'histogram';
  readonly points: readonly SeriesPoint[];
}

/**
 * Flatten a collected `ResourceMetrics` into the shape the evaluators read.
 *
 * Attribute VALUES are stringified here, once. The catalog legitimately records
 * booleans (`replayed` on `openwop.node.duration` — "the smallest possible
 * domain, two series, never a string that could drift"), so a matcher written
 * against strings would silently never match that row. Normalising at the
 * boundary is the alternative to every predicate in this file remembering.
 */
export function flattenSnapshot(rm: ResourceMetrics): MetricSeries[] {
  const out: MetricSeries[] = [];
  for (const scope of rm.scopeMetrics) {
    for (const md of scope.metrics) out.push(flattenOne(md));
  }
  return out;
}

function flattenOne(md: MetricData): MetricSeries {
  const name = md.descriptor.name;
  if (md.dataPointType === DataPointType.HISTOGRAM) {
    return {
      name,
      kind: 'histogram',
      points: md.dataPoints.map((dp) => ({
        attributes: stringifyAttributes(dp.attributes),
        histogram: {
          boundaries: dp.value.buckets.boundaries,
          counts: dp.value.buckets.counts,
          count: dp.value.count,
          sum: dp.value.sum ?? 0,
          ...(typeof dp.value.max === 'number' ? { max: dp.value.max } : {}),
        },
      })),
    };
  }
  if (md.dataPointType === DataPointType.GAUGE) {
    return {
      name,
      kind: 'gauge',
      points: md.dataPoints.map((dp) => ({ attributes: stringifyAttributes(dp.attributes), value: dp.value })),
    };
  }
  if (md.dataPointType === DataPointType.SUM) {
    return {
      name,
      kind: 'counter',
      points: md.dataPoints.map((dp) => ({ attributes: stringifyAttributes(dp.attributes), value: dp.value })),
    };
  }
  // EXPONENTIAL_HISTOGRAM. This host declares explicit buckets on every
  // histogram in the catalog, so the SDK never selects exponential aggregation
  // — but an empty series is the right answer for an instrument shape the
  // evaluators genuinely cannot read, rather than a cast that pretends.
  return { name, kind: 'histogram', points: [] };
}

function stringifyAttributes(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

/* ── the objective vocabulary ─────────────────────────────────────────────── */

/** A label filter. A key absent from the match is unconstrained. */
export type LabelMatch = Readonly<Record<string, { in: readonly string[] } | { notIn: readonly string[] }>>;

/** One side of a ratio: which metric, filtered how. `metric` defaults to the
 *  row's own. Independent per side because four rows need it — C1/C2 divide one
 *  metric by ANOTHER, and A1/W4 take their counts from a histogram's data-point
 *  `count` rather than from a counter. */
export interface RatioSide {
  readonly metric?: string;
  readonly match?: LabelMatch;
}

/** Which authoritative queue number a dispatch row reads. */
export type OutboxField = 'pending' | 'dead' | 'oldestAgeS';

export type SloObjective =
  /** `numerator / denominator` must be at least / at most `value`. */
  | { kind: 'ratio_min' | 'ratio_max'; value: number; numerator: RatioSide; denominator?: RatioSide }
  /**
   * The SHARE of observations at or below `threshold` must be at least `value`.
   *
   * This is what a `pNN ≤ T` objective actually means, and — because every
   * threshold in this catalog is a DECLARED BUCKET BOUNDARY — it is computable
   * EXACTLY as `count(le=T) / count`, with no interpolation and no estimate.
   * See `shareAtOrBelow`.
   */
  | { kind: 'threshold_share'; value: number; threshold: number; filter?: LabelMatch }
  /** Any non-zero count breaches. */
  | { kind: 'zero'; filter?: LabelMatch }
  /** The authoritative queue reading must be at most `value`. */
  | { kind: 'outbox_max'; value: number; field: OutboxField };

export type SloState =
  /** Meets its objective on this instance, over this instance's uptime. */
  | 'healthy'
  /** Fails its objective. */
  | 'breaching'
  /** The instrument exists but this process has recorded no qualifying sample. */
  | 'empty'
  /** The series has recorded nothing within its declared freshness horizon. */
  | 'stale'
  /** Nothing can be read at all — the local-scrape profile is off, or this
   *  metric's instrument was never created so its measurements went nowhere. */
  | 'unknown'
  /** The series hit the cardinality ceiling and part of it was folded into an
   *  overflow bucket, so numerator and denominator no longer describe the same
   *  population. Arithmetically fine, semantically garbage. */
  | 'degraded'
  /** The catalog cannot honestly answer this objective as `docs/SLO.md` words it. */
  | 'not_projectable';

export type SloSeverity = 'page' | 'ticket';

export interface SloSpec {
  readonly id: string;
  readonly group: string;
  /** The catalog metric this row is documented against. */
  readonly metric: string;
  /** The SLI prose, mirroring the `docs/SLO.md` row. */
  readonly sli: string;
  readonly objective: SloObjective;
  readonly severity: SloSeverity;
  /**
   * The runbook HEADING this row's alert points at, verbatim. The heading text
   * is the source of truth and the anchor is DERIVED from it (`githubAnchor`),
   * so a renamed section produces a red test rather than a dead link an
   * operator finds at three in the morning.
   */
  readonly runbookHeading: string;
  /**
   * Seconds. When set, a series whose last RECORDED sample is older than this
   * is `stale` regardless of what its aggregation says.
   *
   * Deliberately opt-in, and after review it is set on NOTHING. Two candidate
   * classes were considered and both rejected:
   *
   *  - Every ZERO-TARGET objective. `openwop.effect.blocked` recording nothing
   *    for an hour is the SLO being MET; flagging that stale would page an
   *    operator for health.
   *  - The HTTP histogram behind A1-A3. It looked like the strongest candidate
   *    (a middleware on every request, so silence means it is gone) and is in
   *    fact the WEAKEST: the projection request itself emits one via
   *    `httpMetrics`'s `res.once('finish')`, so on any host serving this very
   *    endpoint the check can never go stale. It is unfalsifiable — a guard
   *    that cannot fail. It also inverts on a quiet host, where no samples
   *    simply means no traffic.
   *
   * The dispatch-queue rows would have been the real case, but they no longer
   * read a gauge at all (see `outbox_max`), so there is no emitter whose
   * silence needs watching. The mechanism is kept because it is correct and
   * cheap, and a future gauge-backed objective will need it; a test pins that
   * NOTHING currently declares one, so re-adding is a deliberate red→edit.
   */
  readonly freshnessS?: number;
  /** Set when the row cannot be computed at all; the string is the reason. */
  readonly notProjectable?: string;
  /** An honest limitation of the number this row DOES produce. */
  readonly caveat?: string;
  /** A2/A3 — exclude long-lived SSE connections, whose duration is a session
   *  length. Applied via the bounded `stream` label, never a route list. */
  readonly excludeStreams?: boolean;
}

/* ── the catalog: one entry per `docs/SLO.md` row ─────────────────────────── */

/**
 * THE SLO CATALOG — the executable half of `docs/SLO.md`.
 *
 * Both halves exist because they answer different questions: the document
 * explains WHY each objective is worded the way it is (and several of those
 * paragraphs are the most valuable thing this ADR produced), while this table
 * is what a machine can evaluate. `test/slo-projection-doc-parity.test.ts`
 * holds them in bijection on id, metric, threshold, percentile and
 * not-projectable reason, so the pair cannot drift in either direction.
 */
export const SLO_CATALOG: readonly SloSpec[] = [
  /* ── availability and latency ──────────────────────────────────────────── */
  {
    id: 'A1',
    group: 'availability',
    metric: 'openwop.http.server.duration',
    sli: 'Fraction of HTTP requests whose status_class is not 5xx',
    objective: { kind: 'ratio_min', value: 0.995, numerator: { match: { status_class: { notIn: ['5xx'] } } } },
    severity: 'page',
    runbookHeading: 'A1 HTTP availability',
  },
  {
    id: 'A2',
    group: 'availability',
    metric: 'openwop.http.server.duration',
    sli: 'p95 HTTP request duration, excluding SSE routes',
    objective: { kind: 'threshold_share', value: 0.95, threshold: 1.0 },
    severity: 'ticket',
    runbookHeading: 'A2 A3 HTTP latency',
    excludeStreams: true,
  },
  {
    id: 'A3',
    group: 'availability',
    metric: 'openwop.http.server.duration',
    sli: 'p99 HTTP request duration, excluding SSE routes',
    objective: { kind: 'threshold_share', value: 0.99, threshold: 5.0 },
    severity: 'ticket',
    runbookHeading: 'A2 A3 HTTP latency',
    excludeStreams: true,
  },

  /* ── workflow execution ────────────────────────────────────────────────── */
  {
    id: 'W1',
    group: 'workflow',
    metric: 'openwop.run.completed',
    sli: 'Fraction of terminal runs with status: completed',
    objective: { kind: 'ratio_min', value: 0.97, numerator: { match: { status: { in: ['completed'] } } } },
    severity: 'ticket',
    runbookHeading: 'W1 Run success rate',
  },
  {
    id: 'W2',
    group: 'workflow',
    metric: 'openwop.run.duration',
    sli: 'p95 run duration for workflow_kind: chain',
    objective: { kind: 'threshold_share', value: 0.95, threshold: 300, filter: { workflow_kind: { in: ['chain'] } } },
    severity: 'ticket',
    runbookHeading: 'W2 W3 Execution latency',
    // NOT a bucket-estimate caveat — the share is exact. This is the OTHER
    // limitation, and it is a sampling bias rather than a precision one:
    // `openwop.run.duration` is emitted only for runs whose START this process
    // observed (kind and start instant live in an in-process registry), so a
    // run that terminated after a cold start or on another instance is in the
    // counter and NOT in this histogram. A biased sample presented without its
    // bias is the dishonest case, so it travels on the row.
    caveat: 'same_instance_runs_only',
  },
  {
    id: 'W3',
    group: 'workflow',
    metric: 'openwop.node.duration',
    sli: 'p95 node execution duration, replayed: false',
    objective: { kind: 'threshold_share', value: 0.95, threshold: 30, filter: { replayed: { in: ['false'] } } },
    severity: 'ticket',
    runbookHeading: 'W2 W3 Execution latency',
  },
  {
    id: 'W4',
    group: 'workflow',
    metric: 'openwop.node.duration',
    sli: 'Fraction of node attempts ending failure',
    objective: { kind: 'ratio_max', value: 0.03, numerator: { match: { status: { in: ['failure'] } } } },
    severity: 'ticket',
    runbookHeading: 'W4 Node failure rate',
  },

  /* ── replay and effect safety ──────────────────────────────────────────── */
  {
    id: 'R1',
    group: 'replay',
    metric: 'openwop.effect.blocked',
    sli: 'Effects blocked by the ADR 0531 replay backstop',
    objective: { kind: 'zero' },
    severity: 'page',
    runbookHeading: 'R1 Blocked effect',
  },
  {
    id: 'R2',
    group: 'replay',
    metric: 'openwop.replay.node.served',
    sli: 'Replay lookups ending source-missing',
    objective: { kind: 'ratio_max', value: 0.001, numerator: { match: { outcome: { in: ['source-missing'] } } } },
    severity: 'ticket',
    runbookHeading: 'R2 Replay source missing',
  },

  /* ── idempotency and recovery ──────────────────────────────────────────── */
  {
    id: 'I1',
    group: 'idempotency',
    metric: 'openwop.idempotency.claim',
    sli: 'Fraction of claims ending mismatch',
    objective: { kind: 'ratio_max', value: 0.005, numerator: { match: { outcome: { in: ['mismatch'] } } } },
    severity: 'ticket',
    runbookHeading: 'I1 Idempotency mismatch',
  },
  {
    id: 'I2',
    group: 'idempotency',
    metric: 'openwop.idempotency.claim',
    sli: 'Fraction of claims ending reclaimed',
    objective: { kind: 'ratio_max', value: 0.001, numerator: { match: { outcome: { in: ['reclaimed'] } } } },
    severity: 'page',
    runbookHeading: 'I2 Idempotency reclaimed',
  },
  {
    id: 'I3',
    group: 'idempotency',
    metric: 'openwop.idempotency.claim',
    sli: 'Fraction of claims ending in-flight',
    objective: { kind: 'ratio_max', value: 0.01, numerator: { match: { outcome: { in: ['in-flight'] } } } },
    severity: 'ticket',
    runbookHeading: 'I3 Idempotency in flight',
  },

  /* ── compensation (RFC 0151) ───────────────────────────────────────────── */
  {
    id: 'C1',
    group: 'compensation',
    metric: 'openwop.compensation.resolved',
    sli: 'Obligations reaching manual_intervention_required',
    objective: {
      kind: 'ratio_max',
      value: 0.001,
      numerator: { match: { state: { in: ['manual_intervention_required'] } } },
      // "of RECORDED" — the denominator is the obligation counter, not the
      // transition counter. Dividing by resolutions would divide by a number
      // that counts each obligation's retries, so a flapping unwind would
      // DILUTE the very signal this row exists to raise.
      denominator: { metric: 'openwop.compensation.obligation' },
    },
    severity: 'page',
    runbookHeading: 'C1 Manual compensation',
  },
  {
    id: 'C2',
    group: 'compensation',
    metric: 'openwop.compensation.obligation',
    sli: 'Obligations still not completed after 24 h',
    objective: {
      kind: 'ratio_max',
      value: 0.01,
      numerator: { metric: 'openwop.compensation.resolved', match: { state: { notIn: ['completed'] } } },
    },
    severity: 'ticket',
    runbookHeading: 'C2 Slow compensation',
    notProjectable:
      'needs each obligation\'s AGE, which no counter carries. `recorded − completed` is a different '
      + 'question (open right now, at any age) wearing the same shape, so substituting it would answer '
      + 'confidently and wrongly. Closing this needs an obligation-age histogram, not a projection change.',
  },

  /* ── interrupts ────────────────────────────────────────────────────────── */
  {
    id: 'H1',
    group: 'interrupts',
    metric: 'openwop.interrupt.age',
    sli: 'p95 age at resolution, interrupt_kind: approval',
    objective: { kind: 'threshold_share', value: 0.95, threshold: 14_400, filter: { interrupt_kind: { in: ['approval'] } } },
    severity: 'ticket',
    runbookHeading: 'H1 Approval wait',
  },
  {
    id: 'H2',
    group: 'interrupts',
    metric: 'openwop.interrupt.age',
    sli: 'Fraction of approvals resolving timeout',
    objective: {
      kind: 'ratio_max',
      value: 0.05,
      numerator: { match: { resolution: { in: ['timeout'] } } },
      denominator: { match: { interrupt_kind: { in: ['approval'] } } },
    },
    severity: 'page',
    runbookHeading: 'H2 Approval timeout',
  },

  /* ── cross-host protocol ───────────────────────────────────────────────── */
  {
    id: 'P1',
    group: 'protocol',
    metric: 'openwop.a2a.request',
    sli: 'Fraction of inbound A2A requests ending internal_error',
    objective: {
      kind: 'ratio_max',
      value: 0.005,
      numerator: { match: { outcome: { in: ['internal_error'] } } },
      // A peer calling a method this host does not serve is the peer's problem;
      // folding it in lets one scanner burn the error budget.
      denominator: { match: { outcome: { notIn: ['method_not_found', 'invalid_params'] } } },
    },
    severity: 'ticket',
    runbookHeading: 'P1 P2 Protocol internal errors',
  },
  {
    id: 'P2',
    group: 'protocol',
    metric: 'openwop.mcp.request',
    sli: 'Fraction of inbound MCP requests ending internal_error',
    objective: {
      kind: 'ratio_max',
      value: 0.005,
      numerator: { match: { direction: { in: ['inbound'] }, outcome: { in: ['internal_error'] } } },
      denominator: { match: { direction: { in: ['inbound'] }, outcome: { notIn: ['method_not_found', 'invalid_params'] } } },
    },
    severity: 'ticket',
    runbookHeading: 'P1 P2 Protocol internal errors',
  },
  {
    id: 'P3',
    group: 'protocol',
    metric: 'openwop.mcp.request',
    sli: 'Fraction of outbound MCP calls ending ok',
    objective: {
      kind: 'ratio_min',
      value: 0.98,
      numerator: { match: { direction: { in: ['outbound'] }, outcome: { in: ['ok'] } } },
      denominator: { match: { direction: { in: ['outbound'] } } },
    },
    severity: 'ticket',
    runbookHeading: 'P3 Outbound MCP failures',
  },
  {
    id: 'P4',
    group: 'protocol',
    metric: 'openwop.protocol.version',
    sli: 'Version dispositions ending unsupported',
    objective: { kind: 'ratio_max', value: 0.01, numerator: { match: { disposition: { in: ['unsupported'] } } } },
    severity: 'ticket',
    runbookHeading: 'P4 Unsupported protocol versions',
  },

  /* ── model providers ───────────────────────────────────────────────────── */
  {
    id: 'M1',
    group: 'providers',
    metric: 'openwop.provider.call',
    sli: 'Fraction of provider calls ending ok',
    objective: {
      kind: 'ratio_min',
      value: 0.97,
      numerator: { match: { outcome: { in: ['ok'] } } },
      // An operator who has not configured a key is a CONFIGURATION state, and
      // counting it makes a fresh install look like a provider outage.
      denominator: { match: { outcome: { notIn: ['byok_required', 'byok_required_but_unresolved'] } } },
    },
    severity: 'ticket',
    runbookHeading: 'M1 Provider failure rate',
  },
  {
    id: 'M2',
    group: 'providers',
    metric: 'openwop.provider.call',
    sli: 'Fraction ending provider_rate_limited',
    objective: { kind: 'ratio_max', value: 0.01, numerator: { match: { outcome: { in: ['provider_rate_limited'] } } } },
    severity: 'ticket',
    runbookHeading: 'M2 Provider rate limiting',
  },

  /* ── sandbox ───────────────────────────────────────────────────────────── */
  {
    id: 'S1',
    group: 'sandbox',
    metric: 'openwop.sandbox.execution',
    sli: 'Sandbox executions ending escape_attempt',
    objective: { kind: 'zero', filter: { outcome: { in: ['escape_attempt'] } } },
    severity: 'page',
    runbookHeading: 'S1 Sandbox escape attempt',
  },
  {
    id: 'S2',
    group: 'sandbox',
    metric: 'openwop.sandbox.execution',
    sli: 'Fraction ending resource_exhausted',
    objective: { kind: 'ratio_max', value: 0.02, numerator: { match: { outcome: { in: ['resource_exhausted'] } } } },
    severity: 'ticket',
    runbookHeading: 'S2 S3 Sandbox capacity',
  },
  {
    id: 'S3',
    group: 'sandbox',
    metric: 'openwop.sandbox.execution',
    sli: 'Fraction ending timeout',
    objective: { kind: 'ratio_max', value: 0.05, numerator: { match: { outcome: { in: ['timeout'] } } } },
    severity: 'ticket',
    runbookHeading: 'S2 S3 Sandbox capacity',
  },

  /* ── assurance freshness ───────────────────────────────────────────────── */
  {
    id: 'F1',
    group: 'assurance',
    metric: 'openwop.attestation.age',
    sli: 'Attestation age at read, state: valid',
    /**
     * F1'S KIND, DECIDED EXPLICITLY rather than defaulted.
     *
     * The row declares no percentile — "age at read ≤ 7 days" is neither a
     * ratio nor a `pNN`, so a projection has to CHOOSE, and choosing silently
     * is how a number ends up answering a question nobody asked. Three
     * candidates: the recorded MAX (exact, but a single ancient read pins it
     * forever under cumulative aggregation, so it never recovers); a p95
     * (invents a percentile the objective does not state, and the top bucket
     * here is 30 days wide so the estimate would be useless at the only end
     * anyone cares about); or a share at 1.0 — EVERY read within 7 days.
     *
     * The last is chosen: it is the literal reading of the row, it is exact
     * because 604800 is a declared boundary, and unlike the max it is a
     * proportion, so a host that fixes its attestation converges back to
     * healthy as fresh reads accumulate instead of being permanently damned by
     * one bad one.
     */
    objective: { kind: 'threshold_share', value: 1, threshold: 604_800, filter: { state: { in: ['valid'] } } },
    severity: 'ticket',
    runbookHeading: 'F1 Attestation freshness',
  },
  {
    id: 'F2',
    group: 'assurance',
    metric: 'openwop.attestation.age',
    sli: 'Reads returning state: invalid',
    objective: { kind: 'zero', filter: { state: { in: ['invalid'] } } },
    severity: 'page',
    runbookHeading: 'F2 Invalid attestation',
  },

  /* ── dispatch queue ────────────────────────────────────────────────────── *
   * These four read the AUTHORITATIVE queue table, not the gauges.
   *
   * The gauges exist and are exported to a collector — but the same Operations
   * page ALREADY renders `storage.dispatchOutboxStats()` in the panel directly
   * above this one. Reading the gauge here would put two numbers for one
   * quantity on one page, and the gauge is the worse of the two: it is
   * point-in-time, observed only on instances that actually run the sweeper,
   * and frozen at its last value on instances that do not. One page, one
   * number, and it is the one the database says. This is also what ADR 0556's
   * decision section describes — the projection "reads aggregated telemetry
   * AND HEALTH ENDPOINTS".                                                    */
  {
    id: 'Q1',
    group: 'dispatch',
    metric: 'openwop.dispatch.outbox.depth',
    sli: 'Pending dispatch intents (backlog depth)',
    objective: { kind: 'outbox_max', value: 50, field: 'pending' },
    severity: 'ticket',
    runbookHeading: 'Q1 Q4 Outbox depth',
    notProjectable:
      'the objective is a level SUSTAINED over 5 minutes, and a single reading cannot tell a sustained '
      + 'backlog from one deep scrape. `docs/SLO.md` says so itself ("alert on a SUSTAINED level, never a '
      + 'single scrape"); evaluating the instantaneous value against 50 would produce exactly the '
      + 'single-scrape alert that sentence forbids. The depth is still SHOWN on the dispatch-outbox panel.',
  },
  {
    id: 'Q2',
    group: 'dispatch',
    metric: 'openwop.dispatch.outbox.oldest_age',
    sli: 'Age of the oldest pending intent',
    objective: { kind: 'outbox_max', value: 120, field: 'oldestAgeS' },
    // `docs/SLO.md`: "Q2 is the one to page on."
    severity: 'page',
    runbookHeading: 'Q2 Outbox oldest age',
  },
  {
    id: 'Q3',
    group: 'dispatch',
    metric: 'openwop.dispatch.lease.recovered',
    sli: 'Dispatch intents given up on',
    objective: { kind: 'zero', filter: { outcome: { in: ['dead'] } } },
    severity: 'page',
    runbookHeading: 'Q3 Dead dispatch intents',
  },
  {
    id: 'Q4',
    group: 'dispatch',
    metric: 'openwop.dispatch.outbox.depth',
    sli: 'Dead intents awaiting an operator redrive',
    objective: { kind: 'outbox_max', value: 5, field: 'dead' },
    severity: 'ticket',
    runbookHeading: 'Q1 Q4 Outbox depth',
  },
  {
    id: 'K1',
    group: 'webhooks',
    metric: 'openwop.webhook.first_attempt_delay',
    // The denominator is deliveries THIS PROCESS claimed — a row claimed by
    // another instance is invisible here. Stated rather than discovered later:
    // the same sampling bias W2 documents for `openwop.run.duration`, and an SLO
    // whose denominator is silently partial is a measurement taken under
    // conditions differing from the thing measured.
    sli: 'p95 first-attempt delay for webhook deliveries claimed by this process',
    // 30 is a DECLARED BUCKET BOUNDARY of the metric (metrics.ts), so this is
    // computed exactly as count(le=30)/count — no interpolation, per :170-177.
    objective: { kind: 'threshold_share', value: 0.95, threshold: 30 },
    // `ticket`, not `page`: WHD-1 degraded delivery for weeks without data loss —
    // every delivery eventually landed. Paging on it would train operators to
    // ignore the page, which is how the next real outage gets missed.
    severity: 'ticket',
    runbookHeading: 'K1 Webhook delivery latency',
  },
];

/** Where the runbook lives. Emitted with every alert; a test asserts every
 *  heading this catalog names actually exists in it. */
export const RUNBOOK_DOC = 'docs/runbooks/slo-alerts.md';

/**
 * GitHub's heading-to-anchor slug, for the subset of characters these headings
 * use: lowercase, drop anything that is not alphanumeric / space / hyphen,
 * then spaces to hyphens.
 *
 * The runbook headings are deliberately written WITHOUT punctuation so this
 * stays a total function with no surprises — an em dash or a middle dot would
 * collapse to a double hyphen and produce a link that resolves in one renderer
 * and not another.
 */
export function githubAnchor(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
}

/* ── the read model ───────────────────────────────────────────────────────── */

export interface SloRow {
  readonly id: string;
  readonly group: string;
  readonly metric: string;
  readonly sli: string;
  readonly state: SloState;
  /** Where the number came from — the in-process instruments, or the queue
   *  table. Surfaced because "which of the two numbers is this" is exactly the
   *  question a duplicated quantity makes an operator ask. */
  readonly source: 'local-scrape' | 'dispatch-outbox-stats' | 'none';
  /** The computed SLI. `null` for every state except healthy/breaching. */
  readonly observed: number | null;
  /** The target it was compared against. */
  readonly target: number;
  readonly comparison: 'at_most' | 'at_least';
  /** Ratios and shares are unitless; outbox rows are counts or seconds. */
  readonly unit: 'ratio' | 'seconds' | 'count';
  /** For a `threshold_share` row: the seconds bound the share is taken at. */
  readonly thresholdS?: number;
  /** How many measurements the value rests on. A ratio over 3 samples is not
   *  evidence, and the panel says so rather than leaving it to be inferred. */
  readonly sampleCount: number;
  /** Epoch millis of the last recorded sample, or `null` if never. */
  readonly lastSampleAt: number | null;
  readonly freshnessS: number | null;
  readonly severity: SloSeverity;
  readonly runbook: string;
  readonly caveat?: string;
  /** Set on `not_projectable` / `degraded` / `unknown`, explaining what is missing. */
  readonly reason?: string;
}

export interface SloAlert {
  readonly id: string;
  readonly severity: SloSeverity;
  /** `breach` — the objective is not met. `stale` — the series went quiet.
   *  `degraded` — the series overflowed its cardinality ceiling. */
  readonly kind: 'breach' | 'stale' | 'degraded';
  readonly summary: string;
  readonly runbook: string;
}

export interface SloProjection {
  /** `local-scrape` when the profile is on; `unavailable` when it is off. */
  readonly source: 'local-scrape' | 'unavailable';
  readonly window: { readonly kind: 'process_uptime'; readonly startedAt: string | null; readonly seconds: number | null };
  /** Always TRUE. A local scrape describes one instance, and `docs/SLO.md`'s
   *  window is fleet-wide — the field exists so the panel cannot forget. */
  readonly perInstance: true;
  /** Distinct time series held by the local-scrape reader, and the ceiling it
   *  is allowed. An operator sizing memory, or diagnosing a `degraded` row,
   *  needs both; `overflowed` is the SDK's own sentinel, not our inference. */
  readonly series: { readonly count: number; readonly limit: number; readonly overflowed: boolean };
  readonly rows: readonly SloRow[];
  readonly alerts: readonly SloAlert[];
  readonly runbookDoc: string;
  readonly fetchedAt: string;
}

/** The authoritative queue reading, from `storage.dispatchOutboxStats()`.
 *  `null` when the read failed — which is NOT zero. */
export interface OutboxFacts {
  readonly pending: number;
  readonly dead: number;
  readonly oldestAgeS: number | null;
}

export interface ProjectInput {
  /** `null` when the local-scrape profile is off. */
  readonly snapshot: readonly MetricSeries[] | null;
  /** Per-metric last RECORD time, from `metrics.lastEmissionMap()`. */
  readonly lastEmission: ReadonlyMap<string, number>;
  /** When the local-scrape reader began aggregating. `null` when off. */
  readonly startedAtMs: number | null;
  /** Authoritative dispatch-queue numbers. `null` when the read failed. */
  readonly outbox: OutboxFacts | null;
  /** The reader's configured series ceiling, for the response. */
  readonly seriesLimit: number;
  readonly nowMs: number;
}

/**
 * Project an ARBITRARY catalog. Pure, and the parameterised form of
 * `projectSlos` below.
 *
 * Exported for one specific reason worth stating: as shipped, NO row declares a
 * freshness horizon (see `SloSpec.freshnessS` for why both candidate classes
 * were rejected), so the `stale` branch would be unreachable from
 * `SLO_CATALOG` — an untested dead branch, which is precisely the class this
 * program keeps finding. This lets the suite exercise it with a synthetic spec
 * while `projectSlos` stays closed over the real catalog.
 */
export function projectRows(catalog: readonly SloSpec[], input: ProjectInput): readonly SloRow[] {
  return catalog.map((spec) => projectOne(spec, input));
}

/** Build the whole projection over the SHIPPED catalog. Pure — every input is
 *  a parameter, so the route injects the snapshot and the test injects a fixture. */
export function projectSlos(input: ProjectInput): SloProjection {
  const rows = projectRows(SLO_CATALOG, input);
  const alerts = rows.flatMap(alertsForRow);
  const count = (input.snapshot ?? []).reduce((n, s) => n + s.points.length, 0);
  const overflowed = (input.snapshot ?? []).some((s) => s.points.some(isOverflowPoint));
  return {
    source: input.snapshot ? 'local-scrape' : 'unavailable',
    window: {
      kind: 'process_uptime',
      startedAt: input.startedAtMs === null ? null : new Date(input.startedAtMs).toISOString(),
      seconds: input.startedAtMs === null ? null : Math.max(0, Math.round((input.nowMs - input.startedAtMs) / 1000)),
    },
    perInstance: true,
    series: { count, limit: input.seriesLimit, overflowed },
    rows,
    alerts,
    runbookDoc: RUNBOOK_DOC,
    fetchedAt: new Date(input.nowMs).toISOString(),
  };
}

/** The SDK folds every series past the cardinality ceiling into ONE data point
 *  attributed `otel.metric.overflow: true`. Its presence means part of the
 *  population is unattributable, so any ratio over that metric is meaningless. */
function isOverflowPoint(p: SeriesPoint): boolean {
  return p.attributes['otel.metric.overflow'] === 'true';
}

function objectiveShape(o: SloObjective): { target: number; comparison: 'at_most' | 'at_least'; unit: SloRow['unit'] } {
  switch (o.kind) {
    case 'ratio_min': return { target: o.value, comparison: 'at_least', unit: 'ratio' };
    case 'ratio_max': return { target: o.value, comparison: 'at_most', unit: 'ratio' };
    case 'threshold_share': return { target: o.value, comparison: 'at_least', unit: 'ratio' };
    case 'zero': return { target: 0, comparison: 'at_most', unit: 'count' };
    case 'outbox_max': return { target: o.value, comparison: 'at_most', unit: o.field === 'oldestAgeS' ? 'seconds' : 'count' };
  }
}

function baseRow(spec: SloSpec): Omit<SloRow, 'state' | 'observed' | 'sampleCount' | 'lastSampleAt' | 'source'> {
  const { target, comparison, unit } = objectiveShape(spec.objective);
  return {
    id: spec.id,
    group: spec.group,
    metric: spec.metric,
    sli: spec.sli,
    target,
    comparison,
    unit,
    ...(spec.objective.kind === 'threshold_share' ? { thresholdS: spec.objective.threshold } : {}),
    freshnessS: spec.freshnessS ?? null,
    severity: spec.severity,
    runbook: `${RUNBOOK_DOC}#${githubAnchor(spec.runbookHeading)}`,
    ...(spec.caveat ? { caveat: spec.caveat } : {}),
  };
}

function projectOne(spec: SloSpec, input: ProjectInput): SloRow {
  const base = baseRow(spec);
  const lastSampleAt = input.lastEmission.get(spec.metric) ?? null;

  // ORDER MATTERS, and this is the order an operator needs.
  //
  // `not_projectable` is a property of the CATALOG, not of the data, so it is
  // answered first and identically whether or not a collector is running —
  // otherwise turning the profile on would appear to "fix" a row that no amount
  // of data can answer.
  if (spec.notProjectable) {
    return { ...base, state: 'not_projectable', source: 'none', observed: null, sampleCount: 0, lastSampleAt, reason: spec.notProjectable };
  }

  // The dispatch rows read the DATABASE, so they are answered before anything
  // about the metrics reader — they are readable on a host with no reader at
  // all, and reporting them `unknown` because telemetry is off would be false.
  if (spec.objective.kind === 'outbox_max') {
    const o = spec.objective;
    if (!input.outbox) {
      return {
        ...base, state: 'unknown', source: 'none', observed: null, sampleCount: 0, lastSampleAt,
        reason: 'the dispatch-outbox stats read failed, so the queue depth is unknown — which is not zero',
      };
    }
    const value = o.field === 'oldestAgeS' ? input.outbox.oldestAgeS : input.outbox[o.field];
    // An EMPTY queue has no oldest age. That is `healthy`, not `empty`: there
    // is nothing waiting, which is the best possible reading of this objective.
    const observed = value ?? 0;
    return {
      ...base,
      state: observed <= o.value ? 'healthy' : 'breaching',
      source: 'dispatch-outbox-stats',
      observed,
      sampleCount: 1,
      lastSampleAt,
    };
  }

  // Then "can we read anything at all". `unknown` must never be confused with a
  // healthy zero: a host with no local-scrape reader records every effect-block
  // it suffers and can report none of them.
  if (!input.snapshot) {
    return {
      ...base, state: 'unknown', source: 'none', observed: null, sampleCount: 0, lastSampleAt,
      reason: 'the local-scrape operator profile is off, so this host cannot read its own instruments',
    };
  }

  const series = input.snapshot.find((s) => s.name === spec.metric) ?? null;

  // RECORDED BUT UNOBSERVABLE — a distinct failure from "no traffic".
  //
  // `@opentelemetry/api` has no ProxyMeter: an instrument created BEFORE
  // `createMetrics` runs binds against the no-op meter provider and is cached
  // forever, so its measurements go nowhere for the life of the process. The
  // freshness map is stamped in `noteEmission` regardless of provider state, so
  // "this metric has been recorded at least once AND is absent from the
  // snapshot" identifies exactly that case — and it must not read as `empty`,
  // which would be indistinguishable from a quiet host.
  if (!series && lastSampleAt !== null) {
    return {
      ...base, state: 'unknown', source: 'local-scrape', observed: null, sampleCount: 0, lastSampleAt,
      reason: 'this metric has been recorded but no instrument exists in the reader — it was bound before the meter provider was created, so its measurements go nowhere',
    };
  }

  // CARDINALITY OVERFLOW — the series is polluted, so refuse to divide over it.
  const relevant = ratioMetrics(spec).map((n) => input.snapshot!.find((s) => s.name === n)).filter((s): s is MetricSeries => !!s);
  if ([series, ...relevant].some((s) => s && s.points.some(isOverflowPoint))) {
    return {
      ...base, state: 'degraded', source: 'local-scrape', observed: null, sampleCount: 0, lastSampleAt,
      reason: 'the series exceeded its cardinality ceiling, so part of the population was folded into an unattributable overflow bucket — a ratio over it would not describe the same population on both sides',
    };
  }

  const evaluated = evaluate(spec, series, input.snapshot);

  // Staleness OUTRANKS a computed value. A frozen series still divides and
  // still compares; it just describes a moment that has passed. Checked after
  // evaluation so `empty` (never emitted at all) stays distinguishable from
  // `stale` (emitted, then stopped) — they have different fixes.
  if (spec.freshnessS !== undefined && lastSampleAt !== null
      && input.nowMs - lastSampleAt > spec.freshnessS * 1000) {
    return { ...base, state: 'stale', source: 'local-scrape', observed: evaluated.observed, sampleCount: evaluated.sampleCount, lastSampleAt };
  }
  if (evaluated.observed === null) {
    return { ...base, state: 'empty', source: 'local-scrape', observed: null, sampleCount: evaluated.sampleCount, lastSampleAt };
  }
  const meets = base.comparison === 'at_least'
    ? evaluated.observed >= base.target
    : evaluated.observed <= base.target;
  return {
    ...base,
    state: meets ? 'healthy' : 'breaching',
    source: 'local-scrape',
    observed: evaluated.observed,
    sampleCount: evaluated.sampleCount,
    lastSampleAt,
  };
}

/** Every metric a row reads besides its own — the cross-metric ratio sides. */
function ratioMetrics(spec: SloSpec): readonly string[] {
  const o = spec.objective;
  if (o.kind !== 'ratio_min' && o.kind !== 'ratio_max') return [];
  return [o.numerator.metric, o.denominator?.metric].filter((n): n is string => !!n);
}

interface Evaluated { observed: number | null; sampleCount: number }

function evaluate(spec: SloSpec, series: MetricSeries | null, all: readonly MetricSeries[]): Evaluated {
  const o = spec.objective;
  switch (o.kind) {
    case 'outbox_max':
      // Answered in `projectOne` from the database, never from a series.
      return { observed: null, sampleCount: 0 };
    case 'zero': {
      const points = filterPoints(spec, series, o.filter);
      // A zero-target row with no points is HEALTHY, not empty: "no effect was
      // ever blocked" is the objective being met in the most complete way
      // available. This is the one place `empty` would actively mislead.
      const total = points.reduce((n, p) => n + countOf(p), 0);
      return { observed: total, sampleCount: total };
    }
    case 'threshold_share': {
      const points = filterPoints(spec, series, o.filter);
      const hist = points.map((p) => p.histogram).filter((h): h is HistogramPoint => h !== undefined);
      const total = hist.reduce((n, h) => n + h.count, 0);
      if (total === 0) return { observed: null, sampleCount: 0 };
      const within = shareAtOrBelow(hist, o.threshold);
      // `null` means the threshold is not a declared boundary, so the share
      // cannot be read exactly. Refuse rather than interpolate.
      if (within === null) return { observed: null, sampleCount: total };
      return { observed: within / total, sampleCount: total };
    }
    case 'ratio_min':
    case 'ratio_max': {
      const sideSeries = (side: RatioSide | undefined): MetricSeries | null =>
        side?.metric ? (all.find((s) => s.name === side.metric) ?? null) : series;
      const denomSide = o.denominator;
      const denomPoints = filterPoints(spec, sideSeries(denomSide), denomSide?.match);
      const denom = denomPoints.reduce((n, p) => n + countOf(p), 0);
      // 0/0 is not 100%. A host that has run no workflows has not met W1; it
      // has no opinion, and rendering "100% success" from zero runs is how a
      // dashboard earns the trust it then spends being wrong.
      if (denom === 0) return { observed: null, sampleCount: 0 };
      // When both sides read the SAME metric, the numerator is applied ON TOP
      // of the denominator's filter, so a row like H2 ("approvals resolving
      // timeout") cannot count a timer's timeout against an approvals-only
      // denominator. When they read different metrics, they are independent.
      const numerPoints = o.numerator.metric || denomSide?.metric
        ? filterPoints(spec, sideSeries(o.numerator), o.numerator.match)
        : denomPoints.filter((p) => !o.numerator.match || matches(p.attributes, o.numerator.match));
      const numer = numerPoints.reduce((n, p) => n + countOf(p), 0);
      return { observed: numer / denom, sampleCount: denom };
    }
  }
}

/** Every point of `series` passing the row's filter and its stream exclusion. */
function filterPoints(spec: SloSpec, series: MetricSeries | null, match: LabelMatch | undefined): readonly SeriesPoint[] {
  if (!series) return [];
  return series.points.filter((p) => {
    if (isOverflowPoint(p)) return false;
    if (match && !matches(p.attributes, match)) return false;
    // A2/A3. An SSE connection's "duration" is how long a browser tab stayed
    // open, routinely minutes; leaving those in makes a p95 latency objective
    // report a value with no relationship to request latency, and it would
    // breach permanently on a perfectly healthy host. Decided by the bounded
    // `stream` label, which `httpMetrics` sets from the rate limiter's own
    // request predicate — so the JSON polling mode of `/v1/runs/:runId/events`
    // is correctly KEPT while its SSE mode is dropped.
    if (spec.excludeStreams && p.attributes.stream === 'true') return false;
    return true;
  });
}

function matches(attrs: Readonly<Record<string, string>>, match: LabelMatch): boolean {
  for (const [key, rule] of Object.entries(match)) {
    const v = attrs[key];
    if ('in' in rule) {
      if (v === undefined || !rule.in.includes(v)) return false;
    } else {
      // `notIn` on an ABSENT label passes: an unlabelled point is not one of
      // the excluded values. The alternative (absent ⇒ excluded) would silently
      // empty out every denominator on a metric whose label is optional.
      if (v !== undefined && rule.notIn.includes(v)) return false;
    }
  }
  return true;
}

/** How many measurements a point represents — a counter's total, or a
 *  histogram's observation count. */
function countOf(p: SeriesPoint): number {
  if (p.histogram) return p.histogram.count;
  return p.value ?? 0;
}

/**
 * How many observations fall at or below `threshold`, EXACTLY.
 *
 * Returns `null` when `threshold` is not one of the histogram's declared
 * boundaries, because then the answer is genuinely unknown — the observations
 * inside the straddling bucket could be anywhere in it — and an interpolation
 * would be a guess dressed as a measurement.
 *
 * That never happens for the shipped catalog: every `threshold_share` row's
 * threshold IS a declared bucket boundary (A2 `1`, A3 `5`, W2 `300`, W3 `30`,
 * H1 `14400`, F1 `604800`), which is exactly why this phase evaluates the
 * latency objectives exactly instead of estimating them. A test asserts that
 * membership over the whole catalog, so adding a row whose threshold is not a
 * boundary is a red test rather than a silent fallback to an estimate.
 *
 * Buckets are inclusive upper bounds, and `counts` has one more entry than
 * `boundaries` (the final overflow bucket), so the count at or below
 * `boundaries[i]` is the sum of `counts[0..i]`.
 */
export function shareAtOrBelow(hists: readonly HistogramPoint[], threshold: number): number | null {
  const boundaries = hists.find((h) => h.boundaries.length > 0)?.boundaries ?? [];
  const idx = boundaries.indexOf(threshold);
  if (idx === -1) return null;
  let within = 0;
  for (const h of hists) {
    for (let i = 0; i <= idx && i < h.counts.length; i += 1) within += h.counts[i]!;
  }
  return within;
}

/** The alerts one row raises. A row raises at most one.
 *  Exported so a test can assert on the alert an individually-rigged row EMITS,
 *  rather than on the catalog it was built from — a projection that emitted
 *  nothing would pass a catalog-only check trivially. */
export function alertsForRow(row: SloRow): SloAlert[] {
  if (row.state === 'breaching') {
    return [{
      id: row.id,
      severity: row.severity,
      kind: 'breach',
      summary: `${row.sli} is ${formatObserved(row)} against a target of ${row.comparison === 'at_least' ? '≥' : '≤'} ${formatTarget(row)}.`,
      runbook: row.runbook,
    }];
  }
  if (row.state === 'stale') {
    return [{
      id: row.id,
      // A stale series is a MEASUREMENT failure, and one severity below the
      // objective's own: the host may be perfectly healthy and merely unable to
      // prove it. But it is never silent — a panel that cannot see is the
      // condition under which every other row on it becomes untrustworthy.
      severity: 'ticket',
      kind: 'stale',
      summary: `${row.metric} has recorded no sample for longer than its ${row.freshnessS}s freshness horizon, so ${row.id} cannot be judged.`,
      runbook: row.runbook,
    }];
  }
  if (row.state === 'degraded') {
    return [{
      id: row.id,
      // Also a measurement failure rather than an objective failure — but a
      // LOUDER one than staleness, because it is silent by construction: the
      // SDK does not warn when it starts folding series away, so without this
      // the panel would keep showing a confident number computed over a
      // population that no longer means what its label says.
      severity: 'ticket',
      kind: 'degraded',
      summary: `${row.metric} exceeded its cardinality ceiling, so ${row.id} cannot be computed over a well-defined population.`,
      runbook: row.runbook,
    }];
  }
  return [];
}

function formatObserved(row: SloRow): string {
  if (row.observed === null) return 'unknown';
  if (row.unit === 'ratio') return `${(row.observed * 100).toFixed(2)}%`;
  if (row.unit === 'seconds') return `${row.observed}s`;
  return String(row.observed);
}

function formatTarget(row: SloRow): string {
  if (row.unit === 'ratio') return `${(row.target * 100).toFixed(2)}%`;
  if (row.unit === 'seconds') return `${row.target}s`;
  return String(row.target);
}

/**
 * Every catalog metric an SLO row reads. Exported for the parity test, which
 * asserts each one is a real `METRIC_CATALOG` entry — an SLO computed from a
 * metric this host does not emit would sit at `empty` forever and read as
 * "quiet", which is the failure mode hardest to notice.
 */
export function sloMetricNames(): readonly string[] {
  const names = new Set<string>();
  for (const spec of SLO_CATALOG) {
    names.add(spec.metric);
    for (const m of ratioMetrics(spec)) names.add(m);
  }
  return [...names];
}

/** True when every metric an SLO reads is declared in `METRIC_CATALOG`. */
export function unknownSloMetrics(): readonly string[] {
  const declared = new Set(METRIC_CATALOG.map((m) => m.name));
  return sloMetricNames().filter((n) => !declared.has(n));
}

/**
 * Rows whose `threshold_share` threshold is NOT a declared bucket boundary of
 * their metric — i.e. rows that could only be answered by interpolating.
 *
 * Exported so a test can assert the set is EMPTY. If a future row lands here it
 * must be marked `not_projectable` rather than silently estimated: an estimate
 * that looks like a measurement is the failure this whole phase is about.
 */
export function nonExactQuantileRows(): readonly string[] {
  const buckets = new Map(METRIC_CATALOG.map((m) => [m.name, m.buckets ?? []]));
  return SLO_CATALOG
    .filter((s) => s.objective.kind === 'threshold_share' && !s.notProjectable)
    .filter((s) => {
      const o = s.objective as Extract<SloObjective, { kind: 'threshold_share' }>;
      return !(buckets.get(s.metric) ?? []).includes(o.threshold);
    })
    .map((s) => s.id);
}
