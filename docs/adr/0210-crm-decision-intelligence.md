# ADR 0210 — CRM decision intelligence: stage history, pipeline snapshots, reports, dashboard, CSV export

Status: implemented (stage history + snapshot daemon + report endpoint + Reports tab + CSV export — CRM gap analysis §5 C5/C6/C7-export)
Date: 2026-07-03
Depends on: ADR 0008 (amended), ADR 0208 (events/audit), the sweep-daemon pattern (retentionSweepDaemon / knowledge-sync precedents).

## Context

Gap analysis E3/E8: stage `probability` is stored and never read; stage moves overwrite
in place so conversion/velocity analytics are impossible for past data; there is no
CRM-specific reporting surface and no export. Two survey facts shape the design:
scheduler jobs are per-subject (no all-tenants job — feature-level cadence uses the
sweep-daemon + injected-enumerator + `claimIdempotency` pattern), and the app's
visualization idiom is plain token-styled CSS meters/segmented bars + `KeyFigureBand`
(no chart dependency exists and none is added).

## Decision

### 1. Stage history (append-only; ship early — history can't be backfilled)

`DurableCollection('crm:stagehistory')` rows
`{ historyId, tenantId, orgId, dealId, pipelineId, fromStageId, toStageId, actor, at,
amountAtMove? }` appended inside `updateDeal` whenever `stageId` changes (creation
appends an initial `fromStageId: null` row). Read via
`GET /crm/orgs/:orgId/deals/:dealId/stage-history` (read scope).

### 2. Weekly pipeline snapshots — sweep daemon

`features/crm/snapshotDaemon.ts` (`processDueCrmSnapshots(deps, listCrmTenants, now)`):
per (tenant, org, ISO-week slot) takes
`claimIdempotency('crm-snapshot:<tenant>:<org>:<week>')`, computes per-pipeline
`{ perStage: { count, sum, weightedSum } }` (weightedSum = Σ amount × stage.probability/100)
and stores `DurableCollection('crm:snapshot')` rows. The tenant enumerator is derived
from the CRM's own org-pipeline rows (injected at boot — no global tenant listing
exists by design). Boot-gated behind `OPENWOP_CRM_SNAPSHOT_ENABLED` (default off),
hourly poll, `.unref()`, re-entrancy guard — the exact retention/knowledge-sync shape.
Explicitly NOT a scheduler job (per-subject only) and NOT a chain (no all-tenant
enumeration primitive); this composes the existing daemon idiom, not a new scheduler.

### 3. The ONE report endpoint

`GET /crm/orgs/:orgId/reports/pipeline?pipelineId=` (read scope) returns in one fetch
(rate-limit-friendly — no dashboard fan-out):
`{ funnel: contacts-by-stage (tenant rolodex), perStage: {stageId, name, probability,
count, sum, weightedSum}[], openCount/wonCount/lostCount + winRate (from status),
aging: open deals with no activity in 14/30 days (joins activities), snapshots:
last 12 weekly rows, conversions: from→to counts (from stage history) }`.

### 4. Dashboard tab (C6)

A fifth `/crm` tab ("Reports") reading §3 once: `KeyFigureBand` (open/won/lost/win-rate),
a segmented per-stage bar (`mt-meter__seg` idiom, token-colored, labels + counts — never
color-alone), weighted-pipeline table, funnel bars, aging list linking to deal pages,
and a snapshot trend as width-percent bars. Feature-local `crm-*` CSS classes; no
chart library (bundle budget is at 177.8/178 kB gzip).

### 5. CSV export (C7-export)

`GET /crm/orgs/:orgId/export?entityType=companies|deals|tasks|activities` and tenant
`GET /crm/export?entityType=contacts` — buffered `text/csv; charset=utf-8` with
`Content-Disposition: attachment` (the app has no streaming precedent; buffered at the
5k-per-org cap is bounded). Columns = base fields + custom-field keys union. RFC 4180
quoting via a local `csvEscape` (no helper exists to reuse; formula-injection guard:
leading `=+-@` prefixed with `'`). Read scopes; excluded from tombstoned rows; audited
as `crm.export` (ADR 0208 §3).

## Alternatives rejected

- **Recharts/chart lib** — blows the bundle budget for four bar groups; the CSS idiom
  is the house style.
- **Snapshot-on-read (no daemon)** — trend data must exist even when nobody loads the
  dashboard; a weekly durable row is the point.
- **Streaming CSV** — no precedent, no need at current caps.

## Open questions

- [ ] Snapshot retention (cap per org?) — start with 104 rows/org cap, prune oldest.
- [ ] Per-pipeline vs per-org snapshot granularity — per (org, pipeline) rows chosen.

## Correction: stage-history order follows the landed deal CAS (2026-10-08)

The original `at`-only newest-first sort cannot order two real moves within one
millisecond; append completion is also not authoritative when callers overlap.
The combined gate on `9e4c88afa` exposed this in `crm-lifecycle`; the older
`crm-deal-cas` witness already noted equal-ms ties and checked its chain without
asserting ordering. Neither sleeping between updates nor inventing later wall
timestamps repairs the data contract.

Write-forward rows carry optional `sequence`. A newly created deal reserves 1;
each stage/pipeline transition increments `Deal.stageHistorySequence` in the
SAME byte-identical `ext.deal` CAS that lands the transition (ADR 0627 D6). The
won attempt appends that reserved value; a loser re-reads the winning counter,
even when the winner's history append is delayed. Metadata and same-stage
updates do not reserve ranks. Actual `at`/`updatedAt` timestamps are unchanged.
The internal counter is omitted from business changed-field event lists.

Legacy deals missing the counter seed the first new reservation from their
history count / maximum existing sequence; no old row is rewritten. Reads put
sequenced rows newest-first by rank, ahead of write-before-upgrade rows. Legacy
rows retain timestamp sorting with a deterministic history-id tie fallback:
historical equal-ms commit order cannot be recovered honestly. The optional
fields round-trip through the existing kernel JSON; no migration or wire claim
is added. Mixed old/new writers cannot promise authoritative sequence order:
old binaries do not increment the new counter, so complete the code rollout.

The existing CAS→history append cross-record crash gap remains: a landed deal
whose append fails may have a missing row/rank. This repair orders the rows that
exist and does not claim an atomic outbox or fabricate missing transitions.
Focused verification passed on macOS (5 files / 34 tests) and Linux (4 files /
23 tests), including fixed-Date sequential and concurrent moves, clock rollback,
a delayed first append followed by a later landed move, legacy rows and tenant/org
refusal (`crm-stage-history-order.test.ts`), plus unchanged lifecycle/CAS/kernel
tests. Backend typecheck passed. The full canonical gate remains required before
merge; focused checks do not replace it.
