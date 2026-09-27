# SLO alert runbook

Status: written 2026-08-17 with ADR 0556 P2. One section per alert the
Operations SLO panel can raise. The objectives themselves — and the reasoning
behind how each one is worded — live in [`../SLO.md`](../SLO.md); this file is
what to DO when one of them goes red.

Every alert the projection emits links to a heading below. The link is derived
from the heading text by `githubAnchor()` in
`backend/typescript/src/observability/sloProjection.ts`, and
`test/slo-runbook-anchors.test.ts` fails if a heading this catalog names is not
present here. So renaming a section breaks a test rather than an operator's
3 a.m. click. Headings are deliberately free of punctuation, because a dash or a
middle dot collapses to a double hyphen and produces an anchor that resolves in
one markdown renderer and not another.

## Before any of this: what the panel can and cannot tell you

The Operations SLO panel reads THIS INSTANCE's OpenTelemetry instruments through
the local-scrape reader, cumulative since the process started. It is not a
28-day rolling window and it is not a fleet aggregate, whatever `SLO.md`
declares — see ADR 0556 P2's implementation record for why that gap is a
property of where the numbers come from and not a bug to fix in the panel.

Three consequences worth internalising before you act on a red row:

- **A freshly restarted instance looks perfect.** Four requests, none failed,
  100% availability. Check `window.seconds` before believing a healthy row.
- **A breach on one instance is not a fleet breach.** Look at the other
  instances (or the collector, if `OTEL_EXPORTER_OTLP_ENDPOINT` is set) before
  declaring an outage.
- **`unknown` is not `healthy`.** It means the local-scrape profile is off
  (`OPENWOP_METRICS_LOCAL_SCRAPE`), so the host is recording these measurements
  and cannot show you any of them.

A `stale` alert is the panel telling you it has stopped being able to see. Treat
it as invalidating the rows around it, not as a minor annoyance.

## A1 HTTP availability

**Fired:** more than 0.5% of HTTP responses carried a `5xx` status.

`4xx` is not in the numerator — a `401` or a `429` is the host working — so this
is genuinely server-side failure. The middleware sits before auth and the rate
limiter, so the denominator is all traffic.

1. `GET /api/readiness` and the Operations **System health** panel: a `degraded`
   storage or config check explains a `5xx` wall immediately.
2. Check the Cloud Run revision's error logs for the dominant `route` label —
   the metric carries the route TEMPLATE, so the breach is usually one endpoint,
   not the host.
3. If storage is the cause, check the connection budget (`poolMax × maxInstances`
   against the Cloud SQL limit) before restarting anything: exhaustion presents
   as `5xx` and a restart makes it worse.

**Not an incident when:** the window is short and a single deploy-time burst is
in it. Read `sampleCount`.

## A2 A3 HTTP latency

**Fired:** p95 request duration exceeded 1.0 s (A2) or p99 exceeded 5.0 s (A3),
over non-SSE routes.

Both values are BUCKET ESTIMATES reported at the pessimistic end of the bucket
the quantile fell into, so a reading of `1s` means "somewhere in (0.5, 1]". Do
not chase a small overshoot; chase a bucket jump.

1. SSE routes are already excluded (the list is the rate limiter's
   `SSE_STREAM_PATHS`). If a NEW streaming route was added and not added there,
   its session length is being counted as request latency — fix the list, not
   the SLO.
2. Look for a slow dependency rather than slow code: model-provider calls (M1),
   storage, or an outbound MCP server (P3) are the usual causes, and each has
   its own row on the same panel.
3. `Infinity` (rendered "beyond the largest bucket") means observations exceeded
   the largest boundary the catalog declares. That is a real signal, not a
   rendering artefact.

## W1 Run success rate

**Fired:** fewer than 97% of terminal runs reached `completed`.

`cancelled` is in the denominator but not the numerator, on purpose — a user
cancelling is not a host failure, but a host that makes users cancel is failing
invisibly.

1. Split by cause in the runs inspector (`/runs`): a single failing workflow or
   node type usually accounts for a step change.
2. Check W4 alongside it. A node failure rate that moved with this one points at
   execution; one that did not points at cancellation or at run-level failure.
3. Check M1 — a provider outage surfaces here first if workflows call models.

## W2 W3 Execution latency

**Fired:** p95 chain-run duration exceeded 300 s (W2), or p95 non-replayed node
duration exceeded 30 s (W3).

Both are wall-clock and both are bucket estimates. Wall-clock is deliberate: a
run suspended on a human approval for an hour took an hour.

W2 additionally has a **partial population** — `openwop.run.duration` is emitted
only for runs whose START this process observed, so a run that terminated after
a cold start or on another instance contributes to the counter and not to this
histogram. Size nothing off this histogram's count; use `openwop.run.completed`.

1. If W2 moved and W3 did not, the time is between nodes: check interrupts (H1),
   the dispatch queue (Q2), and scheduled waits.
2. If W3 moved, find the slow node type on the node span
   (`openwop.node_type` — it is on the span deliberately, because a
   tenant-installed pack can mint new type ids and they are not safe as a
   metric label).

## W4 Node failure rate

**Fired:** more than 3% of node attempts ended `failure`.

1. This counts ATTEMPTS, so a retrying node inflates it without failing a run.
   Cross-check W1: a moved W4 with a flat W1 is retry noise doing its job.
2. Check the sandbox rows (S2, S3) and the provider rows (M1, M2) — a node that
   fails is usually a dependency that failed.

## R1 Blocked effect

**Fired:** ANY effect was refused by the ADR 0531 replay backstop. Zero target,
severity page.

This is a bug report, not a rate. A blocked effect means a side-effecting node
was never classified in `executor/sideEffects.ts`, and a replay or fork was
about to fire a real external effect a second time. The backstop caught it —
nothing bad happened — but the classification gap is still there and the next
one may be in a path the backstop does not cover.

1. Find the `effect_kind` label on `openwop.effect.blocked`.
2. Classify that node type in `executor/sideEffects.ts` and add the regression
   test alongside the existing ones.
3. Do NOT suppress or raise the threshold. A ratio here would let a busy host
   hide a duplicated payment.

## R2 Replay source missing

**Fired:** more than 0.1% of replay lookups ended `source-missing`.

The ADR 0341 fast path went to the source run for a side-effecting node's
recorded result and did not find it.

1. Usually retention: the source run was swept before the fork replayed. Check
   the retention policy against how long forks live.
2. If retention is not it, the fork's source pointer is wrong — that is a
   correctness bug in fork creation, not a data-lifecycle question.

## I1 Idempotency mismatch

**Fired:** more than 0.5% of `Idempotency-Key` claims ended `mismatch`.

The same key arrived with a different request body. This is a CLIENT
correctness signal, not a host one — the ledger is doing exactly its job by
refusing.

1. Identify the endpoint from the `endpoint` label (a closed two-value set).
2. A spike almost always means a client derives its key from something less
   stable than it thinks — a timestamp, a serialized object with unordered keys.
   The fix is in the caller.

## I2 Idempotency reclaimed

**Fired:** more than 0.1% of claims ended `reclaimed`. Severity page.

This is the most informative row in the idempotency group. A live claim holder
CANNOT outlive its lease — the lease is derived from the request timeout so that
it cannot — so a reclaim means a previous holder **died mid-request**.

1. Instance churn: check Cloud Run revision restarts and OOM kills.
2. A hung dependency holding a request open past its timeout.
3. Sustained reclaims with no restarts means requests are being killed by
   something outside the process (a proxy timeout, a liveness probe).

Nothing else on this panel shows any of those three.

## I3 Idempotency in flight

**Fired:** more than 1% of claims ended `in-flight` — a duplicate arrived while
the first was still running.

1. Low rates are normal client retry behaviour.
2. A high rate with slow requests (A2/A3) is a client retrying because the host
   is slow: fix the latency, not the retry.

## C1 Manual compensation

**Fired:** more than 0.1% of recorded obligations reached
`manual_intervention_required`. Severity page.

A compensation could not be completed automatically and is waiting for a human.
Real-world state — a payment, a message, an external record — is currently
inconsistent with what the run believes.

1. Open the compensation operator surface and work the queue. These do not
   resolve themselves; that is what the state means.
2. Note the denominator is `openwop.compensation.obligation` (obligations
   RECORDED), not resolutions — so a flapping retry cannot dilute this rate.
3. `failed` is deliberately not a target: a failed inverse is retried against
   the same obligation row, so it is a retry rate and not an outage.

## C2 Slow compensation

**Not currently projectable** — the panel shows this row as `not_projectable`
with the reason, and it therefore never fires.

The objective is "obligations still not completed after 24 h", and no counter
carries an obligation's age. `recorded − completed` answers a DIFFERENT question
(open right now, at any age) with the same shape, which is exactly what makes
substituting it dangerous. Closing this needs an obligation-age histogram in the
metric catalog, not a change to the projection.

Until then, work C1 and check the compensation operator surface directly.

## H1 Approval wait

**Fired:** p95 approval age at resolution exceeded 4 hours.

This measures the HUMAN, not the host, and that is the point: an approval gate
nobody answers is an outage the engine reports as perfectly healthy.

1. Check who the approvers are and whether delegation / out-of-office (ADR 0198)
   is routing around an absent one.
2. Check notification delivery — an approver who is never told is
   indistinguishable here from one who ignores it.

## H2 Approval timeout

**Fired:** more than 5% of approvals resolved as `timeout`. Severity page.

An approval gate that times out **rejects and fails the run** (RFC 0093 §D.1),
so a rising rate is user-visible work being silently discarded.

1. Treat as more urgent than H1: H1 is slow, this is lost.
2. Same first checks as H1, plus the timeout configuration itself — a gate whose
   timeout is shorter than the approvers' working day will always do this.

## P1 P2 Protocol internal errors

**Fired:** more than 0.5% of inbound A2A (P1) or inbound MCP (P2) requests ended
`internal_error`.

`method_not_found` and `invalid_params` are excluded from both denominators: a
peer calling a method this host does not serve is the peer's problem, and
folding it in means one scanner can burn the error budget.

1. `internal_error` is OUR fault by construction — everything a peer can cause
   maps to a different outcome.
2. Get the `method` label (classified against the served set) and check the
   handler's logs for that method class.

## P3 Outbound MCP failures

**Fired:** fewer than 98% of outbound MCP calls ended `ok`.

1. The `outcome` label distinguishes the causes and they need different actions:
   `not_connected` / `transport_error` / `timeout` are the remote server or the
   network; `not_allowed` is this host's own allowlist refusing; `remote_error`
   is the peer reporting a failure.
2. `not_allowed` spiking after a config change means an operator removed a
   connector the workflows still call — that is a configuration rollback, not an
   outage.

## P4 Unsupported protocol versions

**Fired:** more than 1% of version negotiations ended `unsupported`.

This is a COMPATIBILITY signal, not a health one — peers have moved to a version
this host does not serve. It is a roadmap input.

1. Do not page. Record it and decide whether to add the version.
2. The `absent` disposition counts the pre-1.0 A2A population; that is the
   number a decision to DROP the compatibility path should rest on.

## M1 Provider failure rate

**Fired:** fewer than 97% of model-provider calls ended `ok`.

`byok_required` and `byok_required_but_unresolved` are excluded — an operator
who has not configured a key is a configuration state, and counting it makes a
fresh install look like an incident.

1. Check the `provider` label: one provider degrading is upstream, all of them
   at once is us (network, egress, or a secret that failed to resolve).
2. `provider_unavailable` / `provider_timed_out` — check the provider's status
   page and consider routing around it in the model router.
3. If BYOK resolution is the cause the calls do not land here; check the BYOK
   config surface instead.

## M2 Provider rate limiting

**Fired:** more than 1% of provider calls ended `provider_rate_limited`.

1. Usually a quota, not a fault. Check the account's tier against current
   volume.
2. Check for a runaway workflow or a retry storm creating the volume — an agent
   loop that retries on rate-limit amplifies its own problem.

## S1 Sandbox escape attempt

**Fired:** ANY sandboxed execution ended `escape_attempt`. Zero target, severity
page.

**This is a security event.** The isolation HELD — that is what "attempt" means —
but a script reached for an ambient global (`require`, `process`, `fetch`) or
walked a constructor chain out of its realm.

1. Identify the pack / workflow / tenant that ran the code. The metric cannot
   tell you (tenant is an unbounded label and is forbidden); the SPAN and the
   audit log carry it, and that is the correct division.
2. Treat the code as hostile until shown otherwise. Do not re-run it to
   reproduce.
3. `host/sandbox.ts` is what classifies this apart from an ordinary script
   error. If that classification is loosened, this signal disappears.

## S2 S3 Sandbox capacity

**Fired:** more than 2% of sandbox executions ended `resource_exhausted` (S2), or
more than 5% ended `timeout` (S3).

1. Capacity signals, not security ones — deliberately separated from S1 so an
   escape attempt cannot hide inside a generic failure rate.
2. Check the configured memory and time limits against what the workloads
   actually need before raising either: a limit that is too tight and a workload
   that is genuinely runaway look identical here and have opposite fixes.

## F1 Attestation freshness

**Fired:** an attestation manifest was read whose age exceeded 7 days.

The value is the recorded MAXIMUM age, which is exact — no bucket estimate.

1. The deployment attestation is regenerated by the deploy pipeline. A stale one
   usually means a deploy did not run it, not that anything is wrong with the
   host.
2. `absent` and `unreadable` produce NO age observation at all, so they cannot
   fire this. Alert on the series being ABSENT for a deployment that should have
   one — a low value here can never mean "no manifest".

## F2 Invalid attestation

**Fired:** ANY attestation read returned `state: invalid`. Zero target, severity
page.

The signed manifest no longer matches this host: either the commit differs from
what was attested, or the live discovery document has drifted from the digest
that was signed.

1. Compare `attested.commit` on the attestation panel against
   `/api/readiness` → `build.commit`. A mismatch is a deploy that shipped
   without re-attesting.
2. If the commits match, the discovery document changed — a capability was
   advertised or withdrawn after signing. That is the drift detection working.
3. Do not regenerate the attestation to clear the alert until you know which of
   the two it was.

## Q1 Q4 Outbox depth

**Q4 fired:** more than 5 `dead` dispatch intents are waiting for an operator
redrive.

**Q1 does not fire.** Its objective is a level SUSTAINED over 5 minutes, and a
gauge observed once per sweeper pass cannot distinguish that from one deep
scrape — `SLO.md` says so itself ("alert on a SUSTAINED level, never a single
scrape"). The panel shows it as `not_projectable` rather than raising exactly
the single-scrape alert that sentence forbids. Read the depth on the
**Dispatch outbox** panel beside it, and read it against Q2: a deep queue that
is draining is a busy host, a shallow queue that is not draining is a stuck one,
and only the pair distinguishes them.

For Q4:

1. Each `dead` row is an accepted run that will never start without you.
2. Use the redrive control on the Dispatch outbox panel. It requires a reason,
   which lands on the row; the audit chain records who.
3. Redrive is a CAS, so two operators clicking at once produce exactly one
   re-queued row. A second click 404s — that is not an error to retry through.

## Q2 Outbox oldest age

**Fired:** the oldest pending dispatch intent has waited more than 120 s.
Severity page — `SLO.md` calls this the one to page on.

An accepted run whose intent has waited two minutes means the wakeup hint did
not fire AND the sweeper has not caught up. That is the exact failure the outbox
exists to make visible. The sweeper ticks every 5 s and a new row carries a 10 s
grace window, so a healthy host sits far below this.

1. Is the sweeper running? A `stale` alert on this same row says it is not.
2. Check instance count and whether the dispatch daemon is enabled on the live
   revision.
3. Check Q4 — intents ageing out into `dead` is where this goes if it is not
   fixed.

## Q3 Dead dispatch intents

**Fired:** ANY dispatch intent was given up on. Zero target, severity page.

A `dead` row is an accepted run that will now never start without an operator,
so it is actionable regardless of traffic volume. It is deliberately not a
ratio: a ratio invites a threshold, and the right threshold is "any".

1. Redrive the rows (see **Q1 Q4 Outbox depth** above) once you know why they
   died — `lastError` on each row is written by this host.
2. `discharged` and `run-missing` are excluded from this signal on purpose: both
   are the queue REFUSING a duplicate delivery, which is the mechanism working.
   If you are seeing those, nothing is wrong.

## K1 Webhook delivery latency

**K1 fired:** fewer than 95% of first outbound webhook delivery attempts started
within 30 s of being enqueued.

**This is a latency alert, not a failure alert, and the distinction is the whole
point.** `WHD-1` is the case it exists for: a slow subscriber starved every
unrelated subscription sharing its batch, a healthy subscriber's first attempt
arrived **~5.5 minutes** after its event against a configured **2 s** first
backoff, and **every delivery eventually succeeded**. No failure counter, retry
budget or dead-letter threshold could see that — the deliveries were fine, just
late. It ran undetected in production for weeks and was found by a conformance
suite rather than by anyone operating the host.

**Why `ticket` and not `page`.** Degraded, not lost. Paging on weeks-tolerable
latency trains operators to dismiss the page, which is how the next real outage
gets missed.

### Read it here

**Operations → Webhooks** (`/operations/webhooks`) already shows per-subscription
`pending` / `dead` / `delivered` counts, recent attempts with backoff state, and
`lastError`. K1 tells you to open that page; the page tells you which subscriber.

### What to check, in order

1. **One slow subscriber, or all of them?** The panel's per-subscription counts
   answer this. Many subscriptions climbing together points at the worker; one
   climbing alone points at that subscriber's endpoint.
2. **Is the worker starved?** `deliveryConcurrency()` bounds in-flight rows by
   `min(CLAIM_BATCH, OPENWOP_PG_POOL_MAX - 1)` (WHD-34). A small pool caps
   throughput: `poolMax: 2` means **one** delivery at a time.
3. **Are dead endpoints occupying the batch?** Each row holds a slot for up to
   `DELIVERY_TIMEOUT_MS` (10 s). Several unreachable subscribers can consume the
   batch repeatedly. Unregistering a dead subscription revokes its queued rows
   (`WHD-16`), which frees those slots immediately.
4. **Instance count.** The denominator is deliveries *this process* claimed —
   the same sampling bias `W2` carries. A single starved instance can breach K1
   while the fleet as a whole is healthy.

### What NOT to do

Do not raise `CLAIM_BATCH` to clear a backlog. It is also the concurrency bound,
and raising it past `OPENWOP_PG_POOL_MAX - 1` puts the worker in contention with
request handling for a pool it shares — the WHD-34 failure, reintroduced.
