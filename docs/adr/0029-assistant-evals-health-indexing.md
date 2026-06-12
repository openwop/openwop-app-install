# ADR 0029 — Assistant evals, operational health & indexed persistence

**Status:** Accepted — **implemented + tested** (`assistant-evals-health.test.ts`, ADR 0023 §12 T8; commitments indexes landed with T2): extraction precision/recall eval (RFC 0081 scorecard shape), priority-profile eval, the health snapshot (`health.ts` + superadmin `GET /assistant/health` + admin card; connector counts deliberately omitted — cross-feature import, the Connections page owns them), and the approvals `(tenant,status)` index (the heartbeat hot path). **Deferred, honestly:** connections-by-provider + scheduler-job indexes (small per-tenant cardinality today), the 1e4-scale load tests (CI-flaky; revisit with a perf lane), the retention sweep (config stored, ADR 0028), and the draft-quality eval (deploy-gated with the LLM drafter).
**Date:** 2026-06-11
**Depends on:** ADR 0023 (the graph + loops being measured), ADR 0024
(connector failures being surfaced), ADR 0028 (the admin surface it joins).
**Rides (Accepted, no new RFC):** RFC 0081 (agent evaluation & scorecards),
RFC 0084 (budget/cost), `observability.md` (canonical `openwop.*` namespace +
host-extension rule for vendor metrics), RFC 0052 (the loops whose latency is
tracked).
**Surface:** `/v1/host/sample/assistant/health` (admin/debug) — host-extension,
**NON-NORMATIVE — no RFC**.

> **One-line thesis.** The assistant graduates from demo to product only when
> its quality is *measured* (evals) and its hot paths stop being cross-tenant
> scans (indexes). Both are host-internal; the eval shape rides RFC 0081
> scorecards rather than inventing a parallel harness.

---

## Part 1 — Evals & health

### Eval fixtures (vitest, offline, deterministic)

| Suite | Fixture → expected | Measures |
|---|---|---|
| Commitment extraction | email/doc/transcript corpora → labeled commitments (owner, due, description) | precision/recall, false positives, missed commitments |
| Meeting decisions | transcript → labeled `Decision`s | extraction quality |
| Priority scoring | graph snapshots → expected surface/handle/defer buckets per profile (`conservative`/`balanced`/`aggressive`) | prioritization stability across profile variants |
| Draft quality | inbound + persona → rubric-scored draft (structure-level assertions: addresses the ask, no invented facts, taint rules honored) | drafting regressions |

Fixtures live with the existing test corpus; hostile-content fixtures are ADR
0027's and are shared, not duplicated. Scores serialize as **RFC 0081 scorecard
shapes**, so a future cross-host eval surface needs no re-modeling.

### Operating metrics (counters on existing seams, no new pipeline)

Product: approval rate, edit-before-approve rate, rejection rate, stale-item
count (open past due), citation coverage (% surfaced items with resolvable
`SourceRef`s). Operational: connector failures + `needs-reconsent` count (ADR
0024), token-refresh failures, loop latency + last-run outcome per RFC 0052 job,
run-budget spend (`emitCost`/RFC 0084). Host-specific metric names stay under
the host vendor namespace per `observability.md`/`host-extensions.md`; nothing
new claims `openwop.*`.

### `GET /v1/host/sample/assistant/health` (admin-gated)

One batched read (per-IP rate-limit discipline) returning the metric snapshot +
per-loop status; rendered as an "Assistant health" panel on the admin surface
(joins ADR 0028's governance page).

## Part 2 — Indexed persistence

`DurableCollection.list()` is a full cross-tenant scan filtered in-service —
acknowledged sample-grade (`hostExtPersistence.ts` header). Connected ingestion
(T2) is the high-cardinality writer that breaks this, so:

1. **Primitive.** `hostExtPersistence` gains a deterministic secondary-index
   primitive: an index collection per `(entity, dimension)` whose keys are
   `${tenantId}:${dimensionValue}:${entityId}` → entityId, maintained
   write-through in the owning service (no query planner, no magic — point
   `listByPrefix` lookups). Backfill = one sweep job; additive, no rekeying of
   primary rows; `reassignTenant` extends to index rows.
2. **Hot paths, in order:** commitments by `(tenantId, status)` + `(tenantId,
   sourceHash)` (**lands with T2** — the ingestion dedup + board-projection
   path); connections by `(tenantId, provider)` (resolver); pending
   approvals/actions by `(tenantId, status)` (the inbox + heartbeat
   `hasPendingApprovalForCard` scan); scheduler jobs by `(tenantId)`.
3. **Load tests** around ingestion fan-in and the briefing read at
   1e4-commitment scale; assert no full-collection scan on those paths (count
   via a test-seam scan counter).

## Boundaries audit

| Concept | Single owner |
|---|---|
| Eval scorecard shape | **RFC 0081** — reuse |
| Cost attribution | **`runBudgetService` / `emitCost`** — reuse |
| Loop status | **`schedulingService`** job rows — reuse (T2 exposes) |
| Index primitive | **`hostExtPersistence`** — extended in place (no parallel store) |
| Eval fixtures + health view | **NEW — this ADR** |

## RFC gate

**Host work — no new RFC.** Evals are host tests + an admin view; metrics stay
in the vendor namespace; the index is storage-internal. Tripwire: publishing
scorecards cross-host = RFC 0081 surface, already Accepted — only honest
advertisement would be needed if ever exposed.

## Open questions

1. **(Medium) LLM-judged draft quality** — rubric LLM evals are
   non-deterministic; v1 keeps structure-level assertions offline and treats
   LLM judging as a manual/CI-optional lane.
2. **(Low) Index GC** — tombstoned entities leave index rows; the retention
   sweep (ADR 0028) owns cleanup.
