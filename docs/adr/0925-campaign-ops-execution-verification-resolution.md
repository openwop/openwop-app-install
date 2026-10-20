# ADR 0925 — Campaign ops: change-set execution, read-back verification and the resolution queue

Status: Accepted — P0 implemented (change-set PR); P1/P2 pending

Program: agency campaign operations (ADRs 0921–0928). PRD features **F7**
(execution), **F9** (read-back verification and completion record), **F10**
(resolution queue), and the audit-trail half of **F18**. Depends on ADRs
0921–0924.

## Context

Execution applies only changes that are authorized and still current, one
destination at a time, with a status per destination. The job is persisted
before anything is written. Each write is idempotent. A write that times out may
have succeeded, so the job must reconcile against the destination before
retrying. No atomic rollback across tools is promised.

Completion is decided from the resulting state, not from a successful call: each
destination is re-read and compared with the approved target. Every step ends
**confirmed**, **conflicted** or **incomplete**, with what was observed stored.
Nothing unresolved disappears from the operator's view.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **No post-write read-back exists anywhere.** Searched `read-back|readback|
  read back` and `reconcil` across `src`; the only write-then-read checks are a
  boot probe (`host/blob/blobBootCheck.ts:24`) and a conformance probe
  (`bootstrap/conformanceMemoryProbe.ts:201-212`). Ads delivery read-back is
  ADR 0571, Proposed and not started
  (`docs/adr/0571-ads-readonly-delivery-sync.md:79`). **This is net-new.**
- **Persist-before-act + `unknown` precedent: the UCP buyer.** It CAS-moves to
  `placing` before the call (`features/commerce/ucpBuyer/ucpBuyerService.ts:
  506-513`), keys the call `ucp-buy:${purchaseId}` (`:529`), sets `unknown` (not
  `failed`) on an ambiguous failure or timeout (`:72-75, 550-575`), and blocks a
  retry until reconciled through `trackPurchase` (`:434, 650`). **Copied as the
  step state machine's shape.**
- **The email ledger releases on timeout** (`host/emailAdapter.ts:346`), which
  makes an ambiguous outcome retryable. Campaign ops must not inherit that rule
  for its own steps; it does not use `ctx.email` (it never sends).
- **Engine idempotency:** `executor/invocationLog.ts:1-40` keys on the logical
  effect identity; `host/providerIdempotencyKey.ts:40-64` derives a stable key
  inside a run. Side-effect role nodes are not re-executed on a `:fork`
  (the ADR 0627 lesson: action-role write nodes re-executed and duplicated rows).
- **Audit seams:** the tamper-evident chain `appendAudit(tenantId, kind,
  payload)` (`host/auditChainService.ts:188-261`), already written by
  `resolveApproval` (`host/approvalService.ts:2583-2600`); the plain
  `Storage.appendAudit` with a `resource` filter (`storage/storage.ts:795-815`),
  used by CMS (`features/cms/cmsService.ts:1933-1950`).
- **Scheduled work:** the existing scheduler seam (recurring jobs per tenant)
  drives drift checks; no campaign-ops scheduler is added.

## Decision

### D1 — `Job` and `Step`, persisted before any write

```ts
interface Job {
  tenantId: string; orgId: string; jobId: string;        // 'cjob:<uuid>'
  changeSetId: string; approvedChangeSetHash: string;    // from the resolved approval row
  approvalId: string; runId: string;
  status: 'running' | 'finished' | 'needs_attention';
  outcome?: { confirmed: number; conflicted: number; incomplete: number; total: number };
  createdAt: string; finishedAt?: string;
}
interface Step {
  jobId: string; assetId: string; seq: number;
  state: 'pending' | 'checking' | 'writing' | 'written' | 'unknown'
       | 'confirmed' | 'conflicted' | 'incomplete';
  reason?: StepReason;          // D6
  attempt: number;
  idempotencyKey: string;       // `cops:${changeSetId}:${assetId}:${changeSetHash}`
  observed?: { version: number; contentHash: string; fields: Record<string,string>; at: string };
  resolution?: Resolution;      // D5
  updatedAt: string;
}
```

Stores `campaign-ops:job` (`tenant::orgId::jobId`) and `campaign-ops:step`
(`tenant::orgId::jobId::assetId`). The job and all its steps are written
`pending` **before** the first destination is touched. Every state change is a
CAS on the step row.

### D2 — Per-step algorithm (one destination at a time, in `seq` order)

For each step:

1. **check** (`pending → checking`): re-read the asset through its adapter.
   - Wrong client, client archived or asset gone → `incomplete`
     (`wrong_client` / `client_inactive` / `asset_gone`). Nothing is written.
   - Observed `contentHash == targetContentHash` → `confirmed` without writing
     (already applied, e.g. a re-run after a crash).
   - Observed `version`/`contentHash` ≠ the change set's `sourceVersion` /
     `sourceContentHash` → `conflicted` (`newer_human_edit`). Nothing is written.
     The change set is marked `stale` for this asset (D5).
   - Client in `preview` → `incomplete` (`preview_only`).
2. **write** (`checking → writing`, CAS first, then the call): adapter `write`
   with `expectedVersion = sourceVersion` and the step's idempotency key.
   - `written` → go to 3.
   - `version_conflict` → `conflicted` (`newer_human_edit`, the race lost
     between check and write; the CAS guard is what makes this safe).
   - `refused` → `incomplete` with the adapter's reason (e.g.
     `email_already_sent`, `access_revoked`, `destination_unavailable`).
   - **timeout / transport error / any ambiguous result → `unknown`.** Never
     `failed`, never retried blind.
3. **verify** (`written → confirmed|conflicted`): re-read through the adapter.
   - Observed `contentHash == targetContentHash` → `confirmed`; store `observed`.
   - Otherwise → `conflicted` (`readback_mismatch`), store `observed`.
   - The step is `confirmed` **only** from this read (or the check in 1), never
     from the write's return value.

**Reconcile `unknown`** (automatic once, then by the operator): re-read the asset.
- hash = target → `confirmed` (the write had landed).
- hash = source and version = source → safe to retry the write once (same
  idempotency key), then verify.
- anything else → `conflicted` (`ambiguous_write_then_changed`).

A step stuck `unknown` after one automatic reconcile stays `unknown`, and the
job is `needs_attention`. **No false "done":** a job is `finished` with all steps
`confirmed` only; any other mix is `needs_attention` with the per-state counts.

### D3 — No cross-destination rollback

One destination failing does not undo the others. The job reports, for example,
"1 of 2 confirmed; email draft incomplete: already sent". A **restore** is a new
change set (ADR 0923) whose edits set fields back to the change set's recorded
`before` values, built against the asset's **current** version, so it goes
through review and the stale checks like any change and cannot clobber a human
edit made after the original write.

### D4 — Drift detection

After a job finishes, a scheduled check (daily, and on demand from the inbox)
re-reads each confirmed step's asset. A `contentHash` that no longer equals the
target records an `Observation {kind:'drift', observed, at}` and surfaces the
step in the resolution queue as `drifted`. Drift never changes the original
step's `confirmed` record (it was true when verified); it adds a new fact.

### D5 — Resolution queue (F10)

Every step that is not `confirmed`, and every drift observation, is an open
item until resolved. Each has exactly one recommended next action:

| State / reason | Next action |
|---|---|
| `conflicted` `newer_human_edit` | **Re-review:** regenerate the change set from the current asset (ADR 0923) and send it for approval |
| `unknown` | **Reconcile:** re-read, then retry once if the destination is unchanged |
| `incomplete` `access_revoked` / `destination_unavailable` | **Fix access, then retry** |
| `incomplete` `email_already_sent` | **Mark handled manually** (a sent email is never changed) |
| `conflicted` `readback_mismatch` / `drifted` | **Re-review** or **mark handled manually** |

`Resolution {action, by, at, note?}` is recorded on the step; "mark handled
manually" requires a note. **A newer human edit always brings the work back for
review:** the step is `conflicted`, and the change set is `stale` for that asset.
Items leave the queue only by a recorded resolution, never by age.

### D6 — `StepReason` is a closed set

`newer_human_edit · readback_mismatch · ambiguous_write_then_changed ·
wrong_client · client_inactive · asset_gone · preview_only · access_revoked ·
destination_unavailable · email_already_sent`.
Each has operator copy in the four locales. A new reason is an ADR change.

### D7 — Audit trail (F18)

Every proposal, approval, attempt and observation appends to the tamper-evident
chain with `kind` = `campaign-ops.proposal | .approval | .step.attempt |
.step.observation | .resolution | .duplicate-override`, payload ids-only plus the
hashes and reason codes (no asset content, no PII). Approval decisions are
already chained by `resolveApproval`; campaign ops adds the rest. The job page
shows the chain entries for that job.

## As built — P0 corrections (2026-10-19)

1. **One `execute` node, not an apply/verify pair per destination.** A chain's
   DAG is static and a change set has a variable number of destinations, so the
   chain `campaign-ops.execute` has one side-effect node that runs the persisted
   job: steps in order, each check → write → verify with CAS state changes, and
   the one automatic reconcile. A resumed or forked run converges because every
   step checks the destination before writing (already at target ⇒ confirmed).
2. **The job lives in one row** with its steps embedded (D1 sketched a row per
   step); every step change is a CAS on that row.
3. **Two reasons were added to D6's closed set**, both surfaced by the CMS
   adapter: `not_authorized` (the approver lacks the destination's own authority)
   and `publish_blocked` (the CMS refused the content, e.g. a `[TODO …]` marker
   on a live page).
4. **The read-back compares the editable-fields hash** (ADR 0923 as-built 3);
   the source check compares the whole-page version and hash.
5. **The run is bound to its approval**: the execute surface refuses any run
   whose stamp does not name that approval and its change-set hash.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `features/campaign-ops/execution/` (job service, step machine, reconcile, drift, resolution). |
| 2 | Toggle | `campaign-ops`. |
| 3 | Workflow surface | `ctx.features.campaignOps.startJob` (service-only, from the approval handler), `applyStep`, `verifyStep`, `reconcileStep`, `getJob`. All take `orgId` and check the run stamp's `changeSetHash` equals the job's. |
| 4 | Node pack | `feature.campaign-ops.nodes`: `apply-step` and `reconcile-step` are `role:"side-effect"` keyed on the step's idempotency key (a `:fork` does not re-write); `verify-step` and `drift-check` are pure reads. Chain `campaign-ops.execute` (for each step in order: apply → verify) and `campaign-ops.drift-check` in the campaign-ops chain pack. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. Execution has no model in it. |
| 7 | Public surface | None. |
| 8 | RBAC | Jobs start only from an approval resolution. Reconcile/retry/resolve need `workspace:write` on the client org; reading jobs needs `workspace:read` there. |
| 9 | Replay / fork | Side-effect nodes + idempotency keys; check-before-write makes a re-run converge (`confirmed` without writing when the target is already present). |
| 10 | Frontend | Job detail (per-destination state, observed vs target, chain entries) and the resolution queue, in the campaign-ops page (ADR 0926). |

## RFC verdict

**Host extension, no RFC.** Jobs and steps are host state; the chains are
ordinary RFC 0013 chain packs; nothing new on the wire.

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | Job/Step stores persisted before writes; check → write → verify with `expectedVersion`; `unknown` + one automatic reconcile; `finished` only when all confirmed; chain `campaign-ops.execute`; audit entries | **Yes** (partial-failure case: CMS confirmed, email `email_already_sent`) |
| P1 | Resolution queue actions (re-review, reconcile/retry, mark handled manually) | Partly (the demo shows the queue item; acting on it is P1) |
| P2 | Drift check (scheduled + on demand); restore-as-new-change-set | No |

## Alternatives weighed

- **Trust the write response.** Rejected: the thesis is completion from the
  resulting state.
- **Atomic multi-destination commit (prepare/commit).** Rejected: no destination
  supports a two-phase protocol; promising it would be a false claim.
- **Retry on timeout.** Rejected: a timed-out write may have landed; the UCP
  `unknown` + reconcile shape is the honest one.

## PRD-vs-architecture corrections

1. F7 "persist the job before acting" and "reconcile after timeout" follow the
   UCP buyer's `unknown` state, not the email ledger's release-on-timeout rule.
2. F9 "detect drift when a destination changes after completion" adds a new
   observation and never rewrites the original verified record.
3. F7 "restoring an earlier version must take intervening human edits into
   account" is a restore *change set* built against the current version, not a
   destination-level revert.

## Open questions

- [ ] **Q1** The in-app CMS and email adapters are in-process, so a real timeout
      is rare. The scenario pack (ADR 0927) injects it with a fault-wrapping
      adapter. Is that enough evidence for the demo, or should P0 also run one
      case over HTTP? Proposed: the fault wrapper for the demo; HTTP with the
      first external adapter.
- [ ] **Q2** Drift check frequency: daily proposed. Per client?
- [ ] No `/architect` pass has been run on this ADR.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | campaign-ops change-set PR (follows #5015) | `test/campaign-ops-approval-execution.test.ts` |
