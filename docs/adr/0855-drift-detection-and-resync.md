# ADR 0855 — Drift detection and re-sync checkpoints

Status: Accepted (maintainer go, 2026-10-07; model-powered parts default ON) — P1 and P4 implemented; P2–P3 implemented, and the eval merge gate MET on 2026-10-09 (on the workspace's model, Sonnet-class; see the correction in the implementation record); P5 built (a read-only GitHub connection + an on-demand pull-request check), its own eval merge gate owed

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
| P5 | D4 PR diffs | A `github-read` connection (read-only, adapterOnly, api.github.com); on-demand check from the Ledger tab; the PR fixture meets the same bar |

## 4. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P5 | `feat/drift-pr-diffs` | **On demand, not on every PR**: a person with write access names a pull request on the Ledger tab (`POST …/drift/pull-request {url}`); the host reads its title, description and diff through THEIR `github-read` connection (new builtin provider: read scopes only, `adapterOnly`, no consumer nodes, host-pinned, so the generic http node can never carry the token and no run can reach it) and runs the SAME check (`classifyDrift`, `unexplainedFindings`) against the ledger's CURRENT version (a PR has no run stamp). Awaited (no background work, ADR 0699 D1), one check from the same daily budget, findings filed as possible decisions linked to the PR (ref `pr:owner/repo#n@vN:i`, idempotent per ledger version). Nothing is posted to GitHub; there is no webhook, because a webhook needs a GitHub App the app does not have. `prDrift.ts`; `PullRequestDriftCheck.tsx`. Backend `adr0855-pr-drift.test.ts` (5, real route; GitHub is the reader seam, the model the headless-AI seam), frontend `pullRequestDriftCheck.test.tsx` (7). **Sabotage-witnessed:** authorized findings filed, no budget, the description dropped from what the model sees, no access check. **Found while testing:** the URL guard's `..` lookahead anchored to the END of the string, not the segment, so `github.com/a/../pull/1` parsed (the ADR 0835 D6 re-targeting shape); fixed and pinned. **Merge gate met 2026-10-12:** `scripts/eval-drift-check.mts test/fixtures/drift-check-pr-eval.json` (10 cases, one injection in the PR description) on claude-sonnet-5-5: flagged 5/5, false flags 0/5 (bar ≥ 0.9 / ≤ 0.1); the base fixture re-run the same day: flagged 9/9, false flags 0/9 |
| P2–P3 | `feat/drift-check` (#4564, merged 2026-10-10) | `features/team-intent-ledger/driftCheck.ts`: enqueued on the run-terminal seam (completed, ledger-stamped runs), checked on a bounded worker tick, one quick-class call, both texts fenced, strict parse, per-workspace daily budget. **CORRECTED:** findings are not stored in their own `team-ledger:drift` collection; each unexplained finding is a decision SUGGESTION (`source.kind:'drift'`), which is where the owner already acts, and "explained" means the finding cites a decision title that is on the ledger at the stamped version (`unexplainedFindings`), never the model's say-so. One notice per run in the project chat (not one card per finding). D2: Record (ADR 0853 D2), Dismiss with a reason (who + why kept, erased with the person), Send back = an inbox notification to the person who started the run (409 when nobody did). **CORRECTED:** Send back does not comment on the kanban card; cards have no comment primitive. Merge gate `scripts/eval-drift-check.mts` over `test/fixtures/drift-check-eval.json` (18 cases): flag ≥ 0.9 of undecided departures, ≤ 0.1 false flags — **run 2026-10-09, see the correction below**. Backend `adr0855-drift-check.test.ts` (4), frontend `decisionSuggestions.test.tsx` (+1). **Sabotage-witnessed:** model's decision title trusted, no toggle check, no budget, produced work unfenced, send back for any kind, no notification, reason dropped, no starter check, Send back shown for every kind |

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

> **Correction 2026-10-12 (grade-tests wave 29):** `adr0855-resync.test.ts` now runs 3 cases, not 2.
> The third is an `it.fails` pinning a defect (TL-RESYNC-1): an owner's direct write is a propose then
> an accept, and the resync check runs after the propose, so the once-a-day summary can go out for the
> version before the accept and count the owner's own write as waiting; the day key then suppresses
> the correct summary.
