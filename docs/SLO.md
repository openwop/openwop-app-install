# Service level objectives — openwop-app

Status: declared 2026-08-16 with ADR 0556 P1. These are TARGETS the host now
has the telemetry to measure. They are not a contractual commitment, and this
document says so at the top on purpose: an SLO published before anyone has ever
computed it is marketing, and the honest state today is "measurable, not yet
measured against a production baseline".

Every objective below names the exact catalog metric it is computed from
(`backend/typescript/src/observability/metrics.ts`). An objective with no metric
is not an objective; if you cannot point at the series, do not add the row.

## How to read these

- **SLI** — the measurement. Always a ratio or a quantile over a rolling window.
- **Objective** — the target the SLI must hold.
- **Window** — 28 days rolling, unless the row says otherwise. Long enough that
  one bad deploy does not consume the budget, short enough to still be about
  now.
- **Error budget** — `1 − objective` over the window. A burned budget is a
  signal to stop shipping features and fix reliability, which is the only thing
  an SLO is actually for.

## Alerts and the runbook

Added 2026-08-17 with ADR 0556 P2, which made these objectives readable inside
the host: the Operations hub projects every row below and raises an alert when
one breaches. **What to DO about each alert lives in
[`runbooks/slo-alerts.md`](runbooks/slo-alerts.md)** — one section per alert,
linked directly from the panel. `SLO_CATALOG` in
`backend/typescript/src/observability/sloProjection.ts` is the executable half
of this document, and `test/slo-projection-doc-parity.test.ts` holds the two in
bijection so neither can drift.

| Alert | Severity | Fires when | Runbook |
|---|---|---|---|
| A1 | page | `5xx` share exceeds 0.5% | [A1 HTTP availability](runbooks/slo-alerts.md#a1-http-availability) |
| A2 A3 | ticket | share within 1.0 s below 95% / within 5.0 s below 99%, non-stream | [A2 A3 HTTP latency](runbooks/slo-alerts.md#a2-a3-http-latency) |
| W1 | ticket | run success below 97% | [W1 Run success rate](runbooks/slo-alerts.md#w1-run-success-rate) |
| W2 W3 | ticket | chain p95 > 300 s / node p95 > 30 s | [W2 W3 Execution latency](runbooks/slo-alerts.md#w2-w3-execution-latency) |
| W4 | ticket | node failure share above 3% | [W4 Node failure rate](runbooks/slo-alerts.md#w4-node-failure-rate) |
| R1 | **page** | any blocked effect | [R1 Blocked effect](runbooks/slo-alerts.md#r1-blocked-effect) |
| R2 | ticket | `source-missing` above 0.1% | [R2 Replay source missing](runbooks/slo-alerts.md#r2-replay-source-missing) |
| I1 | ticket | `mismatch` above 0.5% | [I1 Idempotency mismatch](runbooks/slo-alerts.md#i1-idempotency-mismatch) |
| I2 | **page** | `reclaimed` above 0.1% | [I2 Idempotency reclaimed](runbooks/slo-alerts.md#i2-idempotency-reclaimed) |
| I3 | ticket | `in-flight` above 1% | [I3 Idempotency in flight](runbooks/slo-alerts.md#i3-idempotency-in-flight) |
| C1 | **page** | manual intervention above 0.1% | [C1 Manual compensation](runbooks/slo-alerts.md#c1-manual-compensation) |
| C2 | — | never fires — not projectable | [C2 Slow compensation](runbooks/slo-alerts.md#c2-slow-compensation) |
| H1 | ticket | approval p95 age > 4 h | [H1 Approval wait](runbooks/slo-alerts.md#h1-approval-wait) |
| H2 | **page** | approval timeouts above 5% | [H2 Approval timeout](runbooks/slo-alerts.md#h2-approval-timeout) |
| P1 P2 | ticket | inbound `internal_error` above 0.5% | [P1 P2 Protocol internal errors](runbooks/slo-alerts.md#p1-p2-protocol-internal-errors) |
| P3 | ticket | outbound MCP success below 98% | [P3 Outbound MCP failures](runbooks/slo-alerts.md#p3-outbound-mcp-failures) |
| P4 | ticket | `unsupported` above 1% | [P4 Unsupported protocol versions](runbooks/slo-alerts.md#p4-unsupported-protocol-versions) |
| M1 | ticket | provider success below 97% | [M1 Provider failure rate](runbooks/slo-alerts.md#m1-provider-failure-rate) |
| M2 | ticket | rate-limited above 1% | [M2 Provider rate limiting](runbooks/slo-alerts.md#m2-provider-rate-limiting) |
| S1 | **page** | any escape attempt | [S1 Sandbox escape attempt](runbooks/slo-alerts.md#s1-sandbox-escape-attempt) |
| S2 S3 | ticket | exhaustion above 2% / timeout above 5% | [S2 S3 Sandbox capacity](runbooks/slo-alerts.md#s2-s3-sandbox-capacity) |
| F1 | ticket | attestation older than 7 days at read | [F1 Attestation freshness](runbooks/slo-alerts.md#f1-attestation-freshness) |
| F2 | **page** | any `invalid` attestation read | [F2 Invalid attestation](runbooks/slo-alerts.md#f2-invalid-attestation) |
| Q1 Q4 | ticket | Q4 above 5 dead intents (Q1 never fires) | [Q1 Q4 Outbox depth](runbooks/slo-alerts.md#q1-q4-outbox-depth) |
| K1 | ticket | Under 95% of first attempts start within 30s | [K1 Webhook delivery latency](runbooks/slo-alerts.md#k1-webhook-delivery-latency) |
| Q2 | **page** | oldest pending intent older than 120 s | [Q2 Outbox oldest age](runbooks/slo-alerts.md#q2-outbox-oldest-age) |
| Q3 | **page** | any intent given up on | [Q3 Dead dispatch intents](runbooks/slo-alerts.md#q3-dead-dispatch-intents) |

**Read the projection's window before acting on any of it.** The panel computes
from THIS INSTANCE's instruments, cumulative since the process started — not the
28-day rolling, fleet-wide window this document declares. That is a property of
where an in-process reader can get numbers from, not a defect to fix in the
panel, and ADR 0556 P2's implementation record sets out the alternatives that
were rejected. A freshly restarted instance shows 100% availability off four
requests, so `window.seconds` and `sampleCount` travel with every row.

### Not projectable in the Operations panel

Two published objectives cannot be answered from the metric catalog as they are
worded. The panel shows them with this reason instead of a number, and they
never raise an alert. **A number that answers a different question than its
label claims is worse than no number**, because nobody audits the ones that look
plausible.

This table is machine-checked: `test/slo-projection-doc-parity.test.ts` holds
the id set AND the reason text against `SLO_CATALOG`, so a row that silently
becomes projectable — or whose reason drifts from the code's — goes red until
someone updates both.

| # | Why the projection cannot answer it |
|---|---|
| C2 | needs each obligation's AGE, which no counter carries |
| Q1 | the objective is a level SUSTAINED over 5 minutes, and a single reading cannot tell a sustained backlog from one deep scrape |

For C2, `recorded − completed` is a different question (open right now, at any
age) wearing the same shape, which is precisely what would make substituting it
dangerous. Closing it needs an obligation-age histogram in the catalog, not a
projection change. For Q1, this document says it in its own voice two sections
down — "alert on a SUSTAINED level, never a single scrape" — so evaluating the
instantaneous value would produce exactly the alert that sentence forbids; the
depth is still SHOWN on the dispatch-outbox panel, it simply does not judge.

### Where the dispatch rows get their numbers

Q1, Q2 and Q4 are projected from **`storage.dispatchOutboxStats()`** — the
queue table — and not from the `openwop.dispatch.outbox.*` gauges named in
their Metric column. The gauges remain the signal exported to a collector; they
are the wrong source for a panel that is already rendering the authoritative
number a few hundred pixels higher up. Reading the gauge here would put two
numbers for one quantity on one page, and it would be the worse of the two: a
gauge is point-in-time, observed only on instances that actually run the
sweeper, and frozen at its last value on instances that do not. ADR 0556's
decision section describes exactly this — the projection "reads aggregated
telemetry **and health endpoints**".

**Percentile rows are computed EXACTLY, not estimated.** Every `pNN ≤ T` row's
threshold is already a declared bucket boundary of its metric (A2 `1`, A3 `5`,
W2 `300`, W3 `30`, H1 `14400`, F1 `604800`), so the panel evaluates
`count(≤ T) / count ≥ NN%` — the literal reading of the objective, with no
interpolation and no error bar. A test asserts that membership over the whole
catalog; a future row whose threshold is not a boundary is marked
`not_projectable` rather than quietly estimated.

**A `degraded` row means the panel refused to divide.** OpenTelemetry caps the
number of distinct time series per instrument and folds everything past the cap
into one bucket labelled `otel.metric.overflow` — silently, with no warning. A
ratio over a partly-folded series is arithmetically fine and semantically
meaningless, because the numerator and denominator no longer describe the same
population. The projection detects the sentinel and reports `degraded` with
`series.count` and `series.limit` in the response, rather than showing a
confident wrong number.

**A `stale` row is its own alert, one severity below the objective's.** It means
the emitter stopped, which no ratio can show — a frozen series still divides and
still compares, it just describes a moment that has passed.

*As shipped, no row declares a freshness horizon, so `stale` is currently
unreachable — and that is a deliberate result rather than an oversight.* Two
candidates were considered and both rejected: a zero-target row going quiet is
the objective being MET (`openwop.effect.blocked` recording nothing for an hour
is good news, not a page), and the HTTP histogram behind A1-A3 is the weakest
possible candidate despite looking like the strongest — the projection request
itself emits into it, so the check can never fail, and on a quiet host an
absence of samples just means an absence of traffic. The dispatch gauges would
have been the genuine case, but those rows now read the queue table instead. The
mechanism is kept because it is correct and a future gauge-backed objective will
need it, and a test pins that nothing declares one today, so re-adding a horizon
is a deliberate change rather than a drift.

`OTEL_EXPORTER_OTLP_ENDPOINT` must be set for any of this to leave the process.
Unset, the meter provider carries zero readers: the instruments are real, the
measurements are computed, and nothing is collected. That is the correct
default for a dev box and the wrong one for production — see ADR 0556's
"production qualification does require a healthy exporter or an explicit
local-scrape operator profile".

**`OPENWOP_METRICS_LOCAL_SCRAPE=true` is that local-scrape profile** (ADR 0556
P2). It adds a second reader to the SAME meter provider — no exporter, no timer,
no second catalog and no second emission path — purely so the process can read
its own instruments back and the Operations panel above has numbers to show. It
is independent of the exporter: an operator running both ships to a collector
AND gets the panel; an operator running only this one has no collector and the
panel is the only view there is. Off, every objective projects `unknown`, which
is the honest answer and explicitly not a health claim.

## Availability and latency

| # | SLI | Objective | Metric |
|---|---|---|---|
| A1 | Fraction of HTTP requests whose `status_class` is not `5xx` | ≥ 99.5% | `openwop.http.server.duration{status_class}` |
| A2 | p95 HTTP request duration, excluding SSE routes | ≤ 1.0 s | `openwop.http.server.duration` |
| A3 | p99 HTTP request duration, excluding SSE routes | ≤ 5.0 s | `openwop.http.server.duration` |

`4xx` is deliberately NOT a failure here. A rejected request is the host
working: counting `401`/`429` against availability would make a host under
credential-stuffing look broken while it defends itself correctly.

> **CORRECTED 2026-08-17 (ADR 0556 P2).** This paragraph used to end "The rate
> limiter's own health is A6 below" — **there is no A4, A5 or A6, and there
> never has been.** A dangling cross-reference sends an operator looking for a
> row that does not exist at exactly the moment they are trying to decide
> whether a `429` wall is an incident. There is no rate-limiter objective
> today; the per-IP budget's configured values are on the Operations
> system-health panel, and a saturated limiter shows up here only as `4xx`
> volume, which this row deliberately does not count. Recorded rather than
> quietly deleted because a row-set bijection test would never have caught it —
> the parity check now reads in-doc cross-references too.

The middleware is mounted BEFORE auth and the rate limiter, so a `401` and a
`429` are in the denominator. An availability metric that counts only the
requests which got past the gates reports a host as perfectly healthy while it
is refusing everyone.

## Workflow execution

| # | SLI | Objective | Metric |
|---|---|---|---|
| W1 | Fraction of terminal runs with `status: completed` | ≥ 97% | `openwop.run.completed{status}` |
| W2 | p95 run duration for `workflow_kind: chain` | ≤ 300 s | `openwop.run.duration` |
| W3 | p95 node execution duration, `replayed: false` | ≤ 30 s | `openwop.node.duration` |
| W4 | Fraction of node attempts ending `failure` | ≤ 3% | `openwop.node.duration{status}` |

W1 counts `cancelled` in the denominator but not the numerator: a user
cancelling is not a host failure, but a host that makes users cancel is failing
in a way no error rate shows.

W2 is deliberately per-`workflow_kind`. Chains and stacks have unrelated
duration distributions, and a single p95 over both describes neither.

**Known measurement gap (P1).** `openwop.run.duration` is emitted only for runs
whose START this process observed — the workflow kind and start instant live in
an in-process registry. A run that terminates on a different instance, or after
a cold start, reports `workflow_kind: unknown` on `openwop.run.completed` and
NO duration. The counter is therefore complete and the histogram is not. Sizing
an alert on the histogram's *count* will under-read; use the counter. Closing
this needs the kind stamped on the run row, which is a data change and belongs
with P2.

## Replay and effect safety

| # | SLI | Objective | Metric |
|---|---|---|---|
| R1 | Effects blocked by the ADR 0531 replay backstop | **0** | `openwop.effect.blocked` |
| R2 | Replay lookups ending `source-missing` | ≤ 0.1% of served | `openwop.replay.node.served{outcome}` |

R1 is a zero target rather than a percentage, and it is the only one here. A
blocked effect means a side-effecting node was never classified in
`executor/sideEffects.ts` — the replay fork was about to fire a real effect a
second time and the structural backstop caught it. That is a bug report, not a
rate: any non-zero value is actionable regardless of traffic volume, which is
precisely why it is a separate metric from `openwop.effect.dispatched` rather
than an `outcome` label on it. A ratio would let a busy host hide it.

## Idempotency and recovery

| # | SLI | Objective | Metric |
|---|---|---|---|
| I1 | Fraction of claims ending `mismatch` | ≤ 0.5% | `openwop.idempotency.claim{outcome}` |
| I2 | Fraction of claims ending `reclaimed` | ≤ 0.1% | `openwop.idempotency.claim{outcome}` |
| I3 | Fraction of claims ending `in-flight` | ≤ 1% | `openwop.idempotency.claim{outcome}` |

I2 is the interesting one and the reason ADR 0556 P1 added the `reclaimed`
signal at all. A live claim holder cannot outlive its lease — the lease is
DERIVED from the request timeout so that it cannot — so a reclaim means a
previous holder **died mid-request**. Sustained `reclaimed` traffic is instance
churn, OOM kills or a hung dependency, and none of those show up anywhere else
in this table.

I1 is a client-correctness signal, not a host one: the same key arrived with a
different body. A spike usually means a client is deriving its key from
something less stable than it thinks.

## Compensation (RFC 0151)

| # | SLI | Objective | Metric |
|---|---|---|---|
| C1 | Obligations reaching `manual_intervention_required` | ≤ 0.1% of recorded | `openwop.compensation.resolved{state}` |
| C2 | Obligations still not `completed` after 24 h | ≤ 1% | `openwop.compensation.obligation` vs `…resolved{state=completed}` |

`failed` is NOT a terminal state for a compensation and is deliberately absent
from these targets: a failed inverse is retried against the same obligation
row, so a `failed` count is a retry rate, not an outage. What matters is
whether the unwind eventually finished (C2) and whether a human had to be
involved (C1).

## Interrupts (human-in-the-loop)

| # | SLI | Objective | Metric |
|---|---|---|---|
| H1 | p95 age at resolution, `interrupt_kind: approval` | ≤ 4 h | `openwop.interrupt.age` |
| H2 | Fraction of approvals resolving `timeout` | ≤ 5% | `openwop.interrupt.age{resolution}` |

H1 measures the HUMAN, not the host, and that is the point: an approval gate
nobody answers is an outage the engine reports as perfectly healthy. H2 is the
fail-closed rate — an approval gate that times out REJECTS and fails the run
(RFC 0093 §D.1), so a rising H2 is user-visible work being silently discarded.

## Cross-host protocol

| # | SLI | Objective | Metric |
|---|---|---|---|
| P1 | Fraction of inbound A2A requests ending `internal_error` | ≤ 0.5% | `openwop.a2a.request{outcome}` |
| P2 | Fraction of inbound MCP requests ending `internal_error` | ≤ 0.5% | `openwop.mcp.request{direction=inbound}` |
| P3 | Fraction of outbound MCP calls ending `ok` | ≥ 98% | `openwop.mcp.request{direction=outbound}` |
| P4 | Version dispositions ending `unsupported` | ≤ 1% | `openwop.protocol.version{disposition}` |

`method_not_found` and `invalid_params` are excluded from P1/P2: a peer sending
a method this host does not serve is the peer's problem, and folding it into
the host's error rate means a single scanner can burn the error budget.

P4 is a compatibility signal rather than a health one. A rising `unsupported`
count means peers have moved to a version this host does not serve — which is a
roadmap input, not a page. The `absent` count is the pre-1.0 A2A population and
is what a decision to drop the compatibility path should be based on.

## Model providers

| # | SLI | Objective | Metric |
|---|---|---|---|
| M1 | Fraction of provider calls ending `ok` | ≥ 97% | `openwop.provider.call{outcome}` |
| M2 | Fraction ending `provider_rate_limited` | ≤ 1% | `openwop.provider.call{outcome}` |

`byok_required` and `byok_required_but_unresolved` are excluded from M1: an
operator who has not configured a key is a configuration state, not a provider
outage, and counting it makes a fresh install look like an incident.

## Sandbox

| # | SLI | Objective | Metric |
|---|---|---|---|
| S1 | Sandbox executions ending `escape_attempt` | **0** | `openwop.sandbox.execution{outcome}` |
| S2 | Fraction ending `resource_exhausted` | ≤ 2% | `openwop.sandbox.execution{outcome}` |
| S3 | Fraction ending `timeout` | ≤ 5% | `openwop.sandbox.execution{outcome}` |

S1 is the second zero target. An escape attempt is a script reaching for an
ambient global (`require`, `process`, `fetch`) or walking a constructor chain
out of its realm. The isolation held — that is what "attempt" means — but the
attempt itself is a security event, and it is only distinguishable from an
ordinary script error because `host/sandbox.ts` classifies it. Collapsing it
into a generic failure rate is how the signal gets lost.

## Assurance freshness

| # | SLI | Objective | Metric |
|---|---|---|---|
| F1 | Attestation age at read, `state: valid` | ≤ 7 days | `openwop.attestation.age` |
| F2 | Reads returning `state: invalid` | **0** | `openwop.attestation.age{state}` |

`absent` and `unreadable` produce NO age observation. A manifest with no
`issuedAt` has no age, and recording zero would read as "issued just now" — the
most reassuring possible value for the most alarming possible state. Alert on
the `openwop.attestation.age` series being ABSENT for a deployment that should
have one, not on a low value.

## Dispatch queue

Added 2026-08-16 with ADR 0551 P2. These three sat under "Not yet measurable"
below until the queue they describe existed — see the note at the end of this
section, which is kept because the reasoning is the point.

| # | SLI | Objective | Metric |
|---|---|---|---|
| Q1 | Pending dispatch intents (backlog depth) | ≤ 50 sustained over 5 min | `openwop.dispatch.outbox.depth{state="pending"}` |
| Q2 | Age of the oldest pending intent | ≤ 120 s | `openwop.dispatch.outbox.oldest_age` |
| Q3 | Dispatch intents given up on | **0** | `openwop.dispatch.lease.recovered{outcome="dead"}` |
| Q4 | Dead intents awaiting an operator redrive | ≤ 5 | `openwop.dispatch.outbox.depth{state="dead"}` |
| K1 | p95 first-attempt delay for webhook deliveries claimed by this process | ≤ 30 s | `openwop.webhook.first_attempt_delay` |

**Q2 is the one to page on.** An accepted run whose intent has waited two
minutes means the wakeup hint did not fire AND the sweeper has not caught up —
which is the exact failure the outbox exists to make visible. The sweeper ticks
every 5 s and a new row carries a 10 s grace window, so a healthy host sits far
below this; 120 s is a ceiling, not a normal reading.

**Q3 is the third zero target**, alongside S1 and F2. A `dead` row is an
accepted run that will now never start without an operator, so a non-zero rate
is always actionable regardless of traffic. It is deliberately NOT a ratio for
the reason `openwop.effect.blocked` is not one: a ratio invites an alert
threshold, and the right threshold is "any".

Q1 and Q4 are gauges observed once per sweeper pass, so they are point-in-time
samples rather than rolling aggregates — alert on a SUSTAINED level, never a
single scrape. And read Q1 against Q2: a deep queue that is draining is a busy
host, while a shallow queue that is not draining is a stuck one, and only the
pair distinguishes them.

`discharged` and `run-missing` are excluded from Q3 on purpose. Both are the
queue REFUSING a duplicate delivery, which is the mechanism working; counting
them as recovery events would make a healthy fleet look like it was constantly
recovering from something.

> **Why these were absent until now, kept verbatim from the ADR 0556 P1 draft
> of this document:** *"ADR 0556's decision section lists these; ADR 0551 P1
> owns the outbox and is being built concurrently. The three signals land with
> it, not here. Instrumenting a queue that does not exist yet would have
> produced three metrics permanently at zero, which is worse than their
> absence: a flat zero reads as health."* P1 shipped the queue on 2026-08-16
> (`28740fb4d`) and P2 shipped the instrumentation the same day.

## Not yet measurable

Recorded so the absence is a decision rather than an oversight:

- **Run-level queue wait** (created → started). The dispatch outbox now makes
  the two timestamps available, but the measurement is not the same as Q2
  above: `oldest_age` describes intents still WAITING, and a queue-wait
  histogram describes intents that already started. The second needs an
  emission on the start path carrying the row's `createdAt`, which P2 did not
  add — recorded here rather than approximated from Q2, since a gauge over
  survivors is not a distribution over completions.
- **Per-tenant anything.** Tenant id is unbounded and is in `FORBIDDEN_LABELS`.
  Per-tenant detail belongs on a span or a log line, both of which carry it
  already; a metric is the wrong instrument and taking the collector down is
  the price of using it anyway.
