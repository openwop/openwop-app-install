# ADR 0567 — CRM activity-based-selling loop: per-deal next task, rotting markers, stage totals

Status: Proposed
Date: 2026-08-14
Feature: crm (extends ADR 0008 + the console R2 pass — no new toggle)
Origin: UX_UPGRADE-crm-console R2 deferrals CRM-R2-3/4/10, named there as
"the headline candidate for a follow-on ADR" (Pipedrive's activity-based
selling is the market anchor; full citations in the R2 market report).

## Context

The R2 console pass closed the deal↔task LINK (CRM-R2-1: `Task.dealId`
picker + tasks on DealDetail, shipped #3097-era). What remains is the LOOP
that link exists for — Pipedrive's core discipline: every open deal should
carry a NEXT activity; a deal without one is explicitly flagged; a deal
whose next activity is overdue is "rotting". The R2 matrix scored this the
largest capability delta against the leader set.

## Boundaries audit

- **Data**: `Task.dealId` + `Task.dueAt` + `Task.status` already exist —
  the rollup is DERIVABLE; no new entity. `Deal.stageId`/board exist for
  stage totals; `PerStageReport.sums` (CC-SP-3) is the currency-safe
  precedent every new total must follow.
- **Single owner**: the deals board + DealDetail render deal state
  (`features/crm/`); the reports lane owns aggregates. A next-task rollup
  is a PROJECTION over tasks — computed server-side beside the existing
  report grouping (one query shape), never client-side N+1 per row
  (the rate-limit fan-out rule).
- **Aging precedent**: `PipelineReport.aging` (daysSinceActivity) already
  ships — "rotting" composes it with the next-task rollup rather than
  minting a parallel staleness concept. One staleness vocabulary.
- **No wire**: host-extension routes only.

## Decision (proposed)

1. **Per-deal next-task rollup** (server): the deals list/board and
   DealDetail responses gain `nextTask?: { taskId, title, dueAt } | null` —
   the earliest OPEN task linked to the deal. `null` is a first-class
   answer ("no next activity"), never omitted-when-unknown (absence-is-a-
   claim discipline).
2. **Board markers**: each deal card shows its next activity (date-relative,
   the console's localized relativeLabel) or the explicit no-next-activity
   marker; overdue next task = the rotting marker (composes `aging` — same
   day counts, one vocabulary). Color is never the only signal (a11y).
3. **Stage totals**: the board's stage headers render count + currency-
   grouped sums via the EXISTING `PerStageReport.sums` shape (never a blind
   sum — the CC-SP-3 invariant, structurally).
4. **The loop affordance**: closing a deal's last open task from DealDetail
   offers "schedule the next activity" inline (the Pipedrive follow-through)
   — an offer, not a modal gate.

## Alternatives weighed

- **Client-side rollup** (tasks already load in the console) — rejected:
  N+1 fan-out on the board against the per-IP read budget; and the tasks
  tab's window may not hold every deal's tasks.
- **A new "activity" entity separate from tasks** (Pipedrive's model) —
  rejected: `Task` + `dealId` already models it; a second entity forks the
  owner.
- **Auto-created follow-up tasks** — rejected for v1: writes on behalf of
  the user need their own consent posture; the inline OFFER keeps the human
  in the loop.

## Open questions

1. Does the board's card density survive a next-activity line at 360px, or
   does the marker collapse to an icon+title attr on narrow? (Assume
   collapse, verify live.)
2. Rotting threshold: overdue-only, or also "no activity scheduled for N
   days" (Pipedrive supports both)? (Assume overdue-only v1; the explicit
   no-next-activity marker already covers the other half's visibility.)

## RFC verdict

Host work only — projection fields on host-extension routes. No RFC.

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | server rollup (`nextTask` on deals list/board/detail) + tests | not started |
| 2 | board markers + stage totals (sums shape) + a11y + i18n ×4 | not started |
| 3 | the inline schedule-next offer | not started |
