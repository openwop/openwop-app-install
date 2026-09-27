# ADR 0481 — Builder multiplayer: the workflow collab resource (ADR 0364 P2-3) + gate closure

Status: Accepted (implementation in this ADR's PR)
Date: 2026-07-24
Relates: ADR 0364 (the workflow collab binding — P2-3 are what this builds),
ADR 0335 (the collab transport program + the two enable gates), ADR 0359
(chassis collab + the room/derive doctrine), ADR 0474 (revisions — the derive
pairs recordOwnership+recordRevision), the 2026-07-24 re-assessment
(whitespace item 3: D12 C− while Make/Sim shipped multiplayer).

## The two recorded gates — closure + evidence

**Gate A (pg connection budget, ADR 0335/0478 §4).** The reconciliation
exists: `storage/postgres/index.ts` header records the demo posture
`OPENWOP_PG_POOL_MAX=4 × --max-instances=5 = 20 ≤ ~22` (db-f1-micro), and the
collab lane adds NO new pg connections (fan-out rides the one multiplexed
LISTEN; WS sockets are TCP; room state is in-memory + debounced snapshots on
the shared pool). What was BROKEN was DEPLOY.md: its example commands said
`--max-instances=10` with the default poolMax 10 — 100 connections, 4× the
tier. This PR fixes the examples, states the budget rule beside them
(`OPENWOP_PG_POOL_MAX × max-instances ≤ max_connections − ~3`), and records
the residual honestly: live posture verification (`gcloud run services
describe`) is a deploy-time checklist item — the reconciliation is now
DOCUMENTED-consistent, asserted-live by the pg header note.

**Gate B (two-client canary).** A NODE-level two-client canary drives the
REAL transport end to end: the actual HTTP server + WS upgrade + auth ticket
+ collabServer authorization + collabRoom sync/fan-out, with two genuine
`Y.Doc` clients speaking the y-protocols sync wire — asserting live two-way
convergence, awareness relay, and the id-keyed workflow shape. Combined with
the FE convergence + per-user-undo pins (`workflowCollab.test.ts`), this
discharges ADR 0335's "the unit suites can't drive a live provider" wording.
**Honest residual**: it is not a BROWSER — real-EventSource/WebSocket Origin
handling and cookie-mode auth are exercised only by the canvas lane's prior
e2e (PRs #1741-#1763); a Playwright browser canary for the workflow room is
the recorded `ci:full` follow-on, and the toggles stay OFF until it runs —
which coincides with ADR 0364 P4 (toggle flip) being a product decision
anyway.

## Decision

1. **Resource registry, one room (extend, never fork).** `collabServer`'s
   path gains a second lane (`workflow-collab/:workflowId` beside
   `canvas-collab/:canvasId`); room ids are namespaced (`wf:<workflowId>`)
   so the two resource kinds can never collide in the room map, leases,
   snapshots, or seed claims. `collabRoom` stays the single implementation:
   `RoomMeta` gains `resource?: 'workflow'`; the derive dispatches to a
   registered **resource driver** (`registerCollabResourceDriver`) under the
   SAME 5-minute floor + evict-force + validate-gate discipline; all
   canvas-specific branches (extwrite reapply, invalidation reseed) are
   inert for workflow rooms by construction.
2. **Authorization** (workflow lane): Origin allowlist → ticket
   (`wf:`-scoped) or session cookie → `realtime-collab` toggle → the NEW
   `workflow-collab` toggle (default OFF — the P4 product knob) →
   `getOwned(tenantId, workflowId)` uniform 404 → refusals for RESERVED
   public namespaces (`wf.seed.*`, `tmpl.*`, `openwop-app.*`) and
   **chain-backed definitions** (their head derives from chains — a CRDT
   room would mint a second author) → the shared per-tenant connection cap.
   Ticket + claim-seed sibling routes mirror the canvas lane's uniform-404
   chain.
3. **The derive contract — no server-side serializer.** The room doc carries
   the BUILDER document (the ADR 0364 shape: id-keyed `nodes`/`edges` +
   root scalars). Clients additionally write their FE-serialized
   `WorkflowDefinition` to a `definition` root scalar on their autosave
   cadence (debounced, LWW — any converged client serializes equivalently,
   and every room member is an authorized editor with identical REST save
   authority, so the scalar grants nothing new). The server derive reads
   that scalar, `validateWorkflowDefinition`-gates it (failing ⇒ SKIP —
   stale beats invalid), then writes the head through the full save trio:
   `registerWorkflow` + `recordOwnership` + `recordRevision(createdBy:
   'collab')` — the ADR 0474 pairing ratchet holds at the derive site.
4. **Authority seam (the D2 lock/derive doctrine).** While a workflow room
   is live (`hasLiveRoomGlobal('wf:<id>')` — cross-instance leases), the
   room is the head's ONLY writer: REST save, rollback, AND the lifecycle
   verbs return a typed 409 `workflow_room_live`. The builder client
   SUSPENDS its debounced autosave on room join (store flag +
   `cancelPendingBackendSync`) and resumes after leave; room teardown
   force-derives first (the evict discipline), so the head is truthful the
   moment the session ends.
5. **P3 — the live store adapter** (`builder/collab/` + BuilderShell):
   dynamic-import `collabDocBinding` (the yjs bundle rule); while a room is
   live, builder mutations flow through `binding.set/replace`; the solo
   snapshot undo stacks are CLEARED on join AND leave (a stale pre-room
   snapshot restoring over post-room state is the known M4 class) and ⌘Z
   routes to the per-user `Y.UndoManager`; presence rides the awareness
   channel (the D5 pattern): peer chips in the toolbar + node-anchored
   selection markers, join/leave announcements coalesced for a11y. The
   adapter NEVER order-normalizes writes (the workflowCollabShape known
   limitation — pinned by a parity test).
6. **Deletion hygiene**: `onWorkflowDeleted` prunes the `wf:` room snapshot
   + seed claim (the canvas onCanvasDeleted mirror).
7. **No RFC** — host-ext transport + routes (the 0359/0364 precedent).

## Alternatives weighed

- **Server-side derive from the collections** (materialize builder nodes →
  serialize to a definition on the backend): rejected — it duplicates the
  FE serializer server-side; the two would drift (the exact two-systems
  failure the architecture contract names). The `definition` scalar keeps
  ONE serializer.
- **Client-side derive via lock-holder REST saves**: rejected — reintroduces
  a privileged writer among equal peers and races the 409 lock.
- **Enabling the toggles in this PR**: rejected — P4 is a recorded product
  decision, and the browser-canary residual (Gate B) counsels OFF.

## Open questions / follow-ons

1. Playwright two-browser canary in `ci:full` (the Gate B residual) —
   before any production toggle-ON.
2. Comments pinned to nodes (0364's P3 sibling) — not in this PR.
3. Live gcloud verification of the deployed pool posture — the deploy-day
  checklist item recorded in DEPLOY.md.

## Review fold-in (both rounds applied in this PR)

Code review (4 HIGH + 6 MED, all folded):
- **H1** — the workflow seed claim was never deleted (the ADR §6 claim was
  false): a recreated id's rooms would get `seed:false` forever with no heal
  path, and the FE joiner would materialize the empty room over the user's
  real workflow. `onWorkflowDeleted` now deletes claim + snapshot (tenant-
  keyed via the deletion hook's tenantIds; field-scan fallback), and the FE
  bails out of an empty-room + seed:false join instead of applying blank.
- **H2** — DELETE and the transient-draft retention GC were not room-locked
  (a delete destroyed the Y.Doc under connected editors whose autosave was
  suspended — silent total loss), and the derive had a delete-resurrection
  TOCTOU. DELETE 409s like the sibling verbs; the GC skips room-live drafts;
  the derive re-checks ownership AFTER registerWorkflow and tears a raced
  resurrection back down.
- **H3** — three head-writers bypassed the D2 lock: the workflow-author
  persist tool (now a typed refusal the agent can relay), the strategy
  cadence re-register (skips + warns while live; the schedule still updates),
  and the compose-tool draft archive (defers; the expiry sweep retries).
- **H4** — Run was broken during a session (the pre-run REST register 409'd):
  while live the FE skips the register and runs the last session-derived
  head, with an honest staleness toast.
- **M1** — the derive now enforces `assertNoDisabledPacks` (extracted to
  `host/packEnablement.ts`, shared with the route — the ADR's "the scalar
  grants nothing new" claim is now true). **M2** — the derive passes the
  denormalized lifecycle flags (omitting them cleared Draft/archived from
  the ownership row). **M3** — the client's serialized lifecycle is stripped
  unconditionally before the head's is reapplied. **M4** — adapter destroy
  is exception-safe (collabLive can no longer strand true = autosave
  permanently dead). **M5** — the remote-materialize path carries the same
  wrong-workflow guard as the flush paths. **M6** — the 409 lock renders as
  an honest warning-register banner, not the generic save-failure error.

UX review (3 HIGH + 6 MED, all folded): the 409 banner contradiction (H1 —
the half-truth-banner class), aria-pressed dropped from the label-swapping
action pair (H2), peer keys by clientId (H3 — the two-tab duplicate-name
collision), +N overflow after 3 peer dots, peer names in the chip aria,
warning-register failed chip with short copy, instant 'connecting' feedback,
single-announcement policy (chip role=status dropped; transitions ride the
live region), name-hash-stable peer colors, pagehide flush, DESIGN.md row.

## Recorded residuals (honest)

- The canary is single-process: cross-instance fan-out is exercised by the
  resource-agnostic canvas suites, not the workflow canary. Named alongside
  the browser-canary residual as pre-enable follow-ons.
- Legacy dual-ownership rows (the pre-ADR-0440-P4 edge) would share one
  room across tenants with last-joiner meta attribution (code L1) — the
  same edge every other surface defends by purge; recorded, not fixed here.
- The ADR 0440 P2 removed-node disclosure is absent from the collab lane
  (code L2); `recordRevision(createdBy:'collab')` drops per-user
  attribution (code L3) — both recorded follow-ons.

## Implementation record

This PR: resource registry + workflow lane (server) + derive driver +
REST/rollback/lifecycle 409 lock + deletion hygiene + node two-client canary
+ FE adapter (room client, autosave suspension, undo swap, presence chips +
node markers) + Gate A DEPLOY.md reconciliation + i18n ×4 + tests.
