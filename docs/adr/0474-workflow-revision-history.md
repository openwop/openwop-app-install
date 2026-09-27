# ADR 0474 — Workflow revision history: content-hash revisions, run pinning, publish=pin, rollback

Status: implemented (P1a #2466 + P1b, 2026-07-23)
Date: 2026-07-23

| Phase | PR | Landed |
|---|---|---|
| P1a store + pins + publish/rollback/history + FE | #2466 | + adversarial-review fold-in (H1 fork-honesty persisted pre-insert; H2 lifecycle-safe rollback; M1 spoof-strip; M2 child revisions; M3 daily-spare prune; M4 autosave-race cancel; M5 tenant-filtered history) |
| P1b published-launch resolution | (this PR) | production launches (POST /v1/runs, starter, triggers, kanban, MCP, **sub-workflow children + CRM triage — review F1/F3**) resolve `publishedRevision`-when-present; the builder's test-run AND the ADR 0473 approve dispatch (approve-what-you-see hashes the HEAD — review F2) opt into the head via `launch='draft'`; every launch stamps `run.metadata.launchResolved` (host-reserved key — review F5); the scoped list + dashboard surface `publishedBehindHead` |

> **P1b decisions (review fold-in):** (F4) `metadata.launch='draft'` is NOT
> permission-gated within a tenant — publish is a LAUNCH-SEMANTICS gate, not a
> security boundary (identical authority to pre-P1b behavior; scope
> enforcement is opt-in host-wide). Revisit if per-workflow editor RBAC lands.
> (F6) the `/` picker draft badge is DEFERRED to the Phase-2 UX pass — the
> dashboard "Unpublished changes" chip covers the owner surface where edits
> happen; the picker pipeline is a separate render path not worth forking the
> P1b review cycle for.

> **Correction (found during ADR 0475 P2a, fixed on that branch):**
> `resolveLaunchWorkflow`'s ownership read threw when host-ext persistence was
> not initialized, and the sub-workflow child lane (F1) propagated it — every
> executor-arm dispatch test (RFC 0118/0126, ADR 0255 winback) spawned ZERO
> children after P1b merged. Since F4 records that the published pin is a
> launch semantic and not a security boundary, an unreadable ownership/
> revision store now degrades to the HEAD (try/catch → head fallback) instead
> of blocking the launch. The dispatch executor-arm suites are the witnesses.
Lane: cross-cutting seam (workflow catalog lifecycle — extends ADR 0369/0163) — NO new
feature package, NO new toggle (the seam is inert until a tenant edits a workflow)
RFC verdict: **host work only, no new RFC.** Revision rows are a host-ext
`DurableCollection`; the run pin rides `run.metadata` (the ADR 0001 correction
pattern — durable, fork-copied, never re-resolved); history/rollback routes are
non-normative `/v1/host/openwop-app/*`. Nothing on the OpenWOP wire changes; the
normative runs/replay/fork contract is strictly STRENGTHENED (a pinned run
re-resolves the exact definition it ran, where today it re-resolves a mutable head).

## Why this exists

Phase 1 of `docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md` (2026-07-23):
run-pins-version became universal table stakes across every product family in
the last 12 months, while here tenant definitions have **no revision history**,
runs **re-resolve by id** (`routes/runs.ts:193`, `:1095`), and ADR 0387
environments **explicitly defers** workflow pins for want of "content-hash-
versioned" templates (`docs/adr/0387…:79`). Compound effect: *"edit a live
workflow" has no safety net* — the market's #2 complaint class (n8n's pre-2.0
defect, ServiceNow update-set fragility, Dify's lost drafts) live in this app.
ADR 0473 already proved the primitive: `definitionHashOf` pins what a reviewer
approved; this ADR makes the same primitive universal.

## Boundaries audit (seam enumeration, 2026-07-23 — file:line verified)

- **Write sites**: `registerWorkflow` has 18 callers; only the TENANT-CONTENT
  writes revision (builder save `routes/workflows.ts:343`, from-chain `:548`,
  workflow-author persist `workflowAuthorService.ts:202`, compose/propose
  `workflowComposeTool.ts:164`, walkthrough author `walkthroughAuthorTool.ts:99`,
  strategy cadence `cadence.ts:108`, sub-chain children via the from-chain
  `register` closure — review M2).
  > **Correction (P1a review):** gmail sync (`gmailSyncService.ts:120`) was
  > listed here but registers an UNOWNED system definition (no ownership row)
  > — it is allowlisted, not revisioned, per the "revisions pair with
  > ownership" rule. Sub-chain CHILDREN, initially missed, ARE owned and now
  > get their first revision (review M2).
  Boot/seed registrations and the chain-backed module registry
  (`chainBackedWorkflows.ts:145` — its own registry, already chain-versioned)
  are EXCLUDED by design. Lifecycle verbs (`workflows.ts:431`,
  `workflowComposeTool.ts:377`) patch only `metadata.lifecycle` — the
  lifecycle-stripped hash makes their re-registers a same-key upsert (no noise).
- **Run-create choke point**: `insertRunWithStartContext` (`host/runInsert.ts:25`,
  ADR 0099) is called by all 12 creator seams; its never-overwrite rule
  preserves fork-copied stamps. Three documented bypasses (anon ×2, workforce
  eval — synthetic ids) fall back to head-resolve, no worse than today.
- **Re-resolve sites**: fork `routes/runs.ts:1095`, dispatch sweeper
  `runDispatchSweeper.ts:88`, interrupt resume `routes/interrupts.ts:840` — the
  ONLY mid-lifecycle re-resolves (the executor never re-resolves; it receives
  the def). All route through `hostSuite.workflowCatalog.getWorkflow`.
- **Delete cascade**: `deleteRegisteredWorkflow` (`workflowsRegistry.ts:99`) has
  5 callers (DELETE route, transient GC, 2 seed teardowns, tenant purge) — the
  revision cascade lives INSIDE it so all inherit.
- **No collisions**: `grep definitionRevision|revisionHash|publishedRevision` —
  zero hits repo-wide (greenfield). No existing revision/version store for
  runtime defs (chain packs carry pack versions; different layer).

## Decision

### 1. `revisionHashOf` — the lifecycle-stripped content hash
`host/definitionHash.ts` gains `revisionHashOf(def)` = `definitionHashOf` over
the definition with `metadata.lifecycle` REMOVED. Archive/unarchive/promote
change lifecycle only ⇒ same revision hash ⇒ no noise revisions (the ADR 0473
false-edited-chip lesson, made structural). `definitionHashOf` (full) remains
the ADR 0473 approve-what-you-see pin — different question ("what did the
reviewer see", lifecycle included) — both documented side by side.

### 2. The revision store — `host/workflowRevisions.ts`
`DurableCollection('workflow:revision', key = ${workflowId}:${revisionHash},
tenant extractor)`. Row: `{key, workflowId, tenantId, revisionHash, definition
(full JSON as registered), name?, nodeCount, createdAt, supersedes? (the prior
head's revisionHash — the ordering chain)}`. `recordRevision(tenantId, def)` is
UPSERT-idempotent (same content ⇒ same key ⇒ no-op refresh). Called beside
`recordOwnership` at the 7 tenant-content write sites. A SOURCE-SCAN test (the
`agent-prompt-tool-ids.test.ts` pattern) asserts every `registerWorkflow(`
call site is either paired with `recordRevision` or on the explicit allowlist
(boot/seed/lifecycle/test) — a new write path cannot silently skip history.

### 3. Run pins its revision — `run.metadata.definitionRevision`
`insertRunWithStartContext` gains an optional `definition` argument; when
present it stamps `definitionRevision: revisionHashOf(def)` (never
overwriting — fork-copied metadata keeps the ORIGINAL pin). All 12 seam
callers pass the definition they already resolved. Replay/fork/resume resolve
through a new shared helper `resolveRunDefinition(storage-free)`:
**pinned revision row if stamped + present, else the catalog funnel by id**
(legacy runs + pruned revisions + bypass runs degrade to today's exact
behavior — never worse). Wired at the three re-resolve sites (fork, sweeper,
interrupt-resume).

> **Correction (P1a-2 implementation):** the original draft surfaced
> `resolvedFrom` on the FORK RESPONSE — but `ForkRunResponse` is a normative
> wire type (`@openwop/openwop`); extending it is an RFC-gated endpoint-contract
> change (TypeScript's excess-property check caught it). The honesty surfaces
> HOST-SIDE instead: the fork stamps `run.metadata.definitionResolvedFrom`
> (`'revision' | 'head'`), and the run-detail chip reads it from the host
> projection. Same visibility, zero wire change.

### 4. Publish = pin, rollback = re-register
- `WorkflowOwnershipRecord` gains `publishedRevision?: string`; the promote
  verb (`workflows.ts:416-434`) stamps it with the head's revision hash
  (in addition to clearing `transient` — ADR 0369 semantics unchanged).
- **Rollback**: `POST /v1/host/openwop-app/workflows/:id/rollback
  {revisionHash}` — owner-gated (the lifecycle-verb IDOR pattern), loads the
  revision row, re-registers it as head via the SAME validated write path as
  the builder save (validation + write-guard + removed-node disclosure +
  recordRevision — rollback itself appends a revision; history is append-only,
  never rewritten).
- **History reads**: `GET …/workflows/:id/revisions` (owner-gated list, capped
  page) returning `{revisionHash, createdAt, name, nodeCount, supersedes,
  published: bool, isHead: bool}`.
- **P1b (second PR): published-launch resolution.** Non-draft launch surfaces
  (POST /v1/runs default, schedules, agent dispatch) resolve
  `publishedRevision` when set and the head has moved; the builder's test-run
  passes `launch: 'draft'` to run the head. Default = published-when-present
  (the n8n 2.0 semantic). Scoped to its own PR because it touches every launch
  surface's semantics + needs its own UX (draft badges on the `/` picker).

### 5. Growth bounds + cascades
- Cap: `OPENWOP_WORKFLOW_REVISIONS_KEEP` (default 50) per workflow, pruned
  opportunistically on `recordRevision` (the `pruneResolved` pattern,
  `approvalService.ts:2000-2013`). NEVER pruned: the published revision, the
  current head. A pruned revision pinned by an ancient run degrades that run's
  re-resolve to head-by-id — exactly today's behavior, stated on the run.
- `deleteRegisteredWorkflow` cascades revision rows (all 5 delete callers
  inherit — GC, teardown, DELETE route, seeds).
- Tenant teardown reaches revisions via the tenant extractor (the hostext walk)
  + the `purgeTenantOwnedWorkflowDefs` def cascade (ADR 0473 D1 discipline).

### 6. Frontend (Phase 1a)
- Builder **History drawer** (toolbar): revision list (relative time, name,
  node-count delta vs `supersedes`, `Published`/`Current` chips), per-row
  **Restore** (confirm + preview counts — the BULLETPROOF BAR: preview before
  destructive-adjacent action; restore is itself undoable since history is
  append-only), i18n ×4.
- Run detail: a revision chip (`rev abc123…`, `as-run` vs `head-moved` state)
  — the visible half of the pin.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | None — core catalog seam (`host/workflowRevisions.ts`, routes in `routes/workflows.ts`) |
| 2 | Toggle | None — inert until an owned def is edited; reads are owner-gated |
| 3 | `ctx.<feature>` | None in P1 (a `revisions.list` read op is a natural follow-on) |
| 4 | Node pack | None |
| 5 | Chat envelopes | None |
| 6 | Agent pack | None (the ADR 0473 card MAY later surface revision context — follow-on) |
| 7 | Public surface | None |
| 8 | RBAC | History read + rollback = owning tenant only (the lifecycle-verb guard, 404 posture); revision rows tenant-extracted for teardown |
| 9 | Replay/fork | THE POINT: pinned runs re-resolve their exact definition; unpinned/pruned degrade to today's behavior — strictly monotone improvement |
| 10 | Frontend | History drawer + run revision chip; tokens/i18n ×4; `/ux-review` gated |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| P1a-1 | `revisionHashOf` + revision store + `recordRevision` at 7 sites + source-scan pairing test + cap/prune + delete cascade | backend vitest |
| P1a-2 | run pin stamp (insert seam + 12 callers) + `resolveRunDefinition` at fork/sweeper/resume + `resolvedFrom` surfacing + tests (pinned fork replays OLD def after head edit; legacy run unaffected; pruned pin degrades stated) | backend vitest |
| P1a-3 | promote stamps `publishedRevision` + rollback route + revisions list route + route tests (IDOR, validation, rollback-appends) | backend vitest |
| P1a-4 | FE history drawer + run revision chip + i18n ×4 | FE build + `/ux-review` |
| P1b | published-launch resolution (`launch: 'draft'|'published'` knob, default published-when-present) + `/` picker draft badges | backend vitest + FE build + `/architect` |

## Alternatives weighed

1. **Hook revisions inside `registerWorkflow`** — rejected: 18 callers include
   boot/seed/synthetic registrations that must not version; the registrar has
   no tenant context; explicit `recordRevision` + the pairing test is
   drift-proof without polluting the one write-through.
2. **Snapshot the definition into every run record** — rejected (as in ADR
   0369): duplicates whole defs per run; the revision store dedupes by content
   hash across runs, and the pin is just a hash on metadata.
3. **Version chain-backed/built-in defs too** — rejected: chains are already
   content-versioned at the pack layer; double-versioning creates two owners
   for one history.
4. **Full-hash revisions (lifecycle included)** — rejected: every archive/
   promote would mint a phantom revision (the 0473 false-edited-chip class).
5. **Ship published-launch semantics inside P1a** — rejected as one PR: it
   changes every launch surface's behavior and needs its own review gate;
   sequenced as P1b, not dropped.

## Open questions

1. OQ1 — should the ADR 0473 proposal card show "proposed against rev X, now
   at rev Y" using this store (richer than the boolean edited-chip)? Proposed:
   yes, as a P1a-4 nicety if free, else follow-on.
2. OQ2 — `createdBy` attribution on revision rows (acting user where known):
   propose stamp-when-available in P1a-1, never required.
3. OQ3 — ADR 0387 environments integration (workflow pins as a config domain)
   is the RECORDED follow-on this ADR unlocks; not built here.

## Correction note — grade-trio fold-in (2026-07-24)

**Re-publish is a first-class verb (grade-ux #1).** As shipped, `promote` was
transient-only, so once a workflow was published its later edits set
`publishedBehindHead` with NO in-app cure but rollback — the dashboard tooltip
even instructed "Publish (Save) again", an action that existed on no surface
("fixes can't reach production", the inverse of the failure this ADR closed).
`promote` on a NON-transient workflow is now a pure re-publish: the same
tested-run + evals-green gates, then `publishedRevision` re-stamps to the head
(no lifecycle change). The builder toolbar shows **Publish changes** whenever
the workflow is published and behind head (state re-checked after each
confirmed autosave).
