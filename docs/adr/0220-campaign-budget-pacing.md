# ADR 0220 — Campaign Studio: budget pacing + band-escalation alerts

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `campaign-intel` (`pacing.ts`, route, surface, `pacing-check` node, page section), a `campaign-sync.pacing-check` chain (pack v1.1.0) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C7** — ADR 0160's deferred alert/digest scope, buildable now that C8 gives the plan (`budget`) and C2 keeps actuals fresh |
| **RFC gate** | **None** — host-ext; recurrence rides the ONE scheduler via the RFC 0013 chain. |

## Decision

- **`buildPacing`** (pure read): per non-archived campaign with a `budget.totalMinor` plan — actual spend (performance store, linked-id first, name fallback) vs plan, `spentPct`, band (`ok` <80% / `warning` ≥80% / `over` ≥100%), and a simple linear monthly projection (null under 2 spend-days — no fake precision). Unplanned campaigns surfaced as a count so "no alerts" is legible. `GET /campaign-intel/pacing`.
- **`runPacingCheck`** (the chain's node): alerts through the ONE notification seam (`getNotificationEmitter().emit`, type `campaign.pacing`, `high` on over / `normal` on warning) with a durable per-campaign **band memo** — a campaign alerts once per band *escalation*, never on every scheduled run. Alert rules are chain configuration (the "no rules engine" constraint): `campaign-sync.pacing-check` chain, schedule daily after the metrics sync.
- Intel page gains a Pacing section (chips per band; the same single-fetch posture).

## Alternatives rejected

- A dedicated alert-rules entity/engine — recurrence is the scheduler's job, thresholds are code, dedup is the memo; nothing here needs user-authored rules yet.
- Alerting from `buildPacing` reads — a page view must never side-effect notifications.

## Verification

`campaign-intel-attribution-pacing.test.ts`: bands + projection floor, escalation-only alerting (memo dedup across runs, re-alert on escalation), notification emitted with campaignId metadata.
