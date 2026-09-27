# ADR 0233 — Board pack chain + decision records

Status: implemented (2026-07-03)

> **Correction (2026-07-03, follow-on batch):** STRAT-A1 added a chain-execution e2e
> (`strategy-chain-execution.test.ts`) that runs all three strategy chains through
> `expandChain` + `buildFeatureSurfaces` + an edge-walk — and it **caught a real bug in
> this board-pack chain**: `orgId` and `markdown` were never threaded to
> `create-board-memo`, so the persist node errored. Fixed the chain pack (added the
> required `orgId` param + the `memo.content → persist.markdown` edge) and made
> `create-board-memo` read `orgId`/`markdown` from config as well as inputs. The chain
> was expansion-valid but not execution-valid before this — the e2e is now the guard.

Date: 2026-07-03
Relates to: ADR 0231 (measurement + cadence), ADR 0080 (create-board-memo), ADR 0053 (documents — OPEN kind vocabulary), ADR 0070 (quorum ledger), ADR 0234 (session rationale), ADR 0082 (no dashboards), docs/research/strategy-gap-analysis.md (Phase C5/C8)

## Decision

### C5 — `strategy.board-pack` chain (reporting as composition, not a dashboard)

A third chain in `vendor.openwop-app.workflows.strategy`:
`get-health` (portfolio health + ADR 0231 measurement signals) →
`core.ai.chatCompletion` (an MBR/QBR-shaped pre-read: progress, staleness,
at-risk strategies, pending proposals, asks) → `create-board-memo` (persists a
`board-update` Document — ADR 0080's node, unchanged) →
`notification-push`. Scheduled via the SAME cadence config (a third
`boardPack` entry in `GET/PUT /strategy/cadence`). Deliberate scope notes:
- **Insights-suite variance is NOT composed statically into the chain** — a
  chain referencing a maybe-off feature's node fails when that feature is off.
  Cross-suite composition stays chat-drivable (the Strategy Analyst holds both
  tools). Recorded, not silent.
- **No new document kinds needed**: the documents vocabulary is OPEN (ADR
  0053); the pack lands as `board-update`, decision records as
  `decision-record`.

### C8 — Decision records (a register without a new store)

- **`POST /strategy/:id/decisions`** (write-gated): body
  `{ title, decision, rationale?, alternatives?, approvalId?, sessionRef? }` →
  persists a `decision-record` Document in the strategy's org (markdown
  rendered from the fields, provenance `user`), appends the existing
  `{kind:'document'}` StrategyLink (canonical on the strategy), emits
  `host.strategy.decision.recorded` + audit. When `approvalId` is provided and
  resolves to a decided approval in this tenant, the record cites it (the
  reviewDecisionLedger provenance).
- **`record-decision` node** (pack v1.2.0): the agent-drafting half — persists
  the `decision-record` Document only (NO strategy link; links are canonical
  human writes, the create-board-memo posture). A human links it via the
  decisions route or the alignment editor.

Host-ext only; no new toggles; **no new RFC**.
