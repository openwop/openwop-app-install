# ADR 0571 — Read-only ads delivery sync: live status, spend-to-date, last-synced honesty

Status: Proposed
Date: 2026-08-14
Feature: campaign-orchestration (+ the ads connector seam) — no new toggle
Origin: UX_UPGRADE-campaign-orchestration R2 — CO-R2-1/3/4, "market's top
asks … share ONE read-only connector investment: deferred-named"; ORCH-G3
(the "Paused" chip is a construction-time claim) has been blocked on this
since round 1.

## Context

The dispatch ledger records what WE sent at dispatch time; the platform then
moves (budgets spend, campaigns pause, ads get rejected) and our UI keeps
asserting the construction-time state. R2's cheap slice made the chip say
"at dispatch — not live" — honest, but the market's floor is live: delivery
status, spend-to-date, and a last-synced stamp.

## Boundaries audit

- **Connector seam**: the ads adapter (dispatch side) already owns platform
  credentials + the idempotency ledger (CO-SP-6's tombstone preserves
  `platformCampaignId` forever — the JOIN key a reader needs). A read lane
  extends the SAME adapter interface; no second credential store.
- **Money truth**: spend-to-date is a PLATFORM-reported number in the ad
  account's currency — rendered labeled as such, never merged into our
  planned-budget field (the CO-SP-7 rule), never used for billing math.
- **Read budget**: a sync is a scheduled/triggered pull persisted to rows —
  the UI reads OUR rows; it never fans out to the platform per page view.
- **Staleness honesty**: every synced fact renders WITH its `lastSyncedAt`;
  a failed sync leaves the previous facts VISIBLY stale (stamp + warning),
  never silently fresh-looking — the SSE-staleness lesson applied to ads.

## Decision (proposed)

1. **Adapter read interface (additive)**: `fetchDeliveryStatus(refs[]) →
   { platformCampaignId, status, spendToDateMinor, currency, at }[]` —
   optional per adapter; an adapter without it simply reports no live lane
   (the capability-honesty rule: the UI shows "live status not available
   for this connector", never a fabricated fresh state).
2. **Sync mechanism**: a sensor/trigger node in the existing ads node pack
   (chains doctrine — scheduling rides the executor, not feature cron),
   default OFF example chain ("Sync ad delivery every N hours") the operator
   instantiates; plus a manual "Sync now" button on the ledger (rate-capped).
3. **Storage**: synced facts land beside the dispatch ledger rows (additive
   fields: `live?: { status, spendToDateMinor, currency, at }`) — the
   tombstone trim preserves them like the idempotency core.
4. **UI**: the ledger row chip becomes two-valued — "at dispatch: X" and,
   when synced, "live: Y (as of <relative>)"; spend renders labeled in the
   AD ACCOUNT's currency (formatCurrencyMinor); ORCH-G3's chip finally
   unblocks. A stale sync (> 2× the chain's cadence) renders the stamp in
   the warning tone.

## Alternatives weighed

- **Per-view platform reads** — rejected: read-budget fan-out + credential
  exposure per request; sync-to-rows is the field's converged shape.
- **A separate "insights" feature** — rejected: the ledger is the money
  surface; splitting the reader from the tombstone/idempotency owner forks
  the truth.
- **Webhooks from platforms** — additive later; polling-by-chain is the
  lowest-commitment honest start and several platforms lack usable webhooks.

## Open questions

1. Which adapter grows the read lane first? (Assume the one live connector;
   the interface is optional so others degrade honestly.)
2. Spend alerts (budget overrun) — part of this ADR or the CO-R2-6/7/8
   capability lane? (Assume the capability lane; this ADR is READ-ONLY.)

## RFC verdict

Host work only (adapter interface + pack + host-extension fields). No wire.

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | adapter read interface + ledger fields + manual Sync now + UI chips/stamps | not started |
| 2 | sensor node + example sync chain (registry publish) | not started |
| 3 | staleness warning tone + ORCH-G3 chip unblock | not started |
