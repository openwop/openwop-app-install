/**
 * OTel METRICS under the `openwop.*` namespace — ADR 0556 P0.
 *
 * ADR 0118 installed the trace half only. This is the metric half: a meter
 * provider, an OTLP export path, a graceful shutdown that flushes, a CLOSED
 * catalog of the metrics this host emits, and the cardinality guard.
 *
 * Mirrors `tracer.ts` deliberately (same init/shutdown shape, same env var, same
 * lazy singleton) so operators configure one endpoint and get both, and so the
 * SIGTERM path has one thing to learn.
 *
 * ── WHY THE GUARD REFUSES INSTEAD OF SANITISING ────────────────────────────
 *
 * The obvious reuse is the logger's `scrubFields` seam — secret scrub + PII
 * mask, already central, already applied to every field. It is the wrong tool
 * here, in a way that would have looked right:
 *
 *   1. `maskPiiValue` is `pii_${sha256(value).slice(0,10)}` — a STABLE
 *      pseudonym. One tenant still maps to exactly one label value, so a masked
 *      `tenantId` produces exactly as many time series as the raw one. It would
 *      look like a guard and protect nothing.
 *   2. Its own contract exempts the worst offenders: "Operational fields
 *      (`runId`, `count`, `status`) are never touched" — and `runId` is the
 *      canonical unbounded label.
 *
 * Cardinality is not a secrecy property. A label is dangerous because of how
 * MANY values it can take, which no value-transform changes. So the guard drops
 * the label rather than rewriting it.
 *
 * ── AND WHY IT NEVER THROWS ────────────────────────────────────────────────
 *
 * Same rule the logger states: instrumentation must never break the code path
 * that was only trying to measure something. A violation drops the offending
 * LABEL, keeps the measurement, and records the violation so a test (and an
 * operator) can see it. Dropping the whole measurement would make the metric
 * lie in the opposite direction — a counter that silently under-counts is worse
 * than one missing a dimension.
 */

import { metrics as metricsApi, type Attributes, type Counter, type Gauge, type Histogram } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { createLogger } from './logger.js';

const log = createLogger('observability.metrics');

/**
 * Label names that may NEVER appear on a metric, whatever a catalog entry says.
 *
 * Each is unbounded in the number of distinct values it can take, so using one
 * turns a metric into a per-entity time series and takes the collector down.
 * The failure is operational, arrives late, and is invisible to a unit test that
 * merely asserts a counter incremented — which is why this is enforced in code
 * and by `scripts/check-metric-labels.mjs`, not by review.
 *
 * `path` is here for the same reason: a URL path carrying ids (`/v1/runs/<id>`)
 * is unbounded. Instrument the ROUTE TEMPLATE (`route`), never the resolved path.
 */
export const FORBIDDEN_LABELS: readonly string[] = [
  'tenantId', 'tenant_id', 'tenant',
  'runId', 'run_id',
  'userId', 'user_id', 'principalId', 'principal_id',
  'workflowId', 'workflow_id',
  'conversationId', 'conversation_id',
  'nodeId', 'node_id',
  'email', 'path', 'url', 'sessionId', 'session_id',
  'traceId', 'trace_id', 'spanId', 'span_id',
  'idempotencyKey', 'idempotency_key',
];

/** A metric this host emits, with the CLOSED set of labels it may carry. */
export interface MetricSpec {
  readonly name: string;
  readonly description: string;
  /**
   * `gauge` (ADR 0551 P2) is a SYNCHRONOUS gauge — a value the host SETS when
   * it observes it, not an observable with a collection callback. Deliberate:
   * the two queue-depth signals are already computed once per sweeper tick by
   * the code that has the storage handle, and an observable callback would need
   * its own database round trip on the exporter's schedule, from a context with
   * no error path. A synchronous gauge also flows through the same
   * `guardAttributes` choke and the same emission ledger as the other two kinds,
   * so a golden test asserts a gauge exactly as it asserts a counter.
   */
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly unit?: string;
  /** The only attribute keys this metric accepts. Closed on purpose — an
   *  unknown key is refused rather than passed through, because the dangerous
   *  case is a key whose NAME is computed at the call site. */
  readonly labels: readonly string[];
  /** Explicit bucket boundaries for histograms (seconds unless `unit` says otherwise). */
  readonly buckets?: readonly number[];
}

/**
 * THE CATALOG. Every metric this host emits is declared here and nowhere else.
 *
 * A catalog exists so the label sets are reviewable in one place and lintable by
 * a script. Adding a metric at a call site instead of here is what the closed
 * lookup in `counter()`/`histogram()` prevents.
 *
 * P0 declares the seams P1 will instrument; it does not instrument them. The
 * declarations are the contract the cardinality lint runs against.
 */
export const METRIC_CATALOG: readonly MetricSpec[] = [
  {
    name: 'openwop.run.started',
    description: 'Workflow runs started.',
    kind: 'counter',
    labels: ['workflow_kind', 'trigger'],
  },
  {
    name: 'openwop.run.completed',
    description: 'Workflow runs reaching a terminal state.',
    kind: 'counter',
    labels: ['workflow_kind', 'status'],
  },
  {
    name: 'openwop.webhook.first_attempt_delay',
    description:
      'Delay from enqueueing an outbound webhook delivery to its FIRST attempt. ' +
      'WHD-1: a slow subscriber starved unrelated ones and a healthy subscriber\u2019s ' +
      'first attempt arrived ~5.5 min after its event against a configured 2s backoff. ' +
      'A failure counter cannot see that \u2014 those deliveries eventually SUCCEEDED.',
    kind: 'histogram',
    unit: 's',
    // `outcome` only. Deliberately NOT subscriptionId (unbounded cardinality on a
    // host-wide SLO) and NOT url (a subscriber URL can carry a token in its query
    // string \u2014 see redactUrlForLog). Same rule as
    // `openwop.http.server.duration`: "by ROUTE TEMPLATE (never the resolved path)".
    labels: ['outcome'],
    // Same boundaries as `openwop.run.duration`. This is load-bearing, not
    // cosmetic: sloProjection.ts:170-177 computes a threshold_share EXACTLY as
    // count(le=T)/count, so the SLO's threshold MUST be a declared boundary here
    // or the objective is uncomputable. Q1's threshold is 30 \u2014 present below.
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
  },
  {
    name: 'openwop.run.duration',
    description: 'Wall-clock duration of a workflow run.',
    kind: 'histogram',
    unit: 's',
    labels: ['workflow_kind', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 900],
  },
  {
    name: 'openwop.http.server.duration',
    description: 'HTTP server request duration, by ROUTE TEMPLATE (never the resolved path).',
    kind: 'histogram',
    unit: 's',
    // `stream` (ADR 0556 P2) is a TWO-value domain set from the rate limiter's
    // own `isLongLivedSseStream(req)` predicate. It exists so the latency
    // objectives can exclude EventStream connections — whose duration is a
    // browser tab's lifetime, not a request latency — WITHOUT a second list of
    // which routes are streams, and without mistaking the JSON polling mode of
    // `/v1/runs/:runId/events` for the SSE mode it shares a path with.
    labels: ['route', 'method', 'status_class', 'stream'],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  },
  {
    name: 'openwop.effect.dispatched',
    description: 'External effects dispatched through the ADR 0531 effect seam.',
    kind: 'counter',
    labels: ['effect_kind', 'outcome'],
  },
  {
    name: 'openwop.provider.call',
    description: 'Model-provider calls, by provider and outcome.',
    kind: 'counter',
    labels: ['provider', 'outcome'],
  },

  /* ── ADR 0556 P1 additions ─────────────────────────────────────────────── *
   * Every label domain below is a CLOSED set owned by `metricSeams.ts`, which
   * is where the mapping from a runtime value to a label lives. The rule that
   * makes these safe is the same one P0 set: if a dimension's value set is
   * decided by a caller, a tenant or a peer, it is not a label.               */

  {
    name: 'openwop.node.duration',
    description: 'Wall-clock duration of ONE node execution attempt (step latency).',
    kind: 'histogram',
    unit: 's',
    // Deliberately NOT labelled by node typeId. It reads bounded (~200 core
    // types) but a tenant-installed pack mints new ones, so its size is
    // operator-controlled — the definition of an unbounded label. Per-type
    // latency belongs on the node span, which already carries `openwop.node_type`.
    labels: ['status', 'replayed'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  },
  {
    name: 'openwop.replay.node.served',
    description: 'Side-effecting nodes served from the source run instead of re-executing (ADR 0341 fast path).',
    kind: 'counter',
    labels: ['outcome'],
  },
  {
    name: 'openwop.idempotency.claim',
    description: 'Idempotency-Key claims against the ADR 0549 ledger, by endpoint and outcome.',
    kind: 'counter',
    // `endpoint` is the `IdempotentEndpoint` union — a compile-time-closed set of
    // two route literals, NOT a resolved path. The key and the request digest are
    // caller-supplied and carry customer identifiers (ADR 0549 P2 log hygiene);
    // the tenant id is unbounded. None of the three is a label here, and
    // `idempotencyKey` is in FORBIDDEN_LABELS so the guard refuses it too.
    labels: ['endpoint', 'outcome'],
  },
  {
    name: 'openwop.interrupt.created',
    description: 'Run interrupts created (HITL gates, timers, tour steps).',
    kind: 'counter',
    labels: ['interrupt_kind'],
  },
  {
    name: 'openwop.interrupt.age',
    description: 'Age of an interrupt at the moment it resolved (created → resolved).',
    kind: 'histogram',
    unit: 's',
    // Buckets span a second to a week: an approval waiting on a human is a
    // fundamentally different distribution from a timer, and the SLO ("no
    // interrupt outlives its expiry unresolved") lives out at the long end.
    labels: ['interrupt_kind', 'resolution'],
    buckets: [1, 10, 60, 300, 900, 3600, 14_400, 86_400, 604_800],
  },
  {
    name: 'openwop.authz.decision',
    description: 'Authorization decisions at a host authority seam, by outcome and issuer class.',
    kind: 'counter',
    labels: ['outcome', 'issuer_class'],
  },
  {
    name: 'openwop.effect.blocked',
    description: 'Effects refused by the ADR 0531 replay backstop (a fail-closed bug report, not a steady state).',
    kind: 'counter',
    labels: ['effect_kind'],
  },
  {
    name: 'openwop.compensation.obligation',
    description: 'Compensation obligations recorded when a forward effect committed (RFC 0151 §C).',
    kind: 'counter',
    labels: ['effect_kind', 'shape'],
  },
  {
    name: 'openwop.compensation.resolved',
    description: 'Compensation obligation transitions (RFC 0151 §D state vocabulary).',
    kind: 'counter',
    labels: ['effect_kind', 'state'],
  },
  {
    name: 'openwop.compensation.recovery',
    description: 'Operator recovery actions on a compensation obligation (ADR 0554 P3 / RFC 0151 §E).',
    kind: 'counter',
    // Both labels are CLOSED sets the host owns, so the series count is bounded
    // at |action| x |outcome| = 5 x 4 forever. No obligation id, run id, tenant
    // or principal appears — each is unbounded, and the whole point of the
    // recovery counter is to be readable next to `openwop.compensation.resolved`
    // rather than to identify anyone.
    labels: ['action', 'outcome'],
  },
  {
    name: 'openwop.a2a.request',
    description: 'Inbound A2A JSON-RPC requests, by method class and outcome.',
    kind: 'counter',
    // `method` is CLASSIFIED against the served set — a peer picks the string, so
    // anything unhandled folds to `unknown` rather than minting a series.
    labels: ['method', 'outcome'],
  },
  {
    name: 'openwop.mcp.request',
    description: 'MCP requests (inbound server + outbound client), by method class and outcome.',
    kind: 'counter',
    labels: ['direction', 'method', 'outcome'],
  },
  {
    name: 'openwop.protocol.version',
    description: 'Protocol version negotiation dispositions for A2A and MCP.',
    kind: 'counter',
    // The REQUESTED version is peer-supplied and therefore unbounded; only the
    // disposition (absent / served / unsupported / mismatch) is a label.
    //
    // `profile` added 2026-08-18 (ADR 0552 P4 / 0553 P4). It is the profile this
    // host SERVED, not anything the peer sent, so it is a closed four-value set
    // (`a2a-1.0`, `a2a-0.3-legacy`, `mcp-2026-07-28`, `mcp-2025-06-18-legacy`)
    // plus `none` when nothing was served. Without it, "legacy-profile usage
    // evidence" — the exit criterion for BOTH deprecations — cannot be produced
    // from this host's telemetry at all: `protocol: 'a2a'` alone cannot tell 0.3
    // from 1.0, which is the only question the retirement asks.
    labels: ['protocol', 'disposition', 'profile'],
  },
  {
    name: 'openwop.sandbox.execution',
    description: 'Sandboxed code executions by runtime, with resource and escape failures classified.',
    kind: 'counter',
    labels: ['runtime', 'outcome'],
  },
  {
    name: 'openwop.attestation.age',
    description: 'Age of the deployment attestation manifest when read (ADR 0550 assurance freshness).',
    kind: 'histogram',
    unit: 's',
    labels: ['state', 'environment_class'],
    buckets: [3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000],
  },

  /* ── ADR 0551 P2 — dispatch-outbox backlog + recovery ──────────────────── *
   * `docs/SLO.md` listed these three under "Not yet measurable" and said why:
   * the outbox did not exist, and instrumenting a queue that does not exist
   * produces three metrics permanently at zero, which reads as health. P1
   * shipped the queue; these are the signals it deliberately did not add.     */

  {
    name: 'openwop.dispatch.outbox.depth',
    description: 'Dispatch-outbox rows by state, observed once per sweeper pass.',
    kind: 'gauge',
    // The state column's CHECK constraint IS the closed set — `pending` and
    // `dead` are the only two values the table admits (a discharged intent is
    // DELETED, so there is no third). Not labelled by tenant or workflow: both
    // are unbounded, and per-tenant backlog is a log/span question.
    labels: ['state'],
  },
  {
    name: 'openwop.dispatch.outbox.oldest_age',
    description: 'Age of the OLDEST pending dispatch intent — how long an accepted run has waited to be started.',
    kind: 'gauge',
    unit: 's',
    // Unlabelled on purpose. The only dimension that would be interesting is
    // which tenant is stuck, and that is the unbounded one; the run id is on
    // the operator projection, where a single id is exactly the right shape.
    labels: [],
  },
  /* ── ADR 0555 P2 — isolated pack dispatch ──────────────────────────────── *
   * Distinct from `openwop.sandbox.execution`, which counts ADR 0114/0146
   * code-exec of a SOURCE STRING. This counts a pack NODE run out of the host's
   * trust domain — a different unit of work with a different failure set, and
   * folding them onto one metric would put "a user's python snippet timed out"
   * and "a community pack was killed for exhausting its heap" on one line.     */
  {
    name: 'openwop.pack.isolation.dispatch',
    description: 'Pack-node dispatches through an isolation adapter, by adapter and outcome (ADR 0555 P2).',
    kind: 'counter',
    // Both closed and owned by `metricSeams.ts`. Deliberately NOT labelled by
    // pack name or typeId: a marketplace makes both unbounded, and "which pack"
    // is a log/span question — the same call `openwop.dispatch.outbox.*` makes
    // about tenant.
    labels: ['adapter', 'outcome'],
  },
  {
    name: 'openwop.dispatch.lease.recovered',
    description: 'Dispatch intents a leased worker acted on, by lane and what it did.',
    kind: 'counter',
    // Both domains are closed and owned by `metricSeams.ts`. `outcome` includes
    // `dead` because attempts-exhausted is the outcome an operator most needs a
    // rate for — it is the one that leaves a row behind for the redrive surface.
    labels: ['lane', 'outcome'],
  },
  {
    name: 'openwop.kanban.work_item.delivery',
    description: 'Reusable Kanban WorkItem delivery decisions, by policy mode and bounded outcome.',
    kind: 'counter',
    // Both dimensions are core enums, never board, workflow, canvas, or tenant
    // identifiers. Those belong in the audit/log path, not an unbounded metric.
    labels: ['mode', 'outcome'],
  },
];

const SPECS = new Map(METRIC_CATALOG.map((m) => [m.name, m]));

/** Violations observed since boot, keyed `<metric>:<label>`. Exported so a test
 *  can assert the guard FIRED, rather than inferring it from an absence. */
const violations = new Map<string, number>();

/** How many times `<metric>:<label>` was refused. */
export function labelViolations(): ReadonlyMap<string, number> {
  return violations;
}

/** One recorded measurement, as it reached the instrument — i.e. AFTER the
 *  cardinality guard, so a test asserts the label set an exporter would see. */
export interface MetricEmission {
  readonly name: string;
  readonly value: number;
  readonly attributes: Attributes;
}

/**
 * Emission ledger — the ONLY way a test can see what was recorded.
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the meter provider carries zero
 * readers, so an emitted measurement is genuinely unobservable: an assertion on
 * a counter would have nothing to read and a "golden telemetry test" would be
 * asserting on its own mock. This ledger records at the same choke the
 * instrument does, after guarding, so the thing asserted IS the thing exported.
 *
 * `null` until a test arms it, which is what keeps production free: recording
 * costs one null check and the array never exists outside a suite.
 */
let emissions: MetricEmission[] | null = null;

/** Emissions of ONE metric, in record order. */
export function emissionsOf(name: string): readonly MetricEmission[] {
  return (emissions ?? []).filter((e) => e.name === name);
}

/**
 * When each catalog metric last had a measurement RECORDED — ADR 0556 P2.
 *
 * Freshness has to be captured here, at record time, and not derived at
 * collection time. A cumulative data point's `endTime` is the moment the reader
 * collected it, so a counter that stopped ticking an hour ago still presents a
 * timestamp from one millisecond ago. Reading staleness off the snapshot would
 * therefore report every dead series as perfectly fresh — the single most
 * dangerous direction for an operations panel to be wrong in, because a stopped
 * sweeper and a healthy one become indistinguishable.
 *
 * Unlike the emission ledger above, this is LIVE IN PRODUCTION and always
 * armed: the SLO projection reads it to answer "does this series still have a
 * pulse". It costs one `Map.set` per measurement over at most
 * `METRIC_CATALOG.length` keys, so it is bounded by the catalog and cannot grow.
 */
const lastEmissionAtMs = new Map<string, number>();

/** A snapshot of the whole freshness map — what the SLO projection consumes. */
export function lastEmissionMap(): ReadonlyMap<string, number> {
  return new Map(lastEmissionAtMs);
}

/** The ONE post-record bookkeeping choke, shared by counter/histogram/gauge so
 *  a fourth instrument kind cannot be added with only half of it. */
function noteEmission(name: string, value: number, attributes: Attributes): void {
  lastEmissionAtMs.set(name, Date.now());
  emissions?.push({ name, value, attributes });
}

/** Test seam — clears the violation ledger, the meter cache, and ARMS the
 *  emission ledger. Production never calls this, so `emissions` stays `null`. */
export function _resetMetricsForTest(): void {
  violations.clear();
  counters.clear();
  histograms.clear();
  gauges.clear();
  lastEmissionAtMs.clear();
  emissions = [];
  // ADR 0556 P2 — the provider goes too, and that is not tidiness.
  //
  // `createMetrics` returns the existing provider if one is set, so WITHOUT
  // this the first `createApp` in a vitest worker decides for every later file
  // in that worker whether local-scrape is on. Worse: re-creating an identical
  // instrument re-binds the SAME MeterSharedState storage, so CUMULATIVE COUNTS
  // SURVIVE a reset that only clears the caches above — a test asserting
  // `empty`, or a specific ratio, then passes or fails according to which files
  // the worker happened to run first. That is a gate whose verdict depends on
  // scheduling, which is the same class as a gate that cannot fail.
  _resetMetricsProviderForTest();
}

/**
 * Drop every attribute the spec does not allow, and every forbidden name
 * whatever the spec says.
 *
 * The forbidden check runs even for a declared label so that a catalog entry
 * cannot authorise `runId` by declaring it — the static lint should catch that
 * first, but a guard whose only defence is another check is not a guard.
 */
export function guardAttributes(spec: MetricSpec, attrs: Attributes | undefined): Attributes {
  if (!attrs) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    const forbidden = FORBIDDEN_LABELS.includes(k);
    const undeclared = !spec.labels.includes(k);
    if (forbidden || undeclared) {
      const key = `${spec.name}:${k}`;
      const seen = violations.get(key) ?? 0;
      violations.set(key, seen + 1);
      // Log ONCE per (metric,label). A guard that logs on every record turns a
      // cardinality problem into a log-volume problem.
      if (seen === 0) {
        log.warn('metric_label_refused', {
          metric: spec.name,
          label: k,
          reason: forbidden ? 'forbidden_unbounded_label' : 'not_declared_in_catalog',
        });
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function specFor(name: string): MetricSpec {
  const spec = SPECS.get(name);
  // A metric absent from the catalog is a programming error, and it is the one
  // case worth throwing on: it happens at the call site during development, not
  // in a request path in production, and silently inventing a metric is how a
  // catalog stops being the source of truth.
  if (!spec) throw new Error(`metric '${name}' is not in METRIC_CATALOG — declare it there first`);
  return spec;
}

/** Record on a catalog counter, with the attributes guarded. */
export function addCount(name: string, value: number, attrs?: Attributes): void {
  const spec = specFor(name);
  if (spec.kind !== 'counter') throw new Error(`metric '${name}' is a ${spec.kind}, not a counter`);
  let c = counters.get(name);
  if (!c) {
    c = metricsApi.getMeter('openwop').createCounter(name, { description: spec.description, unit: spec.unit });
    counters.set(name, c);
  }
  const guarded = guardAttributes(spec, attrs);
  c.add(value, guarded);
  noteEmission(name, value, guarded);
}

/** Record on a catalog histogram, with the attributes guarded. */
export function recordValue(name: string, value: number, attrs?: Attributes): void {
  const spec = specFor(name);
  if (spec.kind !== 'histogram') throw new Error(`metric '${name}' is a ${spec.kind}, not a histogram`);
  let h = histograms.get(name);
  if (!h) {
    h = metricsApi.getMeter('openwop').createHistogram(name, {
      description: spec.description,
      unit: spec.unit,
      advice: spec.buckets ? { explicitBucketBoundaries: [...spec.buckets] } : undefined,
    });
    histograms.set(name, h);
  }
  const guarded = guardAttributes(spec, attrs);
  h.record(value, guarded);
  noteEmission(name, value, guarded);
}

/** Set a catalog gauge to an observed value, with the attributes guarded. */
export function setGauge(name: string, value: number, attrs?: Attributes): void {
  const spec = specFor(name);
  if (spec.kind !== 'gauge') throw new Error(`metric '${name}' is a ${spec.kind}, not a gauge`);
  let g = gauges.get(name);
  if (!g) {
    g = metricsApi.getMeter('openwop').createGauge(name, { description: spec.description, unit: spec.unit });
    gauges.set(name, g);
  }
  const guarded = guardAttributes(spec, attrs);
  g.record(value, guarded);
  noteEmission(name, value, guarded);
}

let provider: MeterProvider | null = null;

/**
 * ADR 0556 P2 — the LOCAL-SCRAPE operator profile.
 *
 * A `MetricReader` with no exporter and no timer. Its only job is to hold the
 * SDK's aggregation state in this process so `collect()` can be called on
 * demand, which is what lets the Operations SLO projection read back the
 * host's own instruments.
 *
 * ── WHY A SECOND READER AND NOT A SECOND ANYTHING ELSE ─────────────────────
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the provider carries ZERO readers,
 * so every measurement this host records is genuinely unobservable from inside
 * the process. A projection therefore had three ways to get a number, and two
 * of them are the mistakes this ADR exists to avoid:
 *
 *   • Query an external metrics backend — that IS the "second metrics database"
 *     ADR 0556's decision section forbids, and it makes an operator console
 *     depend on credentials for a system the console is supposed to be able to
 *     diagnose the loss of.
 *   • Keep a bespoke rolling aggregator beside the OTel instruments — a second
 *     telemetry path with its own definition of every SLI, which is precisely
 *     what ADR 0549 P2 refused to stand up and what this ADR was written to
 *     prevent.
 *   • Add a reader to the provider that already exists. Same instruments, same
 *     catalog, same cardinality guard, same emission choke. Nothing new is
 *     measured; the numbers merely stop being write-only.
 *
 * ADR 0556 names this option itself: "production qualification does require a
 * healthy exporter **or an explicit local-scrape operator profile**".
 *
 * OPT-IN (`OPENWOP_METRICS_LOCAL_SCRAPE=true`), because it is not free: holding
 * cumulative aggregation state for every series costs memory proportional to
 * the label-value cross-product, and a host that ships to a collector does not
 * need it. Off, the projection answers `unknown` for every objective — which is
 * the honest answer and NOT a health claim.
 */
export class LocalScrapeMetricReader extends MetricReader {
  constructor() {
    super({
      /**
       * CUMULATIVE, pinned explicitly rather than inherited.
       *
       * Under DELTA temporality `collect()` is DESTRUCTIVE — each call drains
       * what accumulated since the last one — so a projection would report the
       * traffic between two panel refreshes rather than the totals, two
       * operators looking at once would each see a fraction of the truth, and
       * every reading would be unrepeatable. Cumulative is the SDK default
       * today; inheriting a default that a future SDK bump could flip would
       * turn this whole surface into a silent lie, and the failure would look
       * like "the numbers went weird" rather than like a version change.
       */
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
      /**
       * The series ceiling, also pinned explicitly — and this one is not
       * hypothetical.
       *
       * The SDK's default is 2000 (`DeltaMetricProcessor`:
       * `(aggregationCardinalityLimit ?? 2000) - 1`). This app registers
       * ~1595 express routes, and `openwop.http.server.duration` is labelled
       * `{route, method, status_class, stream}` — so its series count is
       * bounded by routes × methods × classes × 2, which is far past 2000. Past
       * the limit the SDK does not drop the measurement and does not warn: it
       * folds it into a single bucket attributed `otel.metric.overflow: true`.
       *
       * A ratio computed over a partially-overflowed series is arithmetically
       * fine and semantically garbage — the numerator and denominator no longer
       * describe the same population. So the limit is raised to something this
       * app's real label domains fit inside, AND the projection detects the
       * overflow sentinel and marks the row `degraded` instead of computing.
       * Raising the limit alone would only move the cliff.
       */
      cardinalitySelector: () => localScrapeCardinalityLimit(),
    });
  }
  protected async onForceFlush(): Promise<void> { /* nothing is buffered — collect() is synchronous state */ }
  protected async onShutdown(): Promise<void> { /* no exporter, no connection, nothing to close */ }
}

/**
 * Series ceiling for the local-scrape reader.
 *
 * Sized against the largest domain in the catalog: ~1595 route templates ×
 * {GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS,other} × {1xx..5xx,unknown} ×
 * {stream true,false} is the theoretical worst case, but the REACHABLE set is
 * far smaller — a given route serves one or two methods and two or three status
 * classes. 20000 covers the realistic ceiling with headroom while still being a
 * bound rather than "unlimited", which is the point: an unbounded aggregation is
 * the memory leak this whole guard exists to prevent, and a limit that is never
 * reached is still the thing that makes the failure mode observable.
 */
export const LOCAL_SCRAPE_CARDINALITY_DEFAULT = 20_000;

/**
 * Read at READER-CONSTRUCTION time, not at module load.
 *
 * A module-level `const` would freeze the value at import, which makes the
 * ceiling untestable: a test could not lower it to a handful of series and
 * watch the SDK actually start folding. An untestable ceiling is one nobody can
 * prove is wired — and a `cardinalitySelector` that is silently ignored looks
 * exactly like one that works, right up until production overflows.
 */
export function localScrapeCardinalityLimit(): number {
  const raw = Number(process.env.OPENWOP_METRICS_LOCAL_SCRAPE_MAX_SERIES);
  return Number.isFinite(raw) && raw > 0 ? raw : LOCAL_SCRAPE_CARDINALITY_DEFAULT;
}

/** The attribute the SDK stamps on the bucket it folds over-limit series into. */
export const OVERFLOW_ATTRIBUTE = 'otel.metric.overflow';

let localScrapeReader: LocalScrapeMetricReader | null = null;
let localScrapeStartedAtMs: number | null = null;

/** Is the local-scrape operator profile active on this instance? */
export function localScrapeEnabled(): boolean {
  return localScrapeReader !== null;
}

/** When this instance began aggregating — the START of the only window a
 *  local scrape can honestly describe. `null` when the profile is off. */
export function localScrapeStartedAt(): number | null {
  return localScrapeStartedAtMs;
}

/**
 * Collect the CURRENT aggregation of every instrument, or `null` when the
 * local-scrape profile is off.
 *
 * The values are CUMULATIVE SINCE THIS PROCESS STARTED and describe THIS
 * INSTANCE only — not the 28-day rolling, fleet-wide window `docs/SLO.md`
 * declares. Every caller must say so; the projection does.
 */
export async function collectLocalScrape(): Promise<ResourceMetrics | null> {
  if (!localScrapeReader) return null;
  const { resourceMetrics } = await localScrapeReader.collect();
  return resourceMetrics;
}

export interface MetricsInit {
  serviceName: string;
  serviceVersion: string;
}

/**
 * Initialise the meter provider. Idempotent, like `createTracer`.
 *
 * NO EXPORTER, NO READER. Without `OTEL_EXPORTER_OTLP_ENDPOINT` the provider is
 * created with zero readers, so instruments are real but nothing is collected or
 * shipped — the same posture the tracer takes, and the reason a dev box and the
 * test suite pay nothing for instrumentation they never scrape. This is
 * deliberately NOT a console exporter: a metrics console exporter prints the
 * whole series set on every interval and would drown the log.
 */
export function createMetrics(init: MetricsInit): MeterProvider {
  if (provider) return provider;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const readers: MetricReader[] = [];
  if (endpoint) {
    readers.push(new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint.replace(/\/+$/, '')}/v1/metrics` }),
      exportIntervalMillis: Number(process.env.OPENWOP_METRICS_EXPORT_INTERVAL_MS ?? 60_000),
    }));
  }
  // ADR 0556 P2 — independent of the exporter on purpose. An operator running
  // BOTH ships to a collector and can still read the panel; an operator running
  // only this one has no collector and the panel is the only view there is.
  if (process.env.OPENWOP_METRICS_LOCAL_SCRAPE === 'true') {
    localScrapeReader = new LocalScrapeMetricReader();
    localScrapeStartedAtMs = Date.now();
    readers.push(localScrapeReader);
  }
  provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: init.serviceName,
      [ATTR_SERVICE_VERSION]: init.serviceVersion,
    }),
    readers,
  });
  metricsApi.setGlobalMeterProvider(provider);
  return provider;
}

/**
 * Flush and tear down on graceful shutdown, mirroring `shutdownTracer` (DATA-4).
 *
 * A metrics reader batches by interval, so an un-flushed shutdown loses up to a
 * full interval of counts — which shows up as a phantom traffic dip at exactly
 * the moment an operator is looking at a deploy.
 */
export async function shutdownMetrics(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
    await provider.shutdown();
  } catch (err) {
    // Never throw out of shutdown: a failed metric flush must not stop the
    // process from exiting within its grace deadline.
    console.error('[otel] metrics shutdown/flush failed:', err);
  } finally {
    provider = null;
    localScrapeReader = null;
    localScrapeStartedAtMs = null;
  }
}

/**
 * Test seam — drop the provider singleton so the NEXT `createMetrics` re-reads
 * the environment.
 *
 * `createMetrics` is idempotent by design (it returns the existing provider),
 * which means a suite that sets `OPENWOP_METRICS_LOCAL_SCRAPE` after some
 * earlier boot in the same worker would get a provider with no local-scrape
 * reader and a projection that answers `unknown` — a test asserting a real
 * value would then fail for a reason that has nothing to do with the code under
 * test. Resetting is cheaper than debugging that twice.
 */
export function _resetMetricsProviderForTest(): void {
  provider = null;
  localScrapeReader = null;
  localScrapeStartedAtMs = null;
  // Drop the GLOBAL registration too. `metricsApi.getMeter()` is what every
  // instrument above resolves through, and leaving a shut-down provider
  // registered globally hands the next `createMeter` a stale meter whose
  // storage belongs to the previous test's provider.
  metricsApi.disable();
}
