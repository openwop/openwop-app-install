# ADR 0432 — `kicktodo-metrics`: PRD §15 outcome metrics as computed-on-read projections, plus sampled verifier review

Status: **implemented** (P1–P5, 2026-07-19; record below)

**Requirements source:** `docs/kicktodo-prd.md` §15 Metrics and experiments — activation (signup → first approved plan; median time to first completed action; intake abandonment by step), engagement/outcome (meaningful weekly progress = **north star**; D7/D30 active-enrollment retention; completion rate by planned difficulty; challenge completion/abandonment; recovery within 7 days of a snooze/miss; **verifier false-positive/false-negative rate from sampled human review**), and factory quality. Also §1 North-star outcome.
**Depends on:** ADR 0414 (enrollments, occurrences, check-ins — the raw material), ADR 0412 (goal verdicts — the verifier's decisions), ADR 0415 (candidate/publication state — factory quality), approvals (the sampling review lane), ADR 0425 (the variant-effectiveness precedent).
**Surface:** host-extension. **NO new RFC.**

## Why this exists

The PRD names a north-star metric and a full activation/engagement/quality set; **none of it is instrumented**. ADR 0425 P3 shipped one slice (completion counts by toggle variant). Everything else — including the north star itself — is currently unmeasurable, which means the product's own success criteria cannot be evaluated after launch.

The danger in building this is well-documented in this repo: a metrics feature is the classic excuse to stand up a **parallel read model** — a second event stream, a second copy of enrollment state, a dashboard that drifts from the owning services. That is explicitly the anti-pattern here (and the reason this is an ADR, not a ticket).

## Boundaries audit (verified against live code)

- **`analytics` is NOT this owner.** `features/analytics/` models *marketing* events — UTM, click ids, conversions, experiment events, session→contact identity links, org-scoped routes (`/analytics/orgs/:orgId`). Its subject model (anonymous session → contact) and this one's (an enrolled participant subject) do not overlap. Folding product-outcome metrics into it would corrupt both. **Separate owner, explicitly.**
- **`usage-analytics` is NOT this owner either** — it rolls up *AI token/cost usage* (`usageRollupService.ts`). Different fact entirely.
- **`insights-suite` / `evals`** — insights are cross-feature narrative surfaces; `evals` grades model outputs. Neither models participant outcomes.
- **No route collision:** `grep "kicktodo/metrics"` → 0 registrants.
- **Sampling reuses the approvals owner** — a verifier-audit sample is a human review task, and `approvalService` already owns review queues with typed kinds (the ADR 0426 `community-review` precedent). **No new review inbox.**
- **The raw material already exists and is tenant-keyed**: `ChallengeEnrollment` (createdAt, state, timezone), occurrences (planRevision, supersededByRevision), check-ins (createdAt, measuredValue), goal verdicts (ADR 0412 `lastVerdict`), and candidate/publication rows. Nothing new needs recording for the core set.

## Decision

**Metrics are COMPUTED-ON-READ projections over the owning services — never a second store of the same facts.** The ADR 0428 `orgReport` precedent, applied at tenant scope: no materialized rollup, nothing at rest to drift or leak, no reconciliation job.

New package `src/features/kicktodo-metrics/` (read-only, admin-scoped):

```text
GET /kicktodo/metrics/activation    → { signupToFirstPlanP50, timeToFirstCompletedActionP50, intakeAbandonmentByStep }
GET /kicktodo/metrics/engagement    → { weeklyMeaningfulProgress /* north star */, retentionD7, retentionD30,
                                        completionRateByDifficulty, completionRate, abandonmentRate, recoveryRate7d }
GET /kicktodo/metrics/factory       → { candidatesByState, publishRate, killSwitchActivations, timeToPublishP50 }
POST /kicktodo/metrics/verifier-sample  → mints ONE `metrics-verifier-sample` approval (a human grades a sampled verdict)
GET  /kicktodo/metrics/verifier-quality → { sampled, agreed, falsePositives, falseNegatives }  // counts only
```

- **Counts and percentiles only.** No participant row, no note, no measured value ever crosses this boundary — the same closed-projection discipline as ADR 0419/0428. A cell computed from fewer than **5** participants is **withheld** (`below-k-floor`), never rounded down to a small number.
- **Verifier FP/FN needs humans, so it samples.** A deterministic sample of goal verdicts becomes `metrics-verifier-sample` approvals; a reviewer marks agree/disagree; the rate is derived from the *resolved* samples only, and the endpoint states the sample size (an unstated denominator is a lie).
- **Definitions live in code as named predicates**, one per metric, each with a doc comment stating the exact PRD line it implements — so "meaningful weekly progress" has ONE definition the dashboard, the tests, and the PRD agree on. Ambiguous-by-nature metrics get their assumption recorded in the open questions, not silently chosen.

### The honest scale caveat (stated, not hidden)

Computed-on-read means each call does bounded `listByPrefix` reads per tenant. That is fine at KickTodo's Wave-1/2 scale and consistent with the repo's "avoid `DurableCollection.list()` cross-tenant scans" rule (these are tenant-prefixed, not cross-tenant). It is **not** free: the falsifiable trigger for materializing a nightly rollup is **a tenant exceeding ~5k enrollments or a p95 over 2s on these routes** — recorded here so the revisit is evidence-driven rather than speculative, exactly the ADR 0428 pattern.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Package + activation + engagement projections (each metric a named predicate citing its PRD line), k≥5 withholding, admin RBAC, tenant-isolation tests; a pinned test per metric definition so a redefinition is a failing test, not a silent drift. |
| **P2** | Factory-quality projections over candidate/publication state (ADR 0415 owner reads only). |
| **P3** | Verifier sampling: the `metrics-verifier-sample` approval kind + deterministic sampling + resolved-only rate derivation with an explicit denominator. |
| **P4** | Frontend: a metrics page (tables + accessible charts with table alternatives per §14 a11y), withheld cells labeled, denominators shown; i18n ×4; manual-test rows. |
| **P5** | `ctx.features.kicktodo-metrics` read ops + node (pack bump + pin lockstep); LLM-EXCHANGE row — KickBot/insights may READ metrics; nothing here is model-writable. |

## Feature matrix

1. Package: NEW `src/features/kicktodo-metrics/` ✔. 2. Toggle `kicktodo-metrics`, **OFF**, `bucketUnit: tenant`, dependsOn `kicktodo-core`. 3. `ctx` surface: P5 reads. 4. Node pack: extends `feature.kicktodo.nodes`. 5. Envelopes: none. 6. Agent pack: none new. 7. Public surface: none — outcome metrics are never public. 8. RBAC: tenant-admin read (`host:org:manage`-class, the ADR 0428 gate pattern); no participant-level read path exists by construction. 9. Replay/fork: no run coupling; projections are pure functions of durable state. 10. Frontend: an admin metrics page; no new nav group (KickTodo group).

## Implementation record

| Phase | Landed |
|---|---|
| P1 — activation + engagement projections, each a NAMED predicate reading through OWNER-exported functions (a new `listEnrollmentsInTenant` on the enrollment owner — never a second handle on its keyspace). Every cell is a `FlooredCell`: below **K_FLOOR = 5** contributors the VALUE is `null` with `withheldReason: 'below-k-floor'` — never a small number. Test-pinned, including "no participant identity ever appears in a payload" | kicktodo/0432-metrics |
| P2 — factory-quality projections over candidate/publication state (`listCandidates`, the ADR 0415 owner) | kicktodo/0432-metrics |
| P3 — verifier FP/FN by SAMPLED human review: a `metrics-verifier-sample` approval kind on the EXISTING approvals owner (the ADR 0426 precedent), deterministic sample ids (resampling converges — test-pinned), and a rate derived from **resolved samples only** that always reports its denominator and returns `null` rather than a rate over zero | kicktodo/0432-metrics |
| P5 — `ctx.features.kicktodo-metrics` (activation/engagement/factory/verifierQuality, read-only) + the `outcome-metrics` node; pack **v1.13.0** pin-lockstepped across all six sibling kicktodo features | kicktodo/0432-metrics |
| P4 — the metrics page at `/kicktodo/metrics` (toggle-gated). **The deferral is withdrawn**: it rested on §14's "accessible charts with table alternatives" needing a design pass, but the app ships **no charting primitive at all** (`ui/` has `DataTable` and nothing else), so for these numbers a CAPTIONED TABLE *is* the accessible representation rather than a lesser fallback. Three captioned `DataTable`s (responsive `stack`), a withheld cell rendered as a labeled chip stating WHY (never blank, never a small number), every rate showing its contributor count so no percentage carries an implied denominator, and a verifier panel that reports `resolved / sampled` and renders NO rate at all until something is graded. ONE batched load (4 reads in a single `Promise.all`). i18n ×4 | kicktodo/c-metrics-page |

**The north star's operational definition** (ADR open question 1, now decided in code): *an ACTIVE enrollment with ≥1 completed action in the trailing 7 days.* It lives as one named predicate with the PRD line in its doc comment, so redefining it is a failing test rather than silent drift.

**Open question 2 resolved honestly:** intake-abandonment-by-step needs a `lastIntakeStep` stamp the enrollment saga does not carry. Rather than guess a number, the metric is **not shipped** — no fabricated cell.

**Scale, restated as shipped:** one tenant-prefix enrollment scan plus one per-enrollment check-in prefix scan. The falsifiable materialization trigger stands: a tenant over ~5k enrollments or a p95 over 2s on these routes.

## Alternatives weighed

- **Extend `analytics`** — rejected (audit): a marketing-event store with a session/contact subject model and org-scoped routes. Two different facts, two different subjects; merging them would make both unreliable.
- **A materialized nightly rollup** — rejected *for now*, with a falsifiable trigger (above). Materialization adds a reconciliation surface and something at rest to leak; computed-on-read has neither. Revisit on evidence.
- **Emit new analytics events from the daily loop** — rejected: it duplicates facts the owning stores already hold, and a divergence between the event stream and the store would be undetectable. Project from the source of truth.
- **Skip verifier FP/FN as "not measurable"** — rejected: it is the one metric that tells us whether the *automated judge* is trustworthy. Sampling with an honest denominator beats not knowing.

## Open questions

1. **"Meaningful weekly progress" needs one operational definition.** Recommend: *a participant with ≥1 completed required action in the trailing 7 days, on an active enrollment* — simple, gameable only by doing the thing, and computable from existing state. Recorded as an assumption for the product owner to confirm; the named predicate makes changing it a one-line, test-pinned edit.
2. **Intake abandonment by step** needs step boundaries the enrollment saga does not currently stamp — the only metric in the set requiring a new durable field (a `lastIntakeStep` on the pending enrollment). Flagged: P1 either stamps it or ships the metric as `unavailable` rather than guessing.
3. Sampling rate for verifier review: recommend 5% of verdicts, floor 20/month, so small tenants still get a signal.

## RFC verdict

**Host work, no new RFC.** Pure projections over host-private state plus an existing approval kind; nothing advertised on the wire.
