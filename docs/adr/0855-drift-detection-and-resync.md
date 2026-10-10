# ADR 0855 — Drift detection and re-sync checkpoints

Status: Accepted (maintainer go, 2026-10-07; model-powered parts default ON) — P1 and P4 implemented; P2–P3 implemented, and the eval merge gate MET on 2026-10-09 (on the workspace's model, Sonnet-class; see the correction in the implementation record); P5 blocked on a GitHub read connection

- **Program:** ROADMAP § "Collaborative orchestration program", item 4.
- **Composes:** ADR 0831 (the ledger, its run stamp `teamLedger {ledgerId,
  version}` and `stateAt`), ADR 0853 (decisions and the "Record as decision"
  path), ADR 0852 (project chat / bound channels), ADR 0136 P4 (the reckoning
  pattern: projected over runs and events, advisory).
- **Toggle:** none — **always on** (maintainer decision 2026-10-07: these
  features are not behind a toggle). The cost control is the per-workspace
  daily budget, `OPENWOP_DRIFT_CHECK_DAILY_CAP` (default 100; `0` stops it).
- **RFC verdict:** host-only.

## 1. Context

When the work and the recorded intent disagree, the team needs to know whether
that was a decision or a mistake. Measured on `origin/main` (2026-10-07): a run
records the ledger version it acted on; documents carry `provenance.runId`, run
artifacts carry `runId`, generated assets carry lineage; nothing reads PR diffs
(GitHub publishing is write-only); "what changed since you last looked" was
browser-only until ADR 0831 D1 moved it to the server (#4532).

## 2. Decision

### D1 — The drift check (after a stamped run completes)

For a run stamped with a ledger version, the check reads what the run produced
(documents with its `provenance.runId`, its run artifacts' text, campaign copy)
and the ledger state AT THAT VERSION (`stateAt`), and asks a model for findings:
`{claim, evidence, ledgerItem?, decisionDocumentId?}`. Each finding is classified
**explained** when it cites a decision record or a ledger item that covers it,
else **unexplained**. Findings are stored (`team-ledger:drift`), advisory only:
**a drift check never blocks or fails a run.**

Guards (the first unattended model call over produced work):
- produced text is fenced as untrusted; the model returns findings only;
- once per run (idempotent), skipped for runs with no produced text;
- a per-workspace daily budget; when spent, checks stop for the day and say so;
- **merge gate:** a seeded SDLC scenario (the ROADMAP's "done when"): a change
  made without a recorded decision is flagged unexplained, and one that cites a
  decision is not; P2 does not merge until both hold on the fixture set;
- an LLM-exchange audit row.

### D2 — Unexplained drift reaches the owner

Each unexplained finding posts a card in the project chat / bound channels,
addressed to the ledger owner, with **Accept as decision** (ADR 0853 D2,
`source.kind:'drift'`, prefilled from the finding) and **Send back** (a comment
on the run's kanban card, or the run's chat, saying what conflicts with which
ledger item). Dismissing a finding records who and why.

### D3 — Re-sync checkpoint

When the changes a project's members have not seen pass a threshold (default:
5 accepted changes since a member's server-side last-seen version, or 10 waiting
proposals), the project chat gets ONE "what changed" summary (the accepted
deltas' reasons, newest first) asking the members to confirm the current intent
— confirming marks it seen (ADR 0831 D1). At most one checkpoint per project per
day. Deterministic, no model call.

### D4 — PR diffs

Needs a GitHub READ connection the app does not have. Sequenced after D1, behind
that connection; D1's reader interface takes a "produced change" list so a diff
source plugs in without changing the check.

## 3. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | Server-side last-seen (ADR 0831 D1) | Done: #4532 |
| P2 | D1 check + store + budget + eval fixture + audit row | The seeded scenario passes (merge gate); idempotent; never blocks a run |
| P3 | D2 cards + Accept-as-decision / Send-back / Dismiss | One card per unexplained finding; accept goes through ADR 0853 D2 |
| P4 | D3 checkpoint | Threshold fires once; at most one per day; confirm marks seen |
| P5 | D4 PR diffs | Blocked on a GitHub read connection |

## 4. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P2–P3 | `feat/drift-check` (draft #4564) | `features/team-intent-ledger/driftCheck.ts`: enqueued on the run-terminal seam (completed, ledger-stamped runs), checked on a bounded worker tick, one quick-class call, both texts fenced, strict parse, per-workspace daily budget. **CORRECTED:** findings are not stored in their own `team-ledger:drift` collection; each unexplained finding is a decision SUGGESTION (`source.kind:'drift'`), which is where the owner already acts, and "explained" means the finding cites a decision title that is on the ledger at the stamped version (`unexplainedFindings`), never the model's say-so. One notice per run in the project chat (not one card per finding). D2: Record (ADR 0853 D2), Dismiss with a reason (who + why kept, erased with the person), Send back = an inbox notification to the person who started the run (409 when nobody did). **CORRECTED:** Send back does not comment on the kanban card; cards have no comment primitive. Merge gate `scripts/eval-drift-check.mts` over `test/fixtures/drift-check-eval.json` (18 cases): flag ≥ 0.9 of undecided departures, ≤ 0.1 false flags — **run 2026-10-09, see the correction below**. Backend `adr0855-drift-check.test.ts` (4), frontend `decisionSuggestions.test.tsx` (+1). **Sabotage-witnessed:** model's decision title trusted, no toggle check, no budget, produced work unfenced, send back for any kind, no notification, reason dropped, no starter check, Send back shown for every kind |

> **CORRECTED 2026-10-09 — the merge gate, run for real, found a product bug and a model limit.**
> - **The bug (host code):** the first run flagged 3 of 9 departures. The
>   model found all of them, but named the decision the work BROKE in
>   `decisionTitle`, and `unexplainedFindings` read any known title as an
>   explanation. So contradicting a decision, the drift that matters most,
>   silenced itself. Fixed: the prompt asks for `authorizedBy` (the decision
>   that CHOSE the change), says a broken decision never authorizes, and the
>   host never lets a finding be explained by the decision its `ledgerItem`
>   departs from. Both rules are sabotage-witnessed.
> - **The model limit:** after the fix, Haiku 4.5 (the quick class) flagged
>   9/9 but false-flagged `scope-us-decided` (1/9 = 0.11 > 0.1) on every one of
>   six runs, across three prompt revisions, each time for a different reason.
>   That case is a decided change whose goal text was never updated, which real
>   ledgers do. Sonnet 5.5 passed 9/9 flagged, 0/9 false flags, three runs out
>   of three. **Maintainer decision (2026-10-09): use Sonnet.** The check now
>   drops `modelClass: 'quick'` and runs on the workspace's own model; the
>   per-workspace daily budget remains the cost control. The fixture and both
>   bars are unchanged.
| P4 | `feat/ledger-resync` | `features/team-intent-ledger/resync.ts` on a ledger-change hook (awaited, fail-soft); thresholds 5 accepted behind the lowest last-seen, or 10 waiting; once per project per day; posts via `host/projectConversations.ts`. `adr0855-resync.test.ts` (2). **Sabotage-witnessed:** no daily limit |
