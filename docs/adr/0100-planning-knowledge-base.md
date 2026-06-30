# ADR 0100 - Planning knowledge base: auto-index Strategy & Priority Matrix into KB (RAG for agents & boards)

**Status:** Accepted — implemented (all 5 phases, 2026-06-21)
**Date:** 2026-06-21
**Surface:** host-internal only — a per-feature "knowledge-service" module on Strategy and
Priority Matrix that keeps an auto-managed KB collection in sync on every CRUD, referenced by
agents (and Boards of Advisors) through the EXISTING per-agent knowledge binding. **No new
feature package, no new toggle, no wire change, no new RFC.**
**Extends:** ADR 0079/0080 (Strategy), ADR 0058 (Priority Matrix).
**Composes:** ADR 0011 (KB/RAG — `kbService` + the host vector surface), ADR 0038/0042
(per-agent knowledge binding), ADR 0040 (Board of Advisors), ADR 0006 (RBAC), ADR 0015
(workspace-as-tenant / org scope).
**Design provenance:** in-conversation design resolved by `/architect` (options-evaluation) +
`/ux-review` (IA), 2026-06-21.

## Why this exists

Strategy and Priority Matrix hold an org's highest-value planning content — strategic
narratives, OKRs, initiatives, prioritized ideas with scores. Today that content is invisible
to the AI surfaces: an agent or a Board of Advisors cannot *retrieve* "what are our Q3
objectives?" or "which ideas did we rank highest?" unless a human pastes it. The capability the
request asks for — **agents and boards reference planning content via RAG, kept fresh on every
change** — already has every primitive in the app:

- **KB/RAG** (ADR 0011) ingests text into org-scoped collections (deterministic chunk + local
  embedder, no provider) and serves retrieval.
- **Per-agent knowledge binding** (ADR 0038/0042) composes any KB collection into agent dispatch
  retrieval, content-trust fenced, on the agent's per-turn query.
- **Five features already feed KB** from their own services (`projectKnowledgeService`,
  `profileKnowledgeService`, `notebooks`, `documents`, `agent-knowledge`).

So this is **composition, not new infrastructure**: a thin per-feature indexer that mirrors each
planning entity into a KB collection on write, plus the UI to make the binding + the privacy
implications legible.

## Boundaries & pre-existing-surface audit

- **KB is the single owner of collections + RAG.** `features/kb/kbService.ts` —
  `ingestDocument(tenantId, orgId, actor, collectionId, {title,text,contentTrust})` (synchronous,
  deterministic chunk + `embedText` local embedder), `deleteDocument(...id)`; no update → the
  pattern is `delete + re-ingest` by a **stable document id** (doc keyed
  `${tenantId}:${orgId}:${documentId}`, chunks `${documentId}:${chunkIndex}`). We **reuse** it; we
  do NOT add a second vector store or embedder.
- **Feeding KB from a feature is an established cross-feature pattern (5 precedents).**
  `features/projects/projectKnowledgeService.ts`, `features/profile-memory/profileKnowledgeService.ts`,
  `notebooks`, `documents`, `agent-knowledge` all call `ingestDocument`. So a
  `strategyKnowledgeService.ts` / `priorityMatrixKnowledgeService.ts` is the **precedented shape**,
  not an ADR-0001 boundary violation. (`host/knowledgeSourceFetch.ts` is the host-side fetch helper
  for ingest text.)
- **No DurableCollection change-hook exists.** The established "do X on every mutation" pattern is a
  **synchronous side-effect right after `collection.put()`** in the service (e.g.
  `priorityMatrixService.recomputeListScores` after `lists.put`). We follow it — the indexer is
  called from each mutation, not a global listener.
- **Agent binding is the single owner of "what an agent retrieves."** `agentProfile.knowledge`
  (`collectionIds[]`) → `resolveAgentKnowledgeRetrieve` (`host/agentKnowledgeComposition.ts`).
  A planning KB collection binds **identically** to any KB collection — no new retrieval path.
- **Board context is owned by `host/boardContextResolver.ts`** (registered seam). `contextRefs`
  currently supports only `kind:'strategy'` (a *static block* via `buildStrategyContextBlock`). We do
  **not** add a `kind:'kb-collection'` context-ref (see Decision 2) — RAG needs a per-turn query, and
  the static-block path has none.
- **No KB-feeding feature currently auto-indexes its OWN entities on every CRUD** — that behavior is
  the one genuinely new thing here, and it is purely additive (a side-effect; nothing pre-exists to
  collide with).
- **Org scope.** Strategy (`types.ts:84,151`) and Priority Matrix lists (`types.ts:53`) carry a
  mandatory `orgId`; an idea is a `host.kanban` card on the list's board (ADR 0058 "no parallel
  architecture"). The KB doc's org = the entity's `orgId`.

## Decisions

### D1 — Granularity: one auto-managed collection per FEATURE, per ORG (recommended by `/architect` + `/ux-review`)

Two auto-created, auto-managed collections per org: **"Strategy KB"** and **"Priority Matrix KB"**.
Each strategy = one document; each idea = one document; the list's criteria metadata = one document.

- **Rejected (B) per-record** (a collection per strategy/list): collection-count blowup, and it
  **floods the bind picker** (`SubjectKnowledgePanel` lists collections by name) — a real IA failure.
- **Rejected (C) combined** "Planning KB": can't scope an agent to *just* Strategy or *just* Priority
  Matrix; retrieval cross-contaminates.
- (A) gives exactly the unit an agent/board references, with bounded collection count, and one-doc-
  per-entity maps cleanly onto `delete + re-ingest`.

**CRITICAL RBAC refinement — visibility-scope MUST equal collection-scope.** Strategy has
`scope: user | workspace | org` over the mandatory `orgId` (ADR 0079 §Correction). An org-shared
"Strategy KB" collection is readable by anyone who binds it, so a **user-scoped (private) strategy
MUST NOT be indexed into it** — that would leak a private strategy to every binder. **MVP rule: index
only `org`/`workspace`-scoped strategies; user-private strategies are not auto-indexed** (a later
phase MAY add a per-user "My Strategy KB"). Priority Matrix is org-scoped only → no private-leak path.

### D2 — Board of Advisors reference: bind the collection to the advisor AGENTS, + a board-level UI affordance

Advisors reference the planning KB through the **existing per-agent binding** (ADR 0038): each
advisor agent has the collection in `agentProfile.knowledge.collectionIds`, retrieved on its
per-turn query. **RAG needs a query; the agent-retrieval path supplies one and the static
`contextRefs` block does not** — so a new `kind:'kb-collection'` context-ref is the wrong surface
(rejected).

> **Extension (2026-06-22) — project KBs added.** The "Shared knowledge" affordance now offers a
> THIRD kind, `project`, alongside the two managed KBs. Unlike strategy/priority-matrix (one
> deterministic `mgd-<kind>-<orgId>` collection), project knowledge is the org's **user-curated
> per-project KB collections** (ADR 0042) — a *set*, resolved as the union of the org's projects'
> `subjectKnowledge.collectionIds`. Sharing binds every collection in that set to every advisor;
> there is no pre-create (they already exist). **Same RBAC carve-out:** only `org`-VISIBLE projects
> are included — a `private` project's KB is skipped (agent retrieval doesn't re-check project
> membership, so binding it would leak it). Known limitation: the set is a snapshot — a project KB
> added *after* sharing needs a re-toggle to be picked up (status shows it as not-fully-shared).

> **Refactor (2026-06-22, `/architect` end-to-end review) — `registerShareableKb` inversion seam.**
> The board originally hard-coded the three kinds and imported five features' internals to resolve
> their collections (a coupling hub). Replaced with a core registry (`host/shareableKb.ts`): each
> KB-owning feature registers a `ShareableKbProvider` (`resolveCollectionIds` + optional
> `ensureCollectionIds` for managed pre-create) at boot; the board iterates the registry and
> imports **none** of those features (only `agent-knowledge` for binding + the seam). A new
> shareable-KB kind is now purely additive — register a provider; the board picks it up.
> - **Visibility-consistency fix:** the project provider resolves `org`-visible projects for
>   share/status but **ALL** projects for `forUnshare`, so unshare fully cleans up a collection that
>   was bound while org-visible and later made `private` (which `setProjectVisibility` doesn't
>   reconcile). The corrected severity: this was never privilege escalation — a project KB collection
>   is **org-readable via the KB API regardless of project visibility** (`kb/routes.ts` gates on
>   `workspace:read` only; the visibility gate lives on the *project-knowledge* route, not the
>   collection), so the carve-out is an intent-respecting filter, not a hard boundary.
> - **Perf note (accepted):** the project provider's `resolveCollectionIds` does a `listProjects`
>   scan + per-project `getSubjectKnowledge`; the FE fetches per board card. Fine at current scale; a
>   batch endpoint / org-project cache is the future optimization if board lists grow.

> **Static "Project context" (2026-06-22, `/architect` + `/ux-review`).** A user expected to associate
> projects with a board from the edit form (parity with the per-board "Strategy context" picker), but
> only the org-wide Project KBs RAG toggle existed. Both reviews rejected a per-project *KB* picker (it
> would be a SECOND project-KB-sharing path beside the card toggle — duplication) and chose to **extend
> the existing static-context mechanism**: `AdvisoryContextRef` gains `{kind:'project';projectId}`,
> `resolveContextRefs` validates+RBAC-checks it (`resolveProjectAccess`), `buildProjectContextBlock`
> (charter: goal/objectives/status/health/milestones) is concatenated by the same
> `registerBoardContextResolver` resolver, and the edit form gets a "Project context" picker grouped
> with Strategy context under a "Planning context" heading. Result: full strategy↔project **symmetry** —
> per-board STATIC context (OKRs + charters) for "what we're working toward" + org-wide RAG (KBs) for
> "look it up" — with no duplication and RBAC *better* than the KB path (refs rejected at write + the
> block filtered per convener, so a `private` project can't leak).

**UX correction (from `/ux-review`):** the pure backend choice is *undiscoverable* — a convener has no
reason to edit each advisor's profile. So the **AdvisoryBoardPage gains a "Shared knowledge" section**
that lists the collections the board's advisors can see and a "Give all advisors the Strategy KB"
control which **applies the agent binding board-wide** at convene/config time. Mechanism stays D2-agent;
the board page merely *drives* it. No new wire/context-ref surface.

### D3 — Freshness, archive, backfill, failure (the operational rules)

- **Fresh on CRUD:** each Strategy/Priority-Matrix mutation, *after* its durable write, calls the
  feature's knowledge-service: `create`/`update` → `delete + re-ingest` the entity's doc (stable id =
  the entity id); content keyed deterministically so re-ingest is idempotent.
- **Archive/delete ⇒ remove from KB.** `archiveStrategy` (soft) AND `hardDeleteStrategy` /
  `deleteList` / idea-delete → `deleteDocument`. **KB presence ≡ "active AND shared-scope"**; an
  un-archive re-indexes. (Agents must not retrieve dead/archived planning items.)
- **Best-effort, fail-open.** Every index call is wrapped (`try/catch` + log); a KB failure MUST NEVER
  break the Strategy/PM CRUD. Partial-failure orphans self-heal on the next mutation (re-ingest
  overwrites by stable id).
- **Backfill (required, because gating is always-on).** Flipping the toggles on only catches *future*
  CRUD. Existing entities are indexed by a **lazy backfill**: on first access/creation of the auto
  collection (or a `reindex` action), sweep the feature's existing rows into the collection. A
  **content-hash guard** skips re-embed when an entity's indexable content is unchanged (avoids
  needless churn on no-op updates).

  > **Correction (2026-06-22) — auto-backfill shipped.** Phase 3 landed only the *explicit* `reindex-kb`
  > route (the architect review preferred it over lazy-on-create, citing one-time latency on a user's
  > CRUD). The maintainer then required existing items to be indexed **without** a manual call, so the
  > **lazy-on-first-creation** option in this decision was also implemented: each indexer's
  > `getOrCreateCollection` (and the board-share `ensureCollection`) runs the feature's backfill the
  > first time it creates the managed collection. Re-entrant-safe (the collection exists before the
  > backfill's own index calls run) + idempotent (hash-guarded). The one-time latency is accepted as a
  > bounded cost; the explicit route remains for on-demand re-runs.
- **Gating (decided): always-on.** Auto-index runs whenever BOTH the `kb` toggle AND the feature's
  own toggle (`strategy` / `priority-matrix`) are enabled — **no new toggle**.

## Data model (no new entities)

- **Auto collection** = a normal `KnowledgeCollection` (ADR 0011), org-scoped, flagged
  `managed: 'strategy' | 'priority-matrix'` (a new additive field on the collection so the UI can
  render the synced/read-only treatment and suppress hand-edits). Deterministic collection id per
  `(orgId, feature)` so the indexer + backfill resolve it without a lookup table.
- **Document** = one per entity, `documentId = entityId` (stable), `title` = entity title,
  `text` = a deterministic `formatStrategyForKb(strategy)` / `formatIdeaForKb(card, scores)` (reuse the
  existing `formatStrategyContextBlock` shape), `contentTrust: 'trusted'` (user-authored).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package (ADR 0001)** | **NOT a new package.** Two per-feature modules — `features/strategy/strategyKnowledgeService.ts` + `features/priority-matrix/priorityMatrixKnowledgeService.ts` (the `projectKnowledgeService`/`profileKnowledgeService` precedent) — plus a "Shared knowledge" affordance in `features/advisory-board`. Each calls `kbService` (precedented cross-feature feed). Optional additive `managed` field on `KnowledgeCollection`. No new `BACKEND_FEATURES` entry; core never imports the feature. |
| 2 | **Toggle + admin UI** | **No new toggle.** Gated by `kb` AND the feature's own toggle (`strategy` / `priority-matrix`), resolved server-side at each mutation. (Decided: always-on.) |
| 3 | **Workflow surface (ADR 0014)** | None new. Workflows reach the planning KB through the existing `ctx.features.kb` retrieval + agent binding. (Optional later: expose the managed collection id on `ctx.features.strategy`/`priority-matrix` reads so a workflow can bind it programmatically.) |
| 4 | **Node pack** | None. Indexing is a service side-effect, not a node; retrieval rides the existing `core.openwop.rag` node. |
| 5 | **AI-chat envelopes** | None. |
| 6 | **Agent pack** | None new. Existing agents bind the collection via `agentProfile.knowledge`. |
| 7 | **Public surface** | None. Never in `PUBLIC_PATH_PREFIXES`. |
| 8 | **RBAC + isolation (ADR 0006)** | KB collection org-scoped (doc org = entity org); reads gated by the existing KB RBAC + the agent `knowledge` capability gate. **The visibility-scope rule (D1): user-private strategies are not indexed into the org collection.** Fail-closed: if scope can't be resolved, do not index. |
| 9 | **Replay / fork safety** | Ingest is a **non-run side-effect** (no run, no recorded event, not the wire) → zero replay/fork impact. `delete + re-ingest` is idempotent (deterministic chunk ids + local embedder = identical vectors). |
| 10 | **Frontend** | Reuses `ui/` §5.1 primitives — **no new components.** (a) `SubjectKnowledgePanel`/`AgentKnowledgePanel`/`KnowledgeBasePage`: a **synced badge** (`.chip`/`<StatusBadge>` + `BookOpenIcon` "Auto · synced from Strategy") on `managed` collections, **suppress** ingest-text/delete-document (keep bind/unbind), a `<Notice>` explaining sync. (b) Strategy + Priority Matrix pages: an **"Indexed for agents"** chip on shared items + a muted **"Private · not shared with agents"** cue on user-scoped strategies (transparency). (c) `AdvisoryBoardPage`: the "Shared knowledge" section (D2). |

## RFC verdict

**Host-internal — NO new RFC, rides no new RFC.** Every primitive exists: KB collections + ingest +
the host vector surface (ADR 0011, which itself rides the accepted RAG capability), per-agent knowledge
binding (ADR 0038), board context (ADR 0040). The new behavior — auto-indexing a feature's own entities
into KB on CRUD — is a host-internal side-effect under `/v1/host/openwop-app/*`; it touches no run-event
field, capability flag, event type, endpoint contract, or normative MUST. The optional `managed` field
is additive host-ext metadata on a host-ext collection. `OPENWOP_REQUIRE_BEHAVIOR=true` unaffected.

## Phased plan

- **Phase 1 — Strategy indexer + RBAC + archive + fail-open.** `strategyKnowledgeService.ts`:
  resolve/create the org "Strategy KB" (`managed:'strategy'`); `indexStrategy`/`removeStrategy`
  (content-hash-guarded); hook into `createStrategy`/`updateStrategy`/`archiveStrategy`/
  `hardDeleteStrategy` after the durable write, **visibility-scoped** (skip user-private), best-effort.
  Tests: index on create/update; archive removes; user-private NOT indexed; idempotent re-ingest;
  KB-failure does not break the CRUD.
- **Phase 2 — Priority Matrix indexer.** `priorityMatrixKnowledgeService.ts`: the "Priority Matrix KB"
  (`managed:'priority-matrix'`); index idea on `submitIdea`/`setIdeaScore`/`moveIdeaStatus`, list
  criteria on `createList`/`updateList`; remove on idea/list delete. Same guarantees + tests.
- **Phase 3 — Backfill + content-hash.** Lazy backfill sweep on first collection access (or a
  `POST …/reindex`); the content-hash guard.
- **Phase 4 — Frontend transparency + binding.** The `managed`-collection synced badge + suppressed
  edit controls in the knowledge panels; the "Indexed for agents" / "Private" cues on Strategy + PM
  pages. (Binding itself already works through `AgentKnowledgePanel`.)
- **Phase 5 — Board "Shared knowledge" affordance.** `AdvisoryBoardPage` section + the
  "give all advisors the Strategy KB" board-wide binding action (drives D2-agent).

## Alternatives weighed

- **Granularity (B) per-record / (C) combined** — rejected (D1): collection-count blowup + unusable
  bind picker / loss of feature-scoped retrieval.
- **Board access (B) `kind:'kb-collection'` context-ref** — rejected (D2): RAG needs a per-turn query;
  the static-block context-ref path has none. (A) bind-to-agent + board UI is the right fit.
- **A new core "KB indexer" seam / DurableCollection change-hook** — rejected: no such hook exists and
  the precedent is per-feature knowledge-service modules calling `kbService` directly; a new generic
  seam would be infra nobody else needs yet.
- **A new toggle for the auto-index behavior** — rejected by the maintainer (always-on when
  `kb` + the feature toggle are on); recorded as the gating decision.
- **Async/queued indexing** — deferred: the local embedder is cheap and synchronous-best-effort keeps
  the model simple + replay-trivial. Revisit only if the CRUD-hot-path embed cost shows up.

## Open questions

- **User-private Strategy retrieval** — D1 skips user-scoped strategies (RBAC-safe). If users want
  *their own* private planning retrievable by *their own* twin/agent, add a per-user "My Strategy KB"
  (composes ADR 0041 subject memory). Deferred; flagged.
- **Idea churn** — `setIdeaScore`/`moveIdeaStatus` fire often; the content-hash guard should treat
  score/status changes as content (they're indexable) but skip no-op writes. Confirm the indexable
  field set in Phase 2.
- **Collection lifecycle on toggle-off** — if the `kb` or feature toggle flips OFF, the managed
  collection is left intact (read paths gate on the toggle). Confirm we don't delete it (so a
  re-enable doesn't lose the index / force a full re-embed). Proposed: keep it, stop updating it.
- **Cross-org Strategy links** — a Strategy can link projects/priorities; the indexable text uses the
  strategy's own fields only (links are resolved live elsewhere), so no cross-org content leaks into
  the doc. Confirm in Phase 1.
- **Board-chat context keying (known pitfall).** Board strategy-context + `ownerSubject` knowledge have
  a keying gotcha — keyed by chat `sessionId` but the exchange reads by `${runId}:gate:0`, so a
  mismatch silently drops context (fixed elsewhere via `run.metadata.chatSessionId`). D2 deliberately
  routes through **agent dispatch retrieval** (the bound collection on each advisor's `agentProfile`),
  which is composed at dispatch and should sidestep the board-context-block keying entirely — but
  **Phase 5 MUST verify** the bound-collection retrieval actually reaches advisors *in the board chat*,
  not just in a 1:1 dispatch.

## PRD-vs-architecture corrections

- The request said "agents AND boards of advisors can reference these." The board path was reshaped
  from an implied board-level knowledge store to **agent-binding + a board UI affordance** (D2) —
  because RAG retrieval needs a per-turn query that only the agent path provides.
- The request implied indexing *all* planning content. Corrected with the **visibility-scope RBAC
  carve-out** (D1) — user-private strategies are NOT indexed into a shared collection.
- "Update the KB with every CRUD action" reshaped into the precedented **synchronous best-effort
  side-effect after the durable write** + **archive-removes** + a **backfill** for pre-existing rows
  (always-on gating only catches future writes).

## Implementation status

| Phase | Status | Commit / test |
|---|---|---|
| 1 | **Implemented** (2026-06-21) | `strategyKnowledgeService.ts` (index/remove/reconcile + visibility carve-out + fail-open) + kbService `managed`/`upsertDocument`/stable-`documentId` extensions + KB-route managed guard + 3 strategyService hooks. `strategy-knowledge.test.ts` (7 cases); 170 kb/strategy/priority/knowledge tests green; tsc clean. |
| 2 | **Implemented** (2026-06-21) | `priorityMatrixKnowledgeService.ts` (index list+idea / remove / reconcile / `reindexListIdeas` on criteria change) + 6 `priorityMatrixService` hooks (create/update/delete list, submit/move/score idea). Project-scoped lists carved out; doc namespaces `pm-list:`/`pm-idea:`; idea removal via `deleteList` cascade (cardIds captured pre-board-delete). `priority-matrix-knowledge.test.ts` (4 cases); 173 tests green; tsc clean. |
| 3 | **Implemented** (2026-06-21) | Content-hash guard in `kbService.upsertDocument` (skip delete+re-ingest+re-embed when title+text unchanged ⇒ no-op updates + backfill re-runs are free). `backfillStrategyKb` / `backfillPriorityMatrixKb` (reconciling sweeps) + `POST /{strategy,priority-matrix}/reindex-kb` (workspace:write + toggle-gated). `planning-kb-backfill.test.ts` (4 cases: guard via `createdAt` preservation, both backfills, gating); 180 tests green; tsc clean. **+ Auto-backfill (2026-06-22):** both indexers' `getOrCreateCollection` + the board-share `ensureCollection` run the backfill on first collection creation, so existing items are indexed with no manual route call (re-entrant-safe + idempotent); 2 added test cases. |
| 4 | **Implemented** (2026-06-21) | FE transparency: `managed` surfaced on `KbCollection` + the shared `KnowledgeCollection` type; **synced badge + suppressed hand-edit + `<Notice>`** on managed collections in `KnowledgeBasePage` and the shared `CollectionCard` (covers Subject + Agent knowledge panels); **"Indexed for agents" / "Private · not shared"** cue on `StrategyPage` (positive cue gated on `kb` enabled). All `ui/` primitives (`.chip`/`<Notice>`/`LockIcon`/`FlagIcon`), i18n across en/es/fr/pt-BR. FE build green (tsc + token + `check-i18n` + 0 `:is()`); `/ux-review` + `/browser` static clean. **+ (2026-06-22):** the deferred PM-list-page cue shipped — a kb-gated "Indexed for agents" `BookOpenIcon` indicator on non-project list tabs in `PriorityMatrixPage` (i18n ×4). |
| 5 | **Implemented** (2026-06-21) | `advisoryBoardKnowledgeService.ts` (`getBoardSharedKnowledge` / `setBoardSharedKnowledge` — bind the managed collection to EVERY advisor via `bindCollection`, which also grants the `knowledge` capability; ensures the collection exists so a board can pre-share) + `GET`/`POST /advisors/boards/:id/shared-knowledge` (getBoardView RBAC + `workspace:write`). FE: a **"Shared knowledge"** toggle-chip control per board card in `AdvisoryBoardPage` (kb-gated, `aria-pressed`, i18n ×4). `advisory-board-knowledge.test.ts` (3 cases); 67 advisory/agent-knowledge/kb tests green; FE build green. **+ Project KBs (2026-06-22):** a third `project` kind binds the union of the org's `org`-visible project KB collections (ADR 0042) to all advisors (private projects carved out); `SHARED_KB_KINDS` + `isSharedKbKind` guard + set-valued resolve/bind; FE chip + i18n ×4; 2 added test cases (share + private carve-out); 202 tests green. |
