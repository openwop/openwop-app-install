# ADR 0556 — Production metrics, workload identity and assurance operations

Status: Accepted — P0 (metric catalog, SDK/export/shutdown, cardinality lint) implemented 2026-08-14 (`b62d0080f`, #3202); P1 (seam instrumentation + SLOs) implemented 2026-08-16 (`0433125fa`, #3277); **P3 §A/§B (workload identity + delegated actor chain) implemented 2026-08-16** (`8fbed15d4`, #3278), completed by **H28** — the §B chain-bound reason codes + hop scope narrowing — 2026-08-16 (`3653cd90d`, #3283, `workload-identity-chain-bounds` 0/4 → 4/4); **P2 (Operations projection/alerts) implemented 2026-08-17**; P4 open; §C/§D/§E deliberately not claimed. Merge provenance reconciled 2026-08-17 (H44)

Date: 2026-08-11

Composes: ADR 0118 OTel traces, structured logger, health/readiness, ADR 0395
Operations, protocol auth context and dispatch provenance. Protocol gate: RFC
0154 (`Accepted` — verified 2026-08-13 on `../openwop` `origin/main`; this line
read `Draft` until then, while the gate block below already recorded otherwise).

## Context

The app initializes traces and OTLP export in
`observability/tracer.ts:39-126`, but has no `MeterProvider`. The replay effect
guard explicitly falls back to a structured log because no metrics pipeline
exists (`host/runEffectContext.ts:144-148`). Operators therefore lack native,
bounded-cardinality counters/histograms for queue age, run latency, interrupts,
retries, idempotency conflicts, compensation, adapter health and policy blocks.

> **No longer true as of P1 (2026-08-16), left standing as the starting state.**
> The `MeterProvider` landed in P0 and the replay guard's log-only fallback was
> replaced by `openwop.effect.blocked` in P1 — the comment naming the absent
> pipeline is corrected in place at that seam. The structured log STAYS: it
> carries `runId` and `detail`, which are exactly the unbounded fields a label
> may never hold, so the two are complementary rather than redundant.

Separately, background workers and cross-host calls need a first-class workload
identity/delegation chain. User identity, worker identity and the authority
delegated to a run must not collapse into one bearer or log label.

## Decision

### One OTel telemetry provider family

Extend the existing observability bootstrap with OTel metrics using the same
resource attributes, OTLP endpoint policy and bounded shutdown. Do not create a
vendor-specific instrumentation tree. Define a metric catalog with stable
names, units, descriptions, owners and cardinality budgets.

Required signals include run/step latency and terminal outcomes; dispatch
outbox depth/oldest age/lease recovery; idempotency claim outcomes; interrupt
age; effect allowed/blocked/replayed; compensation outcomes; A2A/MCP request
outcomes by version/method class; sandbox resource/escape failures; and
conformance/attestation freshness. Tenant, run, user, key, URL, prompt and tool
argument values are forbidden metric attributes. Exemplars may link to a trace
id through the SDK without promoting it to a label.

Readiness remains dependency-oriented; metrics failure is observable but does
not crash request handling. Production qualification does require a healthy
exporter or an explicit local-scrape operator profile.

### Workload and delegated authority

After RFC 0154 is Accepted, represent:

- authenticated human/service principal;
- executing workload identity (instance/worker/isolated runner);
- delegator chain and bounded scopes/audience;
- tenant/workspace/run/node binding;
- issuance/expiry and credential provenance.

Workers receive short-lived, audience-bound credentials, not copied user bearer
tokens. Every outbox/A2A/MCP/sandbox/compensation action records both actor and
workload identities in the existing audit/provenance owners. Replay uses the
recorded authority facts and does not remint broader authority.

### Operations projection

Extend the existing Operations hub with SLO panels and links to evidence, queue,
adapter and security health. It reads aggregated telemetry/health endpoints;
it does not become a second metrics database or tracing UI.

## Boundaries audit

| Concept | Owner |
|---|---|
| Trace + metric SDK lifecycle | existing observability bootstrap |
| Structured logs/redaction | existing logger |
| Health/readiness | existing health routes |
| Human/service authentication | existing auth middleware |
| Worker credentials | host workload-identity resolver after RFC 0154 |
| Audit/provenance | existing audit sink/run metadata owners |
| UI | existing Operations feature |

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Core observability/auth; Operations projects it. |
| 2 | Toggle | No product toggle. Export configuration is operator-owned. |
| 3 | Workflow surface | Instrument existing engine; no telemetry workflow. |
| 4 | Node pack | None. |
| 5 | Envelopes | RFC-defined identity context only after acceptance. |
| 6 | Agent pack | None. |
| 7 | Public surface | Metrics remain operator/internal unless an accepted protocol seam requires them. |
| 8 | RBAC | SLO aggregates operator-readable; tenant/user-sensitive drilldown follows existing audit permissions. |
| 9 | Replay/fork | Telemetry identifies replay; authority is recorded and cannot widen on replay/fork. |
| 10 | Frontend | Operations cards only; external observability tools remain deep-link targets. |

## Inbound dependency (recorded 2026-08-11)

**ADR 0549 P2 deferred its metric emission to this ADR.** The ledger phase
needed bounded-cardinality counters for claim outcomes
(`claimed` / `replay` / `mismatch` / `in-flight` / `reclaimed`) but found no
metrics seam in `src/observability/` — only tracer, logger, spans and cost
emission. Emitting there would have stood up a second telemetry path beside the
one P0 below exists to create, so it was deferred rather than duplicated.

P1 ("instrument critical seams") therefore owes the idempotency ledger its
counters. The labels MUST NOT include the idempotency key, the request digest,
or the tenant id — key and digest are caller-supplied and carry customer
identifiers (ADR 0549 P2 log-hygiene), and tenant id is unbounded. Outcome and
endpoint are the only safe dimensions, and both are closed sets.

## Phases and verification

| Phase | Scope | Gate |
|---|---|---|
| P0 | Metric catalog, SDK/export/shutdown, cardinality lint | Unit + collector tests; forbidden-label static/runtime tests. **SHIPPED** — `metrics.ts` + `check-metric-labels.mjs` (in `ci.sh`) + 12 tests, sabotage-proven 3 ways. |
| P1 | Instrument critical seams and define SLOs | Golden telemetry tests for success, failure, retry, replay and recovery. **SHIPPED** — 19 catalog metrics wired at 22 seams, `docs/SLO.md` (26 objectives), 51 tests, 32 sabotages all red. |
| P2 | Operations projection/alerts | RBAC, empty/error/stale states and alert runbook tests. **SHIPPED** — local-scrape reader (cumulative, capped) on the existing meter provider + `sloProjection.ts` (31 objectives, 4 evaluators, exact percentiles), one superadmin host-ext route, an Operations panel with seven states, `docs/runbooks/slo-alerts.md`, 93 tests, 33 sabotages all red. |
| P3 | Workload identity/delegation | Wait for RFC 0154 Accepted; audience, expiry, confused-deputy and replay tests. **SHIPPED (§A/§B lane)** — resolver + request binding + §20 seam + `auth.workloadIdentity` advert, 46 tests, 18 sabotages all red, sibling `workload-identity-behavior` legs `executed-pass`. §C sender constraint beyond the advertised (empty) set, §D's GenAI projection and §E provenance are NOT done — see the record below. |
| P4 | Assurance integration | ADR 0550 attestation includes telemetry/SLO evidence without secrets. |

> **RFC GATE SATISFIED — verified 2026-08-13 via `git show origin/main:RFCS/…`
> after a fetch**, NOT from the local `../openwop` working tree, which was 56
> commits behind and returned `Draft` for every one of these. See ADR 0552/0553
> for the full account of that near-miss.
>
> `0150` effect-identity-replay-and-split-brain-safety — `Accepted`
> `0151` compensation-and-partial-failure-profile — `Accepted`
> `0154` workload-identity-delegation-telemetry — `Accepted`

## Implementation record

### Merged-tree provenance — reconciled 2026-08-17 (H44)

Phase → PR → **merge commit on `origin/main`**, verified with
`git show <sha> --stat`:

| Phase | PR | Merge commit | Merged | Witness tests |
|---|---|---|---|---|
| P0 — metric catalog, SDK/export/shutdown, cardinality guard | [#3202](https://github.com/openwop/openwop-app/pull/3202) | `b62d0080f` | 2026-08-14 | `metrics-catalog-parity.test.ts`, `metrics-golden-telemetry.test.ts` |
| P1 — seam instrumentation + the declared SLOs | [#3277](https://github.com/openwop/openwop-app/pull/3277) | `0433125fa` | 2026-08-16 | `metrics-seam-coverage.test.ts` (+ catalog-parity and golden-telemetry extended); `docs/SLO.md` |
| P3 §A/§B — workload identity + delegated actor chain, and the advert | [#3278](https://github.com/openwop/openwop-app/pull/3278) | `8fbed15d4` | 2026-08-16 | `workload-identity-resolver.test.ts`, `workload-identity-surface.test.ts`, `agrade-wire-blocked-residue.test.ts` |
| **H28 — RFC 0154 §B chain bounds get their own closed reason codes** | [#3283](https://github.com/openwop/openwop-app/pull/3283) | `3653cd90d` | 2026-08-16 | `workload-identity-resolver.test.ts` (extended) |
| H27 — the workload-identity surface's error bodies converged on the flat envelope | [#3300](https://github.com/openwop/openwop-app/pull/3300) | `9b342b3be` | 2026-08-17 | `workload-identity-surface.test.ts`, `flat-error-envelope{,-ratchet}.test.ts` |
| P2 (Operations projection) | [#3318](https://github.com/openwop/openwop-app/pull/3318) | `2fb186f02` | 2026-08-17 | `slo-projection.test.ts` (35), `slo-projection-doc-parity.test.ts`, `operations-slo-route.test.ts`, `docs/runbooks/slo-alerts.md` — row corrected 2026-08-18; #3318 added the P2 record but not this cell |
| §C guard — an unverifiable sender constraint is refused at config read | (H67) | — | 2026-08-18 | `sender-constraint-config.test.ts` (4) |
| P4 | `openwop.authz.decision` counter + the attestation telemetry block | — | **partial** | `metrics-seam-coverage.test.ts` (authz block), `attestation-signer-parity.test.ts` (telemetry block) |

**Re-measured at `fb6cbbcba` (H44):** the five metrics + workload-identity
witness files are **5 files / 86 tests green**.

### H28 — the three chain-bound refusals were all spelled `identity_unverified` (implemented 2026-08-16)

Not previously recorded in this ADR; folded in by the H44 reconciliation, and it
is a genuine P3 §B completion rather than a chore that happened to ride a pin
bump.

Suite 1.128.0+ asks for RFC 0154 §B chain bounds and the lane was red on
`workload-identity-chain-bounds` (**0/4**). P3 §A/§B had shipped the bounds
themselves — depth and acyclicity are enforced — but all three refusals collapsed
into one reason code, so a peer could not tell "your chain is too long" from
"your credential does not verify". Those are different remediations, and a closed
reason vocabulary that answers both with the same token is the wire equivalent of
an empty catch.

`src/host/workloadIdentity.ts` now maps them separately —
`delegation_chain_too_long`, `delegation_chain_cyclic`,
`delegation_scope_amplified` (verified in the tree at `:147-149` / `:205-208`) —
and a hop may carry an OPTIONAL `scopes[]` (non-empty unique strings) that may
NARROW but never widen the previous hop's. A hop without `scopes` is **unstated**,
not "all"; the distinction is the whole §B safety property, since reading absence
as "everything" would make an intermediate hop an amplifier.

Sabotage: map the three back to `identity_unverified` → red; drop the
amplification check → red. `workload-identity-chain-bounds` went **0/4 → 4/4** on
the conformance lane at 1.130.0.

### P0 — pre-implementation survey, measured 2026-08-13

The starting state was verified rather than assumed, because "we already have
OTel" is exactly the kind of half-true premise this program keeps tripping on.

**Traces exist; metrics do not.** ADR 0118 installed the *trace* half only:

```
@opentelemetry/api
@opentelemetry/exporter-trace-otlp-http
@opentelemetry/sdk-trace-node
@opentelemetry/resources
@opentelemetry/semantic-conventions
```

There is **no `@opentelemetry/sdk-metrics`** and no metrics exporter, so P0's
"SDK/export/shutdown" is a genuine dependency addition, not wiring.

**Zero metric emission anywhere.** Measured with the real API surface —
`metrics.getMeter`, `.createCounter(`, `.createHistogram(`,
`.createUpDownCounter(` — across `backend/typescript/src`: **no matches**.

> Recorded because the first attempt to measure this was WRONG in the
> now-familiar way. A grep for `meter|createCounter|Histogram` returned five
> files, which reads as "partial instrumentation already exists". The actual
> match was **`Parameters`**. A substring is not a symbol, and this is the third
> loose-regex false positive in this program's history — the others being the
> "8 stale opt-out entries" and the "13 shared env vars", both of which also
> dissolved on a spot-check. The lesson is cheap to apply and expensive to skip:
> grep for the CALL, not the word.

**Consequence for sequencing.** P0 cannot be started while a `npm run ci` gate
is in flight: adding the metrics SDK rewrites `package-lock.json` underneath a
run that is validating it, and this repo already has a documented lockfile-churn
hazard (`npm ci` vs `npm install`, and the npm≥11.5 optional-dependency pruning
that silently broke Azure KMS). The dependency addition therefore lands as its
own commit, on a quiet tree, with the lockfile diff inspected for added/removed
counts before it is committed.

**The interesting half of P0 is the cardinality lint, not the SDK.** An
unbounded label (tenant id, run id, user id, URL path with ids) turns a metric
into a per-entity time series and takes the collector down — the failure is
operational, arrives late, and is invisible to unit tests that assert a counter
incremented. The phase gate says "forbidden-label static/runtime tests", i.e.
both: a static check that no forbidden label name appears in a metric
declaration, and a runtime guard that refuses one at record time. Only the
runtime half can catch a label whose VALUE is computed, so neither substitutes
for the other.

### P0 — shipped 2026-08-14

`src/observability/metrics.ts` (meter provider, OTLP export, flushing shutdown,
`METRIC_CATALOG`, runtime guard), `scripts/check-metric-labels.mjs` (static lint,
wired into `scripts/ci.sh`), `test/metrics-cardinality.test.ts` (12).

The dependency addition landed as its own commit on a quiet tree, per the
sequencing note above. Installed under `npm@10.9.8` — local npm is 11.x and
≥11.5 prunes an `optionalDependency`'s transitive deps, which silently breaks
Azure KMS durably once `npm ci` installs it. **Lockfile delta: added 5, removed
0**; the `removed` count is the fingerprint of that pruning, and
`kms-backend-preflight.test.ts` (the tripwire for this class) re-run green.

**The unverified item from the survey, now verified: there is no reusable
runtime label-guard seam, and the nearest candidate would have been a trap.**
The logger's `scrubFields` looks like the obvious host — central, applied to
every field, already "sanitising". It fails on two independent grounds:

1. `maskPiiValue` is `pii_${sha256(value).slice(0,10)}` — a **stable**
   pseudonym. One tenant maps to one label value, so a masked `tenantId`
   produces *exactly* as many time series as the raw one.
2. Its own contract exempts the worst offenders: "Operational fields (`runId`,
   `count`, `status`) are never touched" — and `runId` is the canonical
   unbounded label.

Cardinality is not a secrecy property: a label is dangerous because of how MANY
values it can take, which no value-transform changes. So the guard **drops** the
label rather than rewriting it. Reusing the logger seam would have produced
something that looked like protection and delivered none.

**It never throws**, following the rule the logger states about itself. A
violation drops the LABEL, keeps the MEASUREMENT, and records to a ledger so a
test can assert the guard *fired* rather than infer it from an absence. Dropping
the measurement instead would make the metric lie in the more dangerous
direction — a counter that silently under-counts corrupts the number an operator
alerts on.

**Sabotage-proven, three ways**, and the third is the one that carries the claim:

| sabotage | result |
|---|---|
| forbidden-label check disabled | 1 red — the rogue-spec leg isolates that arm; the undeclared arm still catches the rest, which is correct layering |
| undeclared-label check disabled | 1 red |
| guard counts violations but does NOT drop | **5 red** |

The third is the real question. A guard that logged violations while letting them
through would satisfy a bookkeeping test; it does not satisfy this suite.

The static lint **guards its own parse** — it asserts the extraction found
something before trusting the result, because a text-parsing lint that silently
matches nothing passes vacuously. Verified by renaming the symbol it greps for:
exit 1, with a readable message rather than an uncaught stack trace.

> Recorded because I measured that exit code wrong the first time.
> `node script | tail -3; echo "rc=$?"` reports **tail's** status, so a failing
> script read as `rc=0`. Same masked-exit bug that made me misreport a CI result
> earlier the same day — second instance, hours apart, after writing the lesson
> down. Knowing a failure mode does not prevent it; only changing the procedure
> does. The procedure here is: redirect to a file and read `$?` immediately.

P0 declares the seams P1 will instrument and adds no call sites, so it cannot
move a number in production. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the
provider carries zero readers — instruments are real, nothing is collected or
shipped, and a dev box pays nothing. Deliberately **not** a console metrics
exporter: it would print the whole series set every interval and drown the log.

### P1 — shipped 2026-08-16

P0 declared the seams and "adds no call sites, so it cannot move a number in
production". P1 is the call sites: **13 new catalog metrics** (19 total) emitted
from **22 seams**, plus `docs/SLO.md` — 26 declared objectives, each naming the
exact series it is computed from.

#### Metric → seam

| Metric | Seam (file:function) | Label domain |
|---|---|---|
| `openwop.run.started` | `executor/executor.ts` `executeRun`, at the `run.started` append | `workflow_kind` ∈ chain/stack/builtin/unknown · `trigger` ∈ api/schedule/trigger/agent/kanban/mcp/other |
| `openwop.run.completed` | `executor/runLifecycle.ts` `notifyRunTerminal` | `workflow_kind` · `status` ∈ completed/failed/cancelled |
| `openwop.run.duration` | same | same |
| `openwop.node.duration` | `executor/executor.ts`, around the guard-wrapped `module.execute` | `status` ∈ success/failure/suspended · `replayed` bool |
| `openwop.replay.node.served` | `executor/executor.ts`, ADR 0341 fast path | `outcome` ∈ recorded-success/recorded-failure/source-missing |
| `openwop.effect.dispatched` | `host/runEffectContext.ts` `assertEffectAllowed`, allow branch | `effect_kind` (6) · `outcome` = allowed |
| `openwop.effect.blocked` | same, replay-refusal branch | `effect_kind` (6) |
| `openwop.idempotency.claim` | `routes/runs.ts` + `routes/userAgents.ts`, at the claim | `endpoint` (2 literals) · `outcome` ∈ claimed/reclaimed/replay/in-flight/mismatch |
| `openwop.interrupt.created` | `executor/suspendManager.ts` `createInterrupt` | `interrupt_kind` (9) |
| `openwop.interrupt.age` | 6 resolution sites, CAS winners only | `interrupt_kind` · `resolution` ∈ accepted/rejected/skipped/timeout/timer/cascaded |
| `openwop.compensation.obligation` | `host/compensationLedger.ts` `recordObligation` | `effect_kind` · `shape` (4) |
| `openwop.compensation.resolved` | same, `resolveObligation` | `effect_kind` · `state` (6, RFC 0151 §D) |
| `openwop.a2a.request` | `host/a2aServer.ts` `handleA2aRequest` (wrapper) | `method` (5 served + unknown) · `outcome` (6) |
| `openwop.mcp.request` | `host/mcpServerRouter.ts` `dispatch` + `host/mcpClient.ts` `call` (both wrappers) | `direction` · `method` (13 + unknown) · `outcome` (11) |
| `openwop.protocol.version` | `routes/agents.ts` A2A negotiation + `mcpServerRouter` `initializeResult` | `protocol` ∈ a2a/mcp · `disposition` ∈ absent/served/unsupported/mismatch |
| `openwop.sandbox.execution` | `host/sandbox.ts` `runInSandbox`, `sandboxAdapter.ts` `runSandboxedCode`, `wasiSandbox.ts` `runWasiSandboxedCode`, `sandboxAdapters/e2bAdapter.ts` `runE2bSandboxedCode`, + the budget refusal in `createSandboxRunner` | `runtime` ∈ vm/code-api/wasi/e2b · `outcome` (9) |
| `openwop.provider.call` | `aiProviders/aiProvidersHost.ts` `mapDispatchErrors` | `provider` (6 + other) · `outcome` = ok or one of 15 canonical codes |
| `openwop.attestation.age` | `features/operations/routes.ts` attestation summary | `state` (4) · `environment_class` (3 + unknown) |
| `openwop.http.server.duration` | `middleware/httpMetrics.ts` (new, mounted before auth) | `route` TEMPLATE · `method` (7 + other) · `status_class` (5) |

**Every label domain is produced by a classifier in
`observability/metricSeams.ts`.** That module exists because the P0 guard solves
only half the problem: `guardAttributes` refuses a label whose NAME is wrong,
and cannot refuse one whose name is fine and whose VALUE is a peer's string.
`outcome: err.message` passes the guard and takes the collector down identically.
Reading one file therefore answers the question an operator sizing a collector
actually asks — the complete set of values every metric can take.

**Wrappers, not per-branch emits, at four seams.** `handleA2aRequest` has ~20
returns across five methods; `dispatch` has one per MCP method plus a catch-all;
`mapDispatchErrors` had six throw sites; the MCP client has six typed gates.
Each is now instrumented once around the whole thing. A per-branch counter is a
counter with a hole in it the day someone adds a branch — and an outcome counter
missing a branch is indistinguishable from that branch never happening.

#### SLOs

`docs/SLO.md`. Declared targets, and the document says at the top that they are
targets rather than a commitment, because an SLO published before anyone has
computed it is marketing. Two are **zero** rather than a percentage —
`openwop.effect.blocked` and sandbox `escape_attempt` — because both are bug
reports rather than rates: any non-zero value is actionable at any traffic
volume. That is also why each is a separate metric rather than an `outcome`
label on a busier one; sharing a counter invites an alert on a ratio, and the
ratio lets a busy host hide the event.

#### CORRECTION 1 — `reclaimed` was not a claim outcome, and could not be

ADR 0556 § "Inbound dependency" lists the ledger's outcomes as
`claimed / replay / mismatch / in-flight / reclaimed`. Measured on the code:
**`IdempotentClaim` has no `reclaimed` member.** Taking over an expired lease
returns `{ outcome: 'claimed' }` in both adapters, so a reclaim was
indistinguishable from a first claim to every caller, including a metric.

This is the RECOVERY signal the phase gate names. A live holder cannot outlive
its lease — `idempotencyLeaseMs()` derives from the request timeout precisely so
that it cannot — so a reclaim means a previous holder **died mid-request**. A
metric that could not see it would have reported the most interesting outcome
the ledger produces as the most routine one.

Fixed additively: the `claimed` variant gained `reclaimed?: true`, set on the
CAS-reclaim branch of both the SQLite and Postgres adapters. Every existing
caller is unaffected (both are still "you won, proceed"), and
`idempotencyOutcomeOf()` is the single owner of the mapping so the two
participating routes cannot disagree.

#### CORRECTION 2 — "effect allowed/blocked/replayed" is two metrics, not three outcomes

The decision section asks for "effect allowed/blocked/replayed". `replayed`
cannot be an `openwop.effect.dispatched` outcome: at the ADR 0341 fast path **no
effect is dispatched at all** (that is the point — the node never runs), and the
effect KIND is unknowable there because nothing executed to declare one. An
`effect_kind` label would have to be invented.

So the replay arm is its own metric, `openwop.replay.node.served`, labelled by
what the source run held (`recorded-success` / `recorded-failure` /
`source-missing`). `source-missing` is the fail-closed arm and the one worth
alerting on; the other two are ordinary replay traffic. Counting non-events on
the effect counter would have inflated exactly the number an operator uses to
size egress.

#### CORRECTION 3 — the P0 static lint was under-reporting, and its own guard could not tell

`check-metric-labels.mjs` split the catalog on `}\s*,\s*{`. P1 added a section
comment between two entries; the split stopped matching at that boundary, two
objects merged into one chunk, only the first `name:` was read — and the lint
reported **18 of 19 metrics and exited 0**.

P0's record says its guard exists because "a text-parsing lint that silently
matches nothing passes vacuously". Correct, and insufficient: this parse matched
plenty. The bar is COMPLETENESS, not non-emptiness. The parser now splits on the
entry START (`name:`), which no comment or trailing property can separate an
entry from, and `test/metrics-catalog-parity.test.ts` pins the reported metric
count, label count and forbidden-label count against the compiled catalog — the
three things a partial parse can be wrong about that the lint cannot notice.

This is the same class as `ENG-PACKS-1` and the `skipIf` predicate that made a
whole suite vacuous: assert what the measurement COVERS, never merely that it
produced output.

#### CORRECTION 4 — the sandbox metering was first written as a WRAPPER, and the full gate caught it

The first implementation resolved the sandbox executor to `{ runtime, exec }`
and returned `meteredSandboxExec(runtime, exec)` from `createSandboxRunner()` —
one wrapper covering all four adapters, on the same reasoning as the A2A/MCP
seams. Targeted suites were green. **The full `npm run ci` run went red on four
tests in `e2b-sandbox-adapter.test.ts`.**

Those tests assert `createSandboxRunner() === runE2bSandboxedCode` — REFERENCE
IDENTITY is how ADR 0114 Phase 8 pins which executor the precedence ladder
selected. A wrapper breaks that, and the obvious "fix" — relaxing the assertion
to something a wrapper satisfies — would have deleted the guarantee to
accommodate the instrumentation. Instrumentation must never cost a test its
subject.

So the metering moved INSIDE each exported executor. The resolver still names
the runtime (so the budget refusal, which happens before any executor runs, can
label itself without re-deriving the ladder) but hands back the executor itself.
The cost is three try/catch blocks instead of one; the CLASSIFICATION, which is
the part that could actually drift, still has a single owner in
`classifySandboxError`.

Recorded because of what it says about verification: the targeted-suite loop and
the 30-case sabotage matrix both passed while a real regression sat in the diff.
Neither could see it — the sabotage matrix only runs the metric suites, and the
test that broke belongs to a different ADR. The full gate is not a formality
after a green targeted run; it is the only thing that observes the blast radius.

#### The emission ledger, and why the tests are not asserting on a mock

With `OTEL_EXPORTER_OTLP_ENDPOINT` unset the meter provider carries zero
readers, so a recorded measurement is genuinely unobservable — an assertion on a
counter would have nothing to read. `metrics.ts` therefore records each
measurement into a ledger AFTER the cardinality guard, at the same choke the
instrument uses, so the attribute set a test asserts is the one an exporter
would receive. The ledger is `null` until a test arms it via
`_resetMetricsForTest()`; production pays one null check and the array never
exists.

Assertions are `toEqual` on the whole attribute object, never `toMatchObject`.
The failure this catches is specific: a label the catalog does not declare is
DROPPED by the guard, silently, so a call site can be right and the exported
series still wrong. A partial match would pass.

#### Tests

| File | Tests | Covers |
|---|---|---|
| `test/metrics-golden-telemetry.test.ts` | 11 | The phase gate verbatim — success, failure, retry, replay, recovery — driven through a booted app, real HTTP, a real `:fork`, the real storage claim |
| `test/metrics-seam-coverage.test.ts` | 25 | Compensation, interrupt age (approval-timeout AND timer), the agents idempotent endpoint, A2A, MCP, sandbox, providers, attestation freshness, the workflow-kind classifier, and the guard's violation ledger |
| `test/metrics-catalog-parity.test.ts` | 3 | The static lint sees every catalog entry (CORRECTION 3) |
| `test/metrics-cardinality.test.ts` | 12 | P0's guard, unchanged |

**Call sites NOT covered by a test, named rather than counted.** Four of the 22
seams are instrumented and exercised only through their shared helper and
classifier, because reaching them needs machinery disproportionate to the
assertion: the OUTBOUND MCP `call` (needs a registered connector, a governance
allow and a live credential), the three external sandbox executors' own emits
(need a configured Code-API/E2B/WASI runtime), the three
`routes/interrupts.ts` resolution branches (skip / quorum-reject / accept —
each needs a suspended run and an approver quorum), and the parent-cancel
cascade in `routes/runs.ts`. All four call the same
`recordInterruptResolved` / `recordMcpRequest` / `recordSandboxExecution`
helpers the covered sites do, and the classifiers those helpers use ARE pinned
(`classifyMcpClientOutcome`, `classifySandboxError`, including the folding of an
unrecognised code). What is unproven is the CALL, not the mapping — stated here
because "22 seams instrumented, 30 sabotages red" would otherwise read as full
coverage, and counting tests is precisely how this program has been misled
before.

Each seam test has an ADVERSARIAL case, because the question is not "did a
counter move" but "can a value a peer, a tenant or a provider chose reach a
label": three hostile A2A method strings collapse to ONE series; a provider
error body containing `sk-live-…` never appears in an emission; a tenant's
custom `metadata.source` does not mint a `workflow_kind`; the HTTP route label
is asserted never to contain the run id just minted.

#### CORRECTION 5 — rebasing onto ADR 0554 P2 gave the compensation metric a real producer, and exposed a hole

ADR 0554 P2 (`800b6f0da`) landed the reverse-completion unwind while this branch
was in flight, touching two of the same seams. Both conflicts resolved by
KEEPING BOTH, not by choosing:

- `runEffectContext.ts` — the guard's allow branch now has THREE consumers, and
  none is derivable from the others: ADR 0533's per-run tally (keyed by `runId`,
  a forbidden metric label), P2's per-NODE `observedEffectKinds` set (feeds one
  obligation), and P1's host-wide counter. They sit together deliberately: an
  effect counted by one and not the others is a divergence no test would notice.
- `compensationLedger.ts` — P2 wrapped `resolveObligation` in a per-obligation
  serialization lock, so the P1 emit now sits INSIDE it. That is not incidental.
  Before the lock, two concurrent unwind passes each fired the inverse; a
  counter placed there would have reported two `started` for one obligation —
  which was the honest reading of a real double-refund. The lock fixes the
  behaviour and the number together, and the code says so, because moving the
  emit outside it silently turns a transition counter into an attempt counter.

**The compensation metrics now have a real producer, so they are tested against
it.** The pre-rebase tests called `recordObligation`/`resolveObligation`
directly, which proves the ledger emits but not that anything CALLS it — those
counters could have sat at zero in production with every test green. Three legs
now drive `unwindRun` itself: a clean unwind (started→completed per obligation,
in reverse order), a retry-exhausted unwind (`failed`, non-terminal by design),
and an unresolvable inverse (`manual_intervention_required`).

**The third leg exists because a sabotage went green.** Flipping `markManual`'s
target state to `completed` was NOT detected: the first two legs park at
`failed` and never reach that path. `docs/SLO.md` C1 is an objective ON
`manual_intervention_required` — so an SLO had been declared for a series no
test proved could be emitted. That is the same class as CORRECTION 3 in a
different costume: a measurement that looks complete because nothing exercises
the part that is missing. The leg was added, and the sabotage now reds.

#### Sabotage table — 32 applied, 32 red

Each sabotage was applied to the working tree, the affected suite run, and the
file restored. Harness output in the PR body.

| # | Sabotage | Result |
|---|---|---|
| S1–S3 | `recordRunStarted` / `recordRunTerminal` / `recordNodeDuration` call removed | red |
| S4–S5 | effect BLOCKED / ALLOWED emit removed | red |
| S6 | `recordReplayServed` removed | red |
| S7 | idempotency claim emit removed | red |
| S8 | **`reclaimed: true` removed from the SQLite adapter** | red |
| S9 | HTTP duration emit removed | red |
| S10 | **HTTP `route` label switched to the RESOLVED PATH** | red |
| S11–S12 | compensation obligation / resolved emit removed | red |
| S13–S14 | interrupt created / age emit removed | red |
| S15 | **interrupt age emitted on the CAS LOSER too** (double-counts one wait) | red |
| S16, S18 | A2A request / version emit removed | red |
| S17 | **A2A `method` label passes the peer's string through** | red |
| S19–S20 | MCP inbound / version emit removed | red |
| S21 | sandbox emit removed | red |
| S22 | **`escape_attempt` collapsed into generic `error`** | red |
| S23–S24 | provider success / mapped-error emit removed | red |
| S25 | **lint parser restored to the P0 split** (drops entries) | red |
| S26 | timer-resolution emit removed | red |
| S27 | attestation age emit removed | red |
| S28 | **attestation age emitted for `absent` too** (a zero reads as "issued just now") | red |
| S29 | agents-route idempotency emit removed | red |
| S30 | replay `recorded-failure` emit removed | red |
| S31 | compensation `resolved` emit removed — kills the UNWIND legs too | red |
| S32 | **unwind marks `manual_intervention_required` as `completed`** (a human-blocked unwind reads as clean) | red, AFTER the third leg was added — green before it |

The bolded rows carry the claim. Deleting a call is the easy sabotage and any
"counter incremented" test catches it. S8, S10, S15, S17, S22, S25 and S28 all leave
a metric being emitted, on every path, with a plausible-looking value — and each
is a real production failure mode: a recovery event filed as routine, a
per-entity label, one human wait counted twice, an unbounded peer string, a
security signal folded into noise, a gate measuring 94% of its subject, and a
missing attestation reporting as freshly issued.

#### What P1 does NOT do

- **Dispatch-outbox depth, oldest age and lease recovery are OUT OF SCOPE.**
  ADR 0551 P1 owns the outbox and is being built concurrently on another branch;
  those three signals land with it. Instrumenting a queue that does not exist
  yet would have shipped three metrics pinned at zero, and a flat zero reads as
  health.
- **`openwop.run.duration` is incomplete by construction.** It is emitted only
  for runs whose START this process observed, because `notifyRunTerminal` is
  given nothing but an id and a status and the kind/start live in an in-process
  registry. A run terminating after a cold start or on another instance reports
  `workflow_kind: unknown` and NO duration. Fabricating one from `run.createdAt`
  would time the queue wait as well as the run; fabricating a kind would be a
  guess indistinguishable from a measurement. Closing it needs the kind stamped
  on the run row — a data change, and P2's.
- **Emission was chosen over the `onAnyRunTerminal` fan-out** for the terminal
  metric. That fan-out is fire-and-forget, and this app has already lost a
  detached continuation to Cloud Run CPU throttling (the SPA-shell refresh
  wedge, #3056). A terminal counter that silently stops on a throttled instance
  reads as a traffic drop.
- **No production numbers.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset nothing is
  collected. P1 makes the host measurable; whether it MEETS `docs/SLO.md` is
  unmeasured, and the document says so rather than implying a baseline exists.
- **P2 (Operations projection/alerts)** consumes these series and is unstarted.

> **CORRECTED 2026-08-17 by P2.** Two claims in this P1 record did not survive
> being built on. (1) "unstarted" is now false — see the P2 record at the end of
> this file. (2) The phase table said `docs/SLO.md` carried **26 objectives**;
> the document has always had **31** (A1-A3, W1-W4, R1-R2, I1-I3, C1-C2, H1-H2,
> P1-P4, M1-M2, S1-S3, F1-F2, Q1-Q4). P2 counted them by parsing the file rather
> than by reading the summary, which is the only reason the discrepancy surfaced
> at all, and it is now held by a bijection test so neither number can drift
> again. A miscount is harmless; a miscount nobody can detect is the pattern
> this program keeps paying for.

## Alternatives weighed

- Logs-only metrics: rejected; aggregation and SLOs become expensive and
  inconsistent, and the existing code explicitly records this gap.
- Vendor SDKs in each subsystem: rejected; they fragment semantics and increase
  lock-in.
- Reuse user tokens in workers: rejected; it erases actor/workload distinction
  and creates overbroad, long-lived authority.

## P3 §A/§B — implemented 2026-08-16

The workload-identity and delegated-actor-chain lane of RFC 0154. §C (sender
constraint / token exchange) beyond the advertised set, §D's experimental GenAI
projection, and §E (artifact provenance) are explicitly NOT in this phase; what
is and is not claimed is listed at the end.

### RFC § → host mapping

| RFC 0154 / spec | Host |
|---|---|
| §A verify → bind → check audience → resolve to principal → fail closed | `host/workloadIdentity.ts` — `verifyWorkloadCredential` (cryptographic half) + `resolveWorkloadIdentity` (policy half) |
| §A "identity used for authorization is the one verified on THIS connection or proof, never one asserted in a header" | `middleware/workloadIdentity.ts` reads ONE header (`X-OpenWOP-Workload-Identity`) carrying a **credential**, never a projection. `resolveWorkloadIdentity` takes an explicit `provenance` with exactly two admissible values, and no `'header'` member exists — the rule is structural, not remembered |
| §A closed reason vocabulary, non-retriable | `WORKLOAD_REFUSAL_REASONS` (the five §20 codes) + a finer internal `WorkloadRefusalCause`, joined by one `CAUSE_TO_REASON` map |
| §A "the resolved principal MUST NOT be the presented `subject` verbatim" | `principalIdFor` → `workload:<scheme>:<salted-hash>`; the mapping is documented here and at the advert |
| §B chain is provenance, bounded, acyclic, expiring, audience-checked, issuer-checked | `checkDelegation` |
| §B "a caller MUST NOT self-assert `onBehalfOf`" | `onBehalfOf` enters the projection only from claims a signature was verified over; `resolveInner` refuses it on any other provenance |
| §B neutralization without disclosure (RFC 0132 §A.2) | `tenant_mismatch` maps to the SAME wire reason as an unmapped subject, so a prober cannot use the refusal as an existence oracle |
| §C bearer fallback "MUST be explicitly advertised and policy-controlled" | `senderConstraint: []` is emitted, not omitted — the empty array IS the declaration. `senderConstraint` is enforced when configured (`sender_constraint_missing`) |
| §C "audit facts MUST distinguish a bearer-verified identity from a key-bound one" | `openwop.identity.sender_constraint` = `mtls` / `dpop` / `none` on every record |
| §D content-free `authorization.decided` audit fact | `host/authorityContext.ts` `recordAuthorizationDecision` → the durable per-tenant hash chain (`auditChainService.appendAudit`) |
| §D hashed subjects, per-tenant ROTATABLE salt (gap G5) | `subjectSalt(tenantId)` via the existing BYOK resolver (`auth:workload-identity-subject-salt`); rotation = write the ref, and prior hashes become unlinkable without editing an append-only log |
| `observability.md` §"Identity and delegation attributes" | `authorityAttributes` emits `openwop.actor.*` / `openwop.identity.*` / `openwop.delegation.depth` / `openwop.authz.*` on the active span. The chain itself is never an attribute — only its depth |
| `host-sample-test-seams.md` §20 | `routes/workloadIdentitySeam.ts`, capability-gated per request + `OPENWOP_TEST_SEAM_ENABLED` |
| ADR: "workers receive short-lived, audience-bound credentials, not copied user bearer tokens" | `mintWorkloadCredential` (HS256, host key, TTL capped at `MAX_CREDENTIAL_TTL_S` = 300s, audience-bound); `host/runDispatchSweeper.ts` mints, verifies and resolves its own through the same path a peer's takes |
| ADR: "every outbox/A2A/MCP/sandbox/compensation action records both actor and workload identities" | `recordAuthorityAction` at `runEffectContext.assertEffectAllowed` (allow branch), BOTH `runDispatchSweeper` lanes (`sweepDispatchOutbox` and `sweepOrphanedRuns`), `a2aSurface.rpc`, `mcpClient`, `sandboxAdapter.runSandboxedCode`, `compensationRuntime.invokeInverseAction` |
| ADR: "replay uses the recorded authority facts and does not remint broader authority" | `authorityRunStartContributor` freezes the authority onto the run; `stampRunStartContext`'s never-overwrite merge makes a fork inherit it; `authorityForReplay` INTERSECTS the recorded scopes with the forking caller's, applied at `routes/runs.ts` `:fork` |

### The schemes claimed, honestly

`capabilities.auth.workloadIdentity.schemes[]` is **derived** from the configured
trust roots (`advertisedWorkloadSchemes`), never a literal. A scheme can only be
claimed by configuring a root that issues it, so `mtls-san` and `cloud-subject`
are unclaimable on this host: it terminates no client certificates and performs
no cloud attestation. The default configuration claims `oauth-client` (the host's
own issuer, for its workers); a deployment that configures a JWT-SVID-shaped root
additionally claims `spiffe`. Verification is HS256 over a compact JWS against a
key resolved from the existing BYOK resolver — the SPIFFE **Workload API** and
X.509-SVIDs are not implemented, and no root can be configured that would imply
they are.

### What the §20 seam does and does NOT exercise, stated rather than implied

§20's request body is a `workload-identity` object, and that schema is closed
precisely so credential material cannot be handed to it. The seam therefore
supplies a **projection**, not a proof: it exercises bind → audience → sender
constraint → chain → principal, driving the SAME `resolveWorkloadIdentity` the
production middleware calls. The cryptographic half is exercised by
`verifyWorkloadCredential` and its own tests (tampered signature, `alg`
confusion, expiry). The resolver is told which it is getting — the seam's
`provenance` is `'test-seam'`, and that value is refused outright unless
`OPENWOP_TEST_SEAM_ENABLED=true`, so the seam's relaxation cannot exist in a
production boot even if the route were left registered.

### Verification

| Evidence | Result |
|---|---|
| `backend/typescript/test/workload-identity-resolver.test.ts` | 28 tests |
| `backend/typescript/test/workload-identity-surface.test.ts` | 18 tests |
| `backend/typescript/test/agrade-wire-blocked-residue.test.ts` | 16 tests (honesty pair discharged → positive obligation) |
| Sibling corpus `workload-identity-behavior.test.ts` (openwop `main`, newer than the pinned 1.106.0) against a locally booted host | **`executed-pass`, 12 assertions** — not `blocked`, not skipped (RFC 0148 §A ledger) |
| Same suite against a boot WITHOUT the profile | **6 failures** under `OPENWOP_REQUIRE_BEHAVIOR=true` — the measured proof the pass above is not vacuous |
| `npm run test:conformance -- --filter workload-identity` (pinned 1.106.0, whose scenario files are byte-identical to the sibling's) | 6 passed |
| **Independent witness — spec worker `openwop-1`, suite 1.120.0, against this branch at `8cb634fa3`** | **17 passed, 30 witnessed assertions, zero early returns.** Ledger: `workload-identity-behavior` `executed-pass` / 12; `workload-identity-profile` `executed-pass` / 18. Recorded as the first non-vacuous RFC 0154 host witness |

#### The independent witness, and how to reproduce it

The row above is **not** this phase's own run. It was driven by the spec worker
`openwop-1` from the `openwop` corpus at suite **1.120.0** — newer than both the
pinned 1.106.0 and the `main` checkout used for the two rows above it — against
this branch at `8cb634fa3` (PR #3278). It is attributed rather than absorbed
because a host grading its own conformance is the shape this program exists to
distrust, and because the version it ran is one this repo cannot pin today.

It is a **tier-1, local boot of an UNMERGED branch**, not the deployed
`origin`. The record therefore cites a branch; a re-drive at the merge commit is
owed once #3278 lands, and until then no claim here rests on `main`.

> **RE-DRIVEN AT `main`, 2026-08-16 — the owed re-drive is DISCHARGED (H22).**
> #3278 landed and `openwop-1` re-drove the same two legs at **`8fbed15d4`**,
> the merged commit on `main`, with suite **1.120.0** in strict mode
> (`OPENWOP_REQUIRE_BEHAVIOR=true`) against a `memory://` boot on port 18097.
> Ledger: `workload-identity-behavior` **`executed-pass` / 12 assertions**,
> `workload-identity-profile` **`executed-pass` / 18** — **17/17 passed, 30
> witnessed assertions, zero early returns**, identical to the branch run.
> The paragraph above stays as written because the reasoning trail is the point,
> but the claim it hedges no longer needs hedging: **the RFC 0154 witness now
> rests on `main`, not on a branch.** Nothing further is owed here.

Reproduction — a `memory://` boot on port 18097 via
`backend/typescript/conformance/witness-boot-rfc0140.ts`, with:

```
OPENWOP_WORKLOAD_IDENTITY_AUDIENCE=openwop-host
OPENWOP_WORKLOAD_IDENTITY_ISSUER=urn:openwop:conformance-host
OPENWOP_WORKLOAD_IDENTITY_TRUST=[{"issuer":"spiffe://example","scheme":"spiffe",
    "issuerClass":"spiffe","tenantId":"default",
    "scopes":["manifest:read","runs:read","artifacts:read"],
    "keyRef":"auth:workload-identity-conformance-key"}]
OPENWOP_BOOT_SECRETS={"auth:workload-identity-conformance-key":"<any value>"}
OPENWOP_TEST_SEAM_ENABLED=true
OPENWOP_REQUIRE_BEHAVIOR=true        # on the SUITE side — strict mode
```

These are the same names `conformance/run.ts` sets for the in-repo harness, so
the recipe is one configuration read two ways rather than a second one. Discovery
then serves exactly:

```json
{"supported": true, "schemes": ["spiffe", "oauth-client"],
 "senderConstraint": [], "delegation": {"supported": true, "maxChainDepth": 4}}
```

The six behavioural legs it witnessed are the ones §A's requirements are
otherwise invisible for: the seam is wired; a verified identity resolves to a
principal; an other-audience identity is rejected; an expired delegation is
rejected; the failure carries a non-retriable closed reason code; and the
resolution response carries no credential material. **Zero early returns** is the
load-bearing part of that sentence — `behaviorGate` returning `false` would make
every leg a silent pass, and the ledger dispositions are what rule that out.

### Sabotage table — every guard broken, every break red

| # | Sabotage | Result |
|---|---|---|
| S1 | audience-mismatch check removed | RED |
| S2 | absent-audience check removed | RED |
| S3 | chain cycle allowed | RED |
| S4 | chain-depth bound removed | RED |
| S5 | delegation expiry check removed | RED |
| S6 | foreign-tenant assertion allowed through | RED |
| S7 | scope amplification silently trimmed instead of refused | RED |
| S8 | unverified projection provenance accepted | RED |
| S9 | self-asserted `onBehalfOf` accepted | RED |
| S10 | credential `alg` read from the credential instead of pinned | RED |
| S11 | principal id returned as the subject verbatim | RED |
| S12 | closed-shape check accepts extra keys (credential smuggling) | RED |
| S13 | replay authority computed as a UNION instead of an intersection | RED |
| S14 | fork route stops calling the narrowing function | RED |
| S15 | advertised schemes hard-coded as a literal | RED |
| S16 | seam marks a refusal retriable | RED |
| S17 | middleware ignores an unverifiable credential instead of refusing | RED |
| S18 | a `openwop-workload-identity*` opt-out comes back beside the advert | RED |

> **S10 was GREEN on the first pass, and the fix is the lesson.** The `alg`
> test presented an `alg: "none"` header with an EMPTY signature — which the
> HMAC comparison rejects whether or not the `alg` pin exists. A two-fence test
> proving the wrong fence. It now presents `alg: "none"` and `alg: "HS512"`
> headers carrying signatures that are genuinely valid over them, so only the pin
> can refuse them. Every other row above was red on the first attempt; this one
> was measured, not assumed.

### What is NOT done

- **§C sender constraint** beyond advertising the (empty) set. mTLS and DPoP
  proof-of-possession are unimplemented; the resolver enforces a constraint when
  one is configured, but no deployment can honestly configure one yet. The
  advert is the explicit bearer-fallback declaration §C requires, not a claim.
- **§C token exchange.** The host mints its own worker credentials; it does not
  implement RFC 8693 exchange of an upstream credential.
- **§D's GenAI projection.** The canonical `openwop.*` attributes ARE emitted;
  the `gen_ai.*` v0 projection is optional, upstream-unstable, and skipped —
  `observability.md` states core conformance MUST NOT require it.
- **§E artifact provenance.** Cross-repo (`openwop-sdks`, `openwop-registry`);
  cannot land here.
- **P4 assurance integration** (ADR 0550 attestation carrying telemetry/SLO
  evidence) is untouched.
- **No authz/identity outcome METRIC.** `src/observability/metrics.ts` has no
  authorization or identity entry in its catalog and P1's instrumentation seam
  (`metricSeams.ts`) has no mapping for one, so adding a series here would be a
  P1-shaped change made in a P3 commit. The decision facts are on the span and in
  the durable audit chain today; a `openwop.authz.decision` counter labelled
  `{outcome, issuer_class}` (both closed sets, both safe under the P0
  cardinality lint) is the natural addition and belongs with P2's Operations
  projection, which is what would read it.

  > **CLOSED 2026-08-18 (P4).** Shipped exactly as specified above:
  > `openwop.authz.decision{outcome, issuer_class}`, emitted from
  > `recordAuthorityAction` — the SAME call that writes the span attribute and
  > the log line, for the reason the effect seam gives for its own trio: a
  > record attached anywhere else could describe a decision that did not happen,
  > or miss one that did.
  >
  > Two label decisions worth stating, because both could have gone the lazy way:
  >
  > - **`seam` is NOT a label.** It is open-ended (`effect`, `dispatch`,
  >   `sandbox`, and whatever is added next), and an unbounded label is the exact
  >   failure the P0 cardinality lint exists for. Pinned by a test that drives
  >   three different seams and asserts ONE series.
  > - **An unattributed decision is `issuer_class: 'unattributed'`, not
  >   `'anonymous'`.** Most facts carry no verified workload identity; folding
  >   them into `anonymous` would state something FALSE, since `anonymous` is a
  >   verified anonymous issuer rather than an absent one.
  >
  > **NO SLO ROW, deliberately — and this is a correction to how the work item
  > was written down.** The item was boarded as "the counter (+ an SLO row)",
  > and the second half should not be built. An objective needs a defensible
  > target, and a denial RATE has none before anyone has measured a baseline:
  > refusing an unauthorized caller is the system working, so neither "denials
  > should be near zero" nor any particular percentage is justifiable today.
  > `docs/SLO.md`'s own header says these are "measurable, not yet measured
  > against a production baseline", and inventing a threshold to fill a row is
  > precisely the marketing that header warns against. The series ships so a
  > baseline CAN be measured; the objective is the next honest step after that,
  > not this one.
- **The outbox worker's own OUTBOUND credential.** Both dispatch lanes now run
  under an attributed authority (see the correction below), but neither makes an
  outbound HTTP call — dispatch is in-process (`setImmediate` → `executeRun`).
  There is therefore no outbound credential to carry today. If the outbox ever
  dispatches over the wire, `mintWorkloadCredential` is the function it calls.

### Corrections to the plan as written

- **The ADR's decision list says "authenticated human/service principal;
  executing workload identity; delegator chain".** Implemented as TWO fields on
  `AuthorityFacts` (`actor` + `workload`) rather than one principal with a role,
  because the ADR's own Context section is explicit that the two "must not
  collapse into one bearer or log label" and a single field is that collapse.
- **`delegation-chain-bounded` is registered upstream; acyclicity is not.** The
  host refuses cycles anyway (`chain_cycle`, sabotage S3), so the behaviour is
  ahead of the registered invariant rather than behind it. Nothing here claims
  `delegation-chain-bounded-acyclic` — it is one of the six §F invariants RFC
  0154 names and does not register.
- **A delegation with NO `expiresAt` is REFUSED.** `auth.md` §B offers "SHOULD
  refuse it or bound it by policy"; this host takes the refuse branch, and
  reports it as `delegation_expired` because that is the closest code in §20's
  closed five. The finer internal cause is `delegation_no_expiry`.
- **CORRECTED at the rebase onto `28740fb4d` (ADR 0551 P1).** This record first
  said the outbox worker had "no outbound credential to carry" and left it at
  that — written when `runDispatchSweeper.ts` had ONE dispatch lane. ADR 0551 P1
  then added a second, `sweepDispatchOutbox`, which hands runs to `executeRun`
  from the same background worker with the same absence of a request principal.
  Attributing the orphan lane and not the outbox lane would have left half the
  dispatch surface unrecorded, with which half depending only on which lane
  picked a run up — so `sweeperAuthority` is now called from both. The rebase
  conflict is what surfaced it; a clean auto-merge would have shipped the gap
  silently, which is the argument for reading a conflict rather than resolving
  it by shape.
- **A one-hop chain naming the presenting workload is NOT a cycle.** The
  conformance witness's expired-delegation leg presents exactly that and expects
  `delegation_expired`; a cycle check that folded the presenter into the seen-set
  would answer `chain_cycle` and the leg would fail. Acyclicity is checked WITHIN
  the chain, and expiry is answered first regardless.

## P2 — Operations projection/alerts, implemented 2026-08-17

### The finding that shaped the whole phase

**This host could not read back a single one of its own metric values.**
`createMetrics()` builds the `MeterProvider` with a `PeriodicExportingMetricReader`
only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and with **zero readers**
otherwise — which P0 chose deliberately and documented ("instruments are real,
nothing is collected or shipped"). Correct for a dev box; fatal for a projection.
Nineteen metrics were being recorded into a provider with nothing on the other
end, so "extend the Operations hub with SLO panels" had no numbers to extend
with.

That left exactly three ways to get a value, and two of them are the mistakes
this ADR exists to prevent:

| Option | Verdict |
|---|---|
| Query an external metrics backend (Prometheus/OTLP store) | **Rejected.** It IS the "second metrics database" the Decision section forbids, and it makes the console that diagnoses an outage depend on the system most likely to be part of it. |
| A bespoke in-process rolling aggregator beside the OTel instruments | **Rejected.** A second telemetry path with its own definition of every SLI — precisely what ADR 0549 P2 declined to stand up, and what the "Inbound dependency" section above records as the reason its counters were deferred here. |
| A second READER on the provider that already exists | **Taken.** Same instruments, same catalog, same cardinality guard, same emission choke. Nothing new is measured; the numbers merely stop being write-only. |

The third is not a workaround — the Decision section already names it:
"production qualification does require a healthy exporter **or an explicit
local-scrape operator profile**." `LocalScrapeMetricReader` (no exporter, no
timer, `collect()` on demand) is that profile, opt-in via
`OPENWOP_METRICS_LOCAL_SCRAPE=true`, and independent of the exporter so an
operator can run either, both, or neither.

### The honesty problem, and why it is a property and not a bug

`docs/SLO.md` declares a **28-day rolling, fleet-wide** window. A local scrape
delivers neither half: the SDK's cumulative aggregation begins when the reader
is created, and it aggregates only what THIS process recorded.

A panel labelled "SLO attainment" on those numbers would be wrong in the most
flattering possible direction — **a freshly restarted instance shows 100%
availability because it has served four requests and none of them failed.** That
is not a hypothetical; it is the default reading of every deploy.

So the gap is carried on the wire rather than papered over:

- every response reports `window.kind: 'process_uptime'` with the instant
  aggregation began, and `perInstance: true` — the same honesty the DLQ and
  system-health panels beside it already carry;
- nothing is called attainment or compliance. A row that meets its target is
  `healthy`, a claim about the current instance;
- `sampleCount` travels with every value, because a ratio over three samples is
  not evidence and the panel should not make a reader infer that;
- the panel shows an always-on chip saying so, and the runbook opens with it.

### Six states, and the four confusions they exist to prevent

| State | Means | Would be catastrophic if confused with |
|---|---|---|
| `unknown` | the local-scrape profile is off | `healthy` — a host with no reader records every blocked effect it suffers and can report none of them |
| `empty` | reader on, no qualifying sample | `healthy` — 0/0 rendered as 100% |
| `stale` | emitted, then stopped inside its freshness horizon | `healthy` — a frozen gauge still divides and still compares; it just describes a moment that has passed |
| `not_projectable` | the catalog cannot answer this objective as worded | `unknown` — one is fixed by an env var, the other by a new metric |
| `healthy` / `breaching` | computed and compared | — |

**Freshness is captured at RECORD time, not collection time**, and that is the
one implementation detail most likely to have been got wrong. A cumulative data
point's `endTime` is the moment the reader collected it, so a counter that
stopped ticking an hour ago presents a timestamp from one millisecond ago.
Deriving staleness from the snapshot would have reported every dead series as
perfectly fresh. `lastEmissionAtMs` is therefore a live production map, bounded
by `METRIC_CATALOG.length`, written at the same choke as the test-only emission
ledger.

Freshness horizons are **opt-in per row**, and two classes are excluded for
opposite reasons:

- **Every zero-target objective.** `openwop.effect.blocked` recording nothing
  for an hour is the SLO being MET, and flagging that as stale would page an
  operator for health.
- **The HTTP histogram behind A1-A3** — and this one was a genuine reversal
  during the phase. It looked like the strongest candidate: a middleware on
  every request, so silence means the middleware is gone, which is exactly the
  thing a 100%-success ratio cannot tell you. But the reasoning inverts on a
  quiet host. No samples means no TRAFFIC, which is a legitimate state, and the
  panel would have raised three alerts on every cold load of a low-traffic
  deployment and cleared them 30 seconds later on its own auto-refresh. **An
  alert that fires routinely and self-clears teaches operators to ignore
  alerts**, which costs more than the failure it was watching for — and a
  middleware that stops being mounted is a code regression with its own test,
  not an operational drift. Caught by reasoning about `app.openwop.dev`'s actual
  traffic rather than by a test, which is why it is recorded here.

What remains is the case the mechanism was built for: the two gauges the
dispatch sweeper writes every 5 s, where a dead sweeper FREEZES the last value
so the arithmetic reports a healthy queue forever. A sweeper that never ran at
all reports `empty`, not `stale` (`lastSampleAt` is null) — a disabled daemon is
not a failed one. Both properties are pinned by tests over the catalog, so
neither can be widened back by accident.

### Two objectives that cannot be honestly projected, and are not

- **C2** ("obligations still not completed after 24 h") needs each obligation's
  AGE, which no counter carries. `recorded − completed` answers a *different*
  question — open right now, at any age — wearing the same shape, which is
  exactly what would make substituting it dangerous.
- **Q1** ("≤ 50 pending SUSTAINED over 5 min") cannot be judged from a
  point-in-time gauge. `docs/SLO.md` says so in its own voice — "alert on a
  SUSTAINED level, never a single scrape" — so evaluating the instantaneous
  value would have produced precisely the alert that sentence forbids.

Both render as `not_projectable` with the reason, and neither raises an alert.
A number that answers a different question than its label claims is worse than
no number, because nobody audits the ones that look plausible.

### Reuse, not reinvention

- **The RBAC predicate is `requireSuperadmin`, verbatim** — the same one every
  other cross-tenant read and write on this surface uses. No new predicate, and
  no agent tool: a tool would need the identical predicate (the CLAUDE.md
  "AI↔app" rule) and nothing asked for one.
- **The SSE route set for A2/A3 is the rate limiter's `SSE_STREAM_PATHS`**, not a
  copy. Its `__isSseExemptPathForTests` was promoted to a properly-named
  `isSseStreamPath`, and it accepts a route TEMPLATE because every pattern
  matches its variable segment with `[^/]+` and `:runId` contains no slash. A
  second list would have been a second answer, and it would have drifted.
- **No chart library**, per the Decision section's "does not become a second
  metrics database or tracing UI": a number, a target and a word carry every row.
- **The panel is a fourth section in the existing `OperationsHubPage`** with the
  same per-panel `forbidden / failed / loading / empty` outcome state the
  UX-OPS-1 fix established, extended with this phase's two new states.

### Nothing tenant-scoped can leak, structurally

Every value on the response comes from a metric attribute, and P0's cardinality
guard drops any attribute outside the metric's declared closed label set. Tenant,
run, user, key and URL are all in `FORBIDDEN_LABELS`, so there is no path by
which one reaches the aggregation this route reads. A route test asserts the
whole serialized body contains neither a recorded run id nor the operator's own
tenant id.

### Verification

| Artefact | Tests |
|---|---|
| `test/slo-projection.test.ts` | 27 — six states, four evaluators, SSE exclusion, 0/0 guard, cross-metric denominator, numerator∩denominator, quantile edges |
| `test/slo-projection-doc-parity.test.ts` | 9 — `docs/SLO.md` ↔ `SLO_CATALOG` bijection on id/metric/threshold, runbook heading existence, anchor uniqueness |
| `test/operations-slo-route.test.ts` | 10 — RBAC tiers, flat S22 envelope, end-to-end read of values recorded through the real seams, label-leak check |
| `src/features/operations/__tests__/sloPanelStates.test.tsx` | 9 — every panel state, each asserting its neighbour is ABSENT |

Frontend `npm run build` (the canonical gate: `tsc` + 26 token/CSS/i18n/a11y
checks + `vite build`) green. Backend `tsc --noEmit` green. Regression: the 8
metrics/operations suites (83 tests) and both rate-limit suites (15) unchanged.

**`check-i18n` caught a real defect the tests did not**: the panel formatted
percentages with a hard-coded `toFixed(2)` + `%`, outside `src/i18n/format.ts`.
That ships an English-only separator and suffix into four locales. Routed
through `formatPercent` / `formatDurationSeconds` / `formatNumber`. The build
gate is the reason this ADR does not have a fifth locale bug in it.

### Sabotage table — every guard broken, every break red

| # | Sabotage | Result |
|---|---|---|
| S1 | ratio `0/0` returns 1 instead of `empty` | 2 red |
| S2 | zero-target row with no samples reports `empty`, not met | 2 red |
| S3 | freshness comparison replaced with `false` | 3 red |
| S4 | SSE-route exclusion removed from the latency objectives | 1 red |
| S5 | W1's evaluator threshold drifts 97% → 90% away from the published target | 1 red |
| S6 | an objective published in `docs/SLO.md` with no evaluator behind it | 4 red |
| S7 | a runbook heading an alert links to is renamed | 2 red |
| S8 | the doc-table parser is made to match nothing | 2 red (fails rather than passing vacuously) |
| S9 | `requireSuperadmin` removed from the SLO route | 3 red |
| S10 | the local-scrape reader is never registered on the meter provider | 4 red |
| S11 | collector-off falls through to the normal (healthy-looking) render | 1 red |
| S12 | a failed read no longer reports failure | 1 red |
| S13 | the SLO read's 403 goes global again (the UX-OPS-1 regression) | 1 red |
| S14 | a freshness horizon re-added to A1 (the reversal above, undone) | 1 red |

> **S3 was GREEN on its first run, and that was the most useful moment in the
> phase.** The `perl` pattern assumed eight spaces of continuation indent where
> the file has six, so the substitution never applied and the suite passed
> because *nothing had been sabotaged*. A green sabotage is indistinguishable
> from a strong guard unless you check that the edit landed — which is the same
> "gates that cannot fail" class as S8, as P1's lint reporting 18 of 19 metrics
> and exiting 0, and as the merge gates whose entry point never ran. **A
> sabotage step must assert its own diff before it asserts a test result.** Once
> the substitution actually applied, S3 went 3 red.
>
> S10 is the one that carries the phase's central claim. The projection could
> have been wired to a reader nothing writes to, in which case every objective
> would answer `empty` forever and all 26 fixture tests would still pass. Only
> a route test that records through the real `metricSeams` helpers and reads the
> value back out of the HTTP response can tell those apart.

### What is NOT done

- **Fleet aggregation.** The projection is per-instance and says so. A fleet
  view needs the collector (`OTEL_EXPORTER_OTLP_ENDPOINT`) and a query against
  it, which is the "second metrics database" this ADR declines to build. The
  panel deep-links an operator to their own observability tool instead, which is
  what the Feature-evaluation matrix row 10 always said it would.
- **A true 28-day rolling window.** Same reason. It is a property of where an
  in-process reader gets numbers from, not a defect to fix in the panel.
- **C2 and Q1 as computable objectives.** C2 needs an obligation-age histogram
  in the metric catalog (an additive P4-or-later change, not a projection
  change). Q1 needs a sustained-level evaluation, which needs either a series
  history this host deliberately does not keep or a collector-side rule.
- **Alert delivery.** The projection RAISES alerts; nothing routes them to a
  pager. Routing belongs to the operator's own alerting stack reading the
  collector, and inventing an in-host notifier here would be a third
  notification owner.

### P2 — architecture review, and what it overturned (2026-08-17)

The phase was reviewed against the `architect` skill before the gate. It found
**nine** things wrong, and the ones that mattered were not style points — three
of them were the projection quietly answering a different question than its
label claimed. Recorded in full because the corrections are the content.

| # | Finding | Disposition |
|---|---|---|
| 1 | Temporality inherited, not pinned | **Fixed.** Under DELTA, `collect()` is DESTRUCTIVE: two operators refreshing at once each see a fraction, and no reading is repeatable. Cumulative is today's default; inheriting a default a future SDK bump could flip would turn the whole surface into a silent lie. |
| 2 | No cardinality ceiling, and the default is reachable | **Fixed.** MEASURED: `grep -c` gives **1595** route registrations, and `DeltaMetricProcessor.js:29` is `(aggregationCardinalityLimit ?? 2000) - 1`. `http.server.duration{route,method,status_class,stream}` genuinely overflows, and the SDK does not warn — it folds series into `otel.metric.overflow: true`. Explicit ceiling + a `degraded` state + `series.{count,limit,overflowed}` on the response. |
| 3 | Quantiles estimated when they can be EXACT | **Fixed, and it deletes a caveat.** Every threshold in the catalog is already a declared bucket boundary (A2 `1`, A3 `5`, W2 `300`, W3 `30`, H1 `14400`, F1 `604800`), so `count(≤T)/count ≥ NN%` is the literal objective, computed by counting. The `bucket_estimate` caveat is gone because there is no estimate. `nonExactQuantileRows()` is asserted empty, so a future row that would need interpolation must be marked `not_projectable` instead. |
| 4 | F1's kind picked silently | **Fixed.** Decided as "EVERY read within 7 days" (share = 1.0) and the reasoning written down: the recorded max is exact but, under cumulative aggregation, one ancient read pins it forever so a host that fixes its attestation can never go green again; a p95 invents a percentile the row does not state. The doc's prose and the catalog's number are now pinned to each other. |
| 5 | `http.server.duration` freshness is unfalsifiable | **Already fixed, better reason adopted.** I had dropped it for the quiet-host false-alarm reason; the review's framing is sharper — the projection request itself emits into that histogram, so the check could never fail. A guard that cannot fail. |
| 6 | Q1/Q2/Q4 read gauges while the same page renders the DB | **Fixed — the sharpest finding.** `routes.ts` already renders `dispatchOutboxStats()` in the panel directly above. Two numbers for one quantity on one page, and the gauge was the worse one: point-in-time, observed only on sweeping instances, frozen elsewhere. Now DB-sourced, with `source` on every row so an operator can see which number answered. This also dissolved the "gate the horizon on whether this instance sweeps" problem rather than working around it. |
| 7 | `_resetMetricsForTest` leaves `provider` set | **Fixed.** Cumulative counts survived a reset that only cleared caches, so exact-value assertions were worker-ORDER dependent — a gate whose verdict depends on scheduling. It now drops the provider and calls `metricsApi.disable()`. |
| 8 | No-op instrument indistinguishable from no traffic | **Fixed.** `@opentelemetry/api` has no ProxyMeter, so an instrument bound before `createMetrics` is a permanent no-op. "Recorded at least once AND absent from the snapshot" identifies exactly that, reported `unknown` with the reason. |
| 9 | W2's bias stated only in prose | **Fixed** — `caveat: 'same_instance_runs_only'` travels on the row. |

**The SSE fix was adopted for a reason the review got wrong, and the correction
matters more than the fix.** It said my design "omits five real SSE routes". It
did not: I had already reused `rateLimit.ts`'s `SSE_STREAM_PATHS` (all seven) via
a template match. But pursuing the claim exposed a worse defect neither of us had
named — **`/v1/runs/:runId/events` serves BOTH an SSE stream and a JSON polling
mode on one path, separated only by `Accept`** (`routes/streams.ts`). A
route-template filter cannot tell them apart, so it silently dropped real, short,
latency-bearing polling requests out of A2/A3 along with the streams. The fix is
the review's: a bounded two-value `stream` label set in `httpMetrics` from the
rate limiter's own `isLongLivedSseStream(req)` predicate. One list, one answer, a
new stream route excluded from the SLO the moment it is exempted from the rate
budget — and the request-level predicate gets the shared-path case right where
no path-level one can.

**`docs/SLO.md` gained the honesty the response carries**: a machine-checked
not-projectable table whose id set AND reason text are held against
`SLO_CATALOG`, so a row silently becoming projectable goes red until both are
updated. Its dangling `A6` cross-reference — *"the rate limiter's own health is
A6 below"*, where no A4/A5/A6 has ever existed — is corrected in place, and the
parity test now reads in-doc cross-references, which a row-set bijection never
would have caught.

**`stale` is currently unreachable from the shipped catalog, and that is stated
rather than hidden.** No row declares a freshness horizon: zero-target rows must
not (silence is the objective being MET) and the dispatch rows no longer read a
gauge at all. Rather than leave the branch untested — the dead-code shape this
program keeps finding — `projectRows(catalog, input)` is exported so the suite
exercises it with a synthetic spec, while `projectSlos` stays closed over the
real catalog, and a test pins that nothing declares a horizon today.

### Sabotage table — round 2, every guard broken, every break red

| # | Sabotage | Result |
|---|---|---|
| S15 | temporality flipped to DELTA | 2 red |
| S16 | explicit cardinality ceiling removed | 1 red |
| S17 | overflow sentinel ignored — ratio computed over a folded series | 3 red |
| S18 | `shareAtOrBelow` guesses instead of refusing a non-boundary threshold | 1 red |
| S19 | `stream` label hardcoded `false` | 2 red |
| S20 | latency objectives stop excluding streams | 1 red |
| S21 | dispatch rows stop reading `dispatchOutboxStats()` | 4 red |
| S22 | a failed queue read reports 0 instead of `unknown` | 1 red |
| S23 | no-op instrument reads as `empty`, not `unknown` | 1 red |
| S24 | A2's threshold drifts 1.0s → 2.5s from the published target | 1 red |
| S25 | F1's decided percentile silently becomes p95 | 1 red |
| S26 | Q1 quietly becomes projectable while the doc still says it cannot | 3 red |
| S27 | the doc's not-projectable reason drifts from the code's | 1 red |
| S28 | a dangling objective cross-reference reintroduced in prose | 1 red |
| S29 | a runbook heading an alert links to is renamed | 1 red |
| S30 | profile-off renders `healthy` instead of `unknown` | 1 red |
| S31 | frontend `degraded` loses its own word | 1 red |
| S32 | frontend overflow ceiling no longer surfaced | 1 red |
| S33 | `requireSuperadmin` flipped from 403 to 404 | 4 red |

**A stale comment corrected while in the file, because it was a security
claim.** `features/operations/routes.ts` and `client/operationsClient.ts` both
said the superadmin reads answer a **"uniform 404"**. They do not, and never
have — `host/superadmin.ts` throws `OpenwopError('forbidden', …, 403)`. A
uniform 404 is a NON-DISCLOSURE property ("this surface does not exist for
you"); 403 deliberately does not have it. Nothing behaved on the false claim —
every consumer keys off `res.ok` or an explicit 403, and the pre-existing route
tests accept `[403, 404]`, which is how the drift survived — but a reader
hardening this surface would have believed a defence that was not there, and a
test written to the comment would have pinned behaviour the code does not have.
Corrected in place with a note rather than deleted (the drift predates this
phase), and turned into a test that asserts the PREDICATE's status and code
directly, so it covers every endpoint the gate protects rather than one route
that might 404 for an unrelated reason. This is the "doc comments are claims,
not code" lesson applied: the fix for a false comment is a test, not a better
comment.

> **S16 and S19 came back GREEN on the first run, with their diffs CONFIRMED
> applied — so unlike S3 in round 1, these were real holes in my guards rather
> than a script that never edited anything.** Both were assertions that could
> not distinguish "wired" from "safe":
>
> - S16: the ceiling test asserted "no overflow at 50 series", which passes
>   identically under the SDK's 2000 default. It proved the ceiling was SAFE and
>   nothing about whether the selector reached the reader. Replaced by lowering
>   the limit to 5, recording 20 distinct label sets, and asserting the overflow
>   sentinel APPEARS (and that the total is preserved — the SDK folds
>   attribution, not measurements). To make that testable at all,
>   `LOCAL_SCRAPE_CARDINALITY_LIMIT` became `localScrapeCardinalityLimit()`,
>   read at reader construction instead of frozen at module load.
> - S19: the route test asserted every HTTP sample carried
>   `stream === 'true' | 'false'` — green when the middleware hardcodes `false`,
>   i.e. when the label is present, well-formed and always wrong. Replaced by
>   `test/http-metrics-stream-label.test.ts`, which drives the real middleware
>   and asserts the label TRACKS the request in both directions, including the
>   SSE-vs-JSON-polling pair on the identical route template.
>
> The generalisation, now a program rule: **a sabotage step must assert its own
> diff before it asserts a test result** (round 1's S3), *and* a green sabotage
> whose diff DID apply is a finding about the guard, not a clean bill of health.
> Three of this phase's strongest tests exist only because a sabotage refused to
> go red.

### Verification (round 2)

| Artefact | Tests |
|---|---|
| `test/slo-projection.test.ts` | 35 |
| `test/slo-projection-doc-parity.test.ts` | 14 |
| `test/operations-slo-route.test.ts` | 14 |
| `test/operations-slo-route-profile-off.test.ts` | 6 |
| `test/metrics-local-scrape.test.ts` | 8 |
| `test/http-metrics-stream-label.test.ts` | 5 |
| `src/features/operations/__tests__/sloPanelStates.test.tsx` | 11 |

Backend `tsc --noEmit` exit 0; 16 backend suites / **179 tests** green including
the P1 metrics suites and both rate-limit suites; frontend `npm run build` exit 0
and eslint exit 0.

One P1 test moved, deliberately: `metrics-golden-telemetry.test.ts` pins the HTTP
attribute bag EXACTLY, so the new `stream` label made it red. That is the test
doing its job — it is the tripwire for an unbounded label being added to this
metric family — so its expectation was updated to `stream: false` and left exact
rather than relaxed to a partial match.
