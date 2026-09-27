# ADR 0232 — Priority Matrix intake, evidence, and promotion

Status: implemented (P1–P4, 2026-07-03; near-duplicate suggestion deferred to the planning-KB embedder follow-on per §4; promote-to-initiative FE affordance rides the strategy alignment surface later — the route + chat path ship now)

> **Correction (2026-07-03, follow-on batch):** intake became fully chat-drivable —
> STRAT-PM1 added the `get-intake`/`update-intake`/`add-evidence` node verbs to the
> priority-matrix surface + node pack (v1.3, 11 nodes), completing the ADR 0058
> "chat-drivability = agent + nodes" pattern for intake (deliberately **no** promote
> verb — promotion stays a human/route action). A `ghost-card` guard
> (`assertIdeaOnList`) now lives in the intake **service** (single owner), not the
> route, because the capability firewall can't see node `ctx.features.*` calls — the
> structural-safety invariant. The self-serve public intake **portal** (forms→trigger)
> remains deferred as **STRAT-PORTAL**: it is a forms-feature capability (needs forms
> host-events + a form→intake-list binding), not a strategy tail — see
> strategy-gap-analysis.md §8 (E3 graded B−, not overclaimed as A).

Date: 2026-07-03
Relates to: ADR 0058–0061 (Priority Matrix), ADR 0046 (projects), ADR 0079 (strategy links), ADR 0021 (comments resolver registry), ADR 0017 (forms), ADR 0034 (trigger ingestion), ADR 0230 (emit side-channels), docs/research/strategy-gap-analysis.md (Phase C4)

## Context

The gap analysis (E3, grade D+): ideas exist only as scored kanban cards — no
intake fields (requester/source/estimated value), no evidence chain, no
dedupe/merge, no promotion trail from a winning idea to funded work. The Phase C
architect review resolved the boundary question: intake/evidence data lands as
**PM-owned OVERLAY rows keyed `listId::cardId`** (the established
`IdeaScore`/`IdeaSchedule` pattern) — never as `host.kanban` card-schema
extensions.

## Decision

1. **`IdeaIntake` overlay** (`priority:intake`): requester, sourceChannel
   (`form|chat|api|manual`), estimatedValue (number + free-text unit), notes.
   Written at submit (optional fields on the existing submit routes/verbs) or
   patched later; surfaced on the idea detail.
2. **`IdeaEvidence` overlay** (`priority:evidence`, append-only list per idea):
   typed refs `{ kind: 'document'|'kb'|'url'; ref; label? }` — pointers, never
   copies. URL evidence is display-only (no fetch).
3. **Comments on ideas**: one entry in the comments feature's static resolver
   registry (`priority-idea` commentable type, org-validated via the list),
   per the ADR 0021 extension contract.
4. **Merge**: `POST …/ideas/:cardId/merge` (body: `duplicateCardId`) — the
   canonical card absorbs the duplicate's intake/evidence rows (union), the
   duplicate card moves to the terminal lane with a `mergedInto` marker in its
   intake overlay; scores/votes of the duplicate are NOT merged (scoring
   integrity — a human re-scores if needed). Near-duplicate *suggestion* at
   submit is deferred to the planning-KB embedder follow-on (logged, not
   silent).
5. **Promotion** — split by import direction (implementation correction,
   2026-07-03): ADR 0079 deliberately kept the PM backend free of strategy
   imports (strategyService already imports PM — the reverse edge would be a
   cycle). So:
   - **promote-to-initiative lives in the STRATEGY feature**:
     `POST /strategy/:id/initiatives/from-idea` (body: `listId`, `cardId`) —
     write-gated on the strategy; appends a `StrategyInitiative` titled from
     the idea card, adds the existing `{kind:'priority-idea'}` link (canonical
     on the strategy), then calls PM's `markPromoted` + moves the card to the
     terminal `done` lane (strategy → PM import direction already exists).
   - **promote-to-project lives in PM**:
     `POST …/ideas/:cardId/promote-to-project` — creates a `Project` (PM
     already imports the projects service), stamps `promotedTo`, moves the
     card to `done`.
   Merge moves the duplicate to the terminal `wont-do` (cancellation) lane.
6. **Events/audit**: all of the above ride `priorityMutated` (ADR 0230) with
   verbs `intake-updated`, `evidence-added`, `merged`, `promoted`.
7. **Known-deferred (Phase-C code review)**: intake/evidence have no
   `ctx.features['priority-matrix']` node verbs yet — chat-drivability for
   intake lands with a Prioritization-Analyst pack refresh (a pack-coverage
   follow-on, not silent). Intake/evidence writes validate the card exists on
   the list (no ghost-card overlay rows).

No new toggles (rides `priority-matrix`); host-ext only — **no new RFC**.

## Phases

| Phase | Deliverable |
|---|---|
| P1 | intake + evidence overlays, routes, emit verbs |
| P2 | merge + promote routes (strategy/project composition) |
| P3 | comments resolver entry |
| P4 | FE: intake fields + evidence list + merge/promote affordances on the idea detail |
