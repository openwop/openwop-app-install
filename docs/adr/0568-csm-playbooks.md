# ADR 0568 — CSM playbooks: health-triggered plays as chains/stacks, never in-tree

Status: Proposed
Date: 2026-08-14
Feature: csm (extends the ADR-lineage csm feature — no new toggle)
Origin: UX_UPGRADE-csm R2 deferral CSM-R2-2 ("playbooks — chains/stacks +
ADR"), the largest converged capability delta on the R2 matrix (ChurnZero
Plays, Vitally Playbooks, Planhat Automations, Totango SuccessPlays — 6/6
comparators ship triggered play automation; citations in the R2 market
report, `scratchpad/csm-r2-market.md`).

## Context

The CSM feature records health, ARR, renewal and owner truthfully (R1+R2),
but everything a CSM does ABOUT a red account happens off-platform. Every
comparator's core loop is: a trigger (health drop, renewal window, signal)
fires a PLAY — a sequenced set of tasks/outreach with an owner — and the
account page shows which plays ran.

## Boundaries audit (the doctrine decides most of this)

- **Chains-or-stacks doctrine (CLAUDE.md)**: a play IS a workflow — it ships
  as an RFC 0013 workflow-chain pack (`feature.csm.*` chain) or as kanban
  stack intake (ADR 0311 `openwop:kanban.add-todo`), run by the ONE shared
  executor. NEVER a hard-coded builtin. This ADR adds no new workflow
  machinery — only csm NODES + example chains.
- **Trigger seam**: `hostEventDispatcher` (ADR 0208) is the runless-event
  seam; a health-score write already flows through `csmService` — an
  account-health-changed host event is an additive emit at that choke
  point.
- **Task creation**: plays create TASKS — the crm `Task` owner (with
  ADR 0567's nextTask rollup, plays compose the same loop). No parallel
  todo entity.
- **HITL floor**: a play that sends OUTREACH (email) rides the existing
  approval/hold lanes (the ADR 0469/0470 egress posture) — no silent sends.
- **Existing packs**: `feature.csm.*` node pack exists (agent tools);
  chain packs ride `examples/workflow-chain-packs/` + the registry
  publishing flow (a chain fix needs a registry republish — the recorded
  lesson).

## Decision (proposed)

1. **Nodes** (`feature.csm.nodes.*`, additive): `on-health-drop` trigger
   (subscribes the host event; params: threshold, direction),
   `on-renewal-window` sensor (days-before param), `create-play-tasks`
   (writes crm Tasks linked to the account's company/deal where present),
   and reuse of existing outreach/approval nodes for the email leg.
2. **Example chain packs**: "Red-account rescue" (health < threshold →
   create triage tasks + notify owner) and "Renewal runway" (90/60/30-day
   task ladder) — shipped as chain packs users instantiate and EDIT in the
   builder (`…/workflows/from-chain`), per the app-builder reference shape.
3. **Surface**: the account drawer/page lists play RUNS touching the
   account (the run-history projection filtered by account metadata) — a
   read-only "what ran here", not a new automation UI; authoring stays in
   the builder + chat (ADR 0058).
4. **The trigger emit**: `csm.account.health-changed` host event emitted at
   the service choke point (old + new scores in the payload; emitted only
   on real transitions, not re-saves of the same score).

## Alternatives weighed

- **In-tree automation rules engine** — forbidden by the doctrine
  (deprecated ADR 0072 shape); a play users cannot open in the builder is
  invisible and uneditable.
- **Agent-driven plays only** (no chains) — the chat can already drive csm
  tools, but leaders' plays are DURABLE standing automations; chains are
  the durable shape, agents remain the conversational one. Both compose.
- **Cron-based renewal checks in csm code** — the sensor node owns
  scheduling through the executor; feature-code cron forks the owner.

## Open questions

1. Play-run attribution: is run-metadata account-id stamping (for the
   "what ran here" projection) already expressible, or does it need the
   RFC 0013 variable-bag extension noted in CLAUDE.md? (Audit before
   Phase 1; if the latter, that extension is an `../openwop` RFC first and
   Phase 3 blocks on it — flagged loudly here.)
2. Default thresholds for the example packs (health <70 aligns the page's
   own at-risk tier; assume yes).

## RFC verdict

Phases 1–2: host work only (nodes + packs + host event). Phase 3's
account-scoped run projection MAY need the RFC 0013 variable/metadata
extension — checked first, RFC'd if real (see OQ1).

## Phased implementation record

| Phase | Scope | Status |
|---|---|---|
| 1 | host event + trigger/sensor/task nodes + tests | not started |
| 2 | the two example chain packs + registry publish | not started |
| 3 | account "what ran here" projection | not started (OQ1 gate) |
