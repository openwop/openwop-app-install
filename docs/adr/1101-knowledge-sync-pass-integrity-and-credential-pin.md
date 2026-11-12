# ADR 1101 — Knowledge sync: a pass that respects a pause, the bound credential pinned, and teardown that removes what it made

**Status:** implemented (2026-11-11, on branch `fl2-90/knowledge-sync`; Accepted after the adversarial `/architect` pass, corrections folded in before code)
**Date:** 2026-11-11
**Extends:** ADR 0107 (knowledge-sync sources), ADR 0605 (destructive diff, confused deputy, scheduler), ADR 0681 (route gate coverage). Toggle `knowledge-sync` is unchanged (default OFF, `bucketUnit: tenant`).
**Composes:** ADR 0627 D5 (exact connection pin), ADR 0832 (run-lane org floor), ADR 0815 (member-removed schedules, by analogy), the gmail-sync twin's `WF-CRM-1` (archive, never delete), RFC 0135 (`internal` chains).
**Decision source:** feature loop row 90. The grade is `docs/steward/workflows-assessment/2026-11-11-knowledge-sync-row90.md` (`KS2WF-1..12`, `KS2CD-1..6`, `KS2UX-1..9`). Prod facts (Q1–Q8, 2026-11-11): the feature is latent, with 0 sources, 0 runs, 0 jobs and 0 synced documents. Nothing needs migrating.
**RFC verdict:** host-extension only. No new RFC. Every route lives under `/v1/host/openwop-app/knowledge-sync/*`. The chain change is the RFC 0135 `internal` flag, which is presentational. The run node's contract does not change.

## Context

Round 1 (ADRs 0605 and 0681) made the destructive diff honest and moved the recurring sync onto a real chain. It graded the shape of the lane. This pass graded what the lane does to state while a pass is running, and which credential and which authority it actually uses. Two Blockers sit there.

1. **A pass undoes a pause made while it runs (`KS2WF-1`).** `syncNow` writes its outcome as `statusAfterPass(source.status, …)` with the `status` it read when the pass *started*. A Pause, a revoke-pause or a DSAR pause that lands mid-pass is therefore written back to `active`, its `pausedReason` is deleted, and the scheduler job is re-enabled. The prune phase never re-checks either. ADR 0605 R1 HIGH 3 fixed this for a pass that *starts* paused. This is the same invariant, broken through a stale argument instead of a stale branch. The root is `KS2CD-1`: no mutator of the source row is a CAS.
2. **The pass does not use the connection the source is bound to (`KS2WF-2`).** The runner turns `source.connectionId` into an *identity* (`conn.userId`), and every brokered call then resolves a credential through the user → org → workspace fall-through. When the bound token stops being `active`, the pass silently reads the folder as the org's or the workspace's account. A "complete" listing under that account's permissions prunes every document the bound user could see and that account cannot. The broker already supports an exact pin (ADR 0627 D5), and the gmail twin uses it.

Around them:
- The person a pass acts as is never re-checked for membership (`KS2WF-3`).
- A person-started run has no write floor on the source's org (`KS2WF-4`).
- The scheduler-only chain is offered in the gallery (`KS2WF-5`).
- Deleting a source leaves its workflow live in `/builder` (`KS2WF-6`).
- Deleting a source also leaves every synced document behind (`KS2WF-7`).
- Prune reports deletions it did not make (`KS2CD-6`).
- In the panel, viewers are offered every write and errors arrive in server English (`KS2UX-1`, `-2`).

### Boundaries audit

| Concern | Owner | This ADR |
|---|---|---|
| Source row, cursors, pass orchestration | `features/knowledge-sync` | all edits |
| Credential selection | Connections broker (`selectPinnedConnection`) | **no change**. The sync lane passes the pin `brokeredFetch` already accepts |
| Provider listing and fetch | `host/knowledgeSourceFetch.ts` | `KnowledgeFetchDeps.connectionId?`, threaded into the existing `egressDeps` (additive, optional) |
| Run-lane org floor | `host/accessControlService.ts` `assertRunScopeOrg` / `assertRunOrgScope` | called, not changed |
| Workflow lifecycle (archive) | `host/workflowLifecycle` + `workflowsRegistry` + `workflowOwnership` | called with the gmail twin's shape |
| KB document delete | `features/kb` `deleteDocument` | called, not changed |
| Panel | `frontend/react/src/features/knowledge-sync` (lazy, inside `KnowledgeBasePage`) | all FE edits; `KnowledgeBasePage` passes two props |

## Decision

> **Revised before code by the adversarial `/architect` pass (2026-11-11).** The first draft had 2 Blockers and 7 Highs in its own text. They are folded in below, and § Corrections lists what changed and why. The pattern was the familiar one: two decisions reintroduced, one level up, the defect classes this ADR exists to close.

### D1 — One CAS for the source row; the lease is taken against the row the claim was computed from; the outcome is decided on the fresh row (closes `KS2WF-1`, `KS2CD-1`)

- **`mutateSource(tenantId, id, fn)`** is the only writer of `knowledge-sync:source`.
  - It reads the row and applies `fn` to a **`structuredClone`** of it. `compareAndSwap` compares serialised bytes, so a mutated `expected` would make every swap fail (the `mutateJob` shape, `schedulingService.ts:552-561`).
  - It **never inserts**: a missing row returns `null`, never `compareAndSwap(null, …)`.
  - On a lost swap it re-reads and retries, up to 4 times.
  - Exhaustion throws **`write_contention`** (503), never a 409. The surface maps only the named 409s to a skip, so contention cannot pass for "skipped".
  - Scheduler-job side effects (`updateJob` enabled) run **after** the winning swap and are reconciled from the row just written. Calls landing out of order can therefore no longer leave an `active` row with a disabled job.
  - `setSyncStatus`, `updateSyncSource`, `setSyncJobId`, the revocation pause and the DSAR eraser all move onto it.
- **The lease is the claim, atomically.** `syncNow` computes the claim key from row R (`syncStateVersion`). It then takes the lease with ONE `compareAndSwap(R, R + {syncStartedAt: stamp})`. A lost swap aborts with the in-flight 409 (the version rotated, so nothing wedges). The pass then runs on the leased row, not the stale read.
- **The terminal write is decided on the fresh row, inside the mutator:**
  - If `fresh.syncStartedAt !== stamp`, the row now belongs to a newer pass (this pass outlived its lease). The pass writes **nothing**, only a log line. This narrows `KSWF-20`; it does not close it.
  - Otherwise `status = statusAfterPass(fresh.status, outcome)`. `consecutiveFailures`, the terminal decision, `lastError`/`lastErrorCode` and `nextAttemptAt` are all computed from `fresh`. A pause made by any lane at any time survives the pass.
  - The terminal write sits **outside** the try that classifies the pass's outcome, so a failed bookkeeping write never re-classifies a successful pass as a failure.
- **Re-check before destroying.** Before the prune phase, and again every 50 prunes, the runner re-reads the row. It skips the rest of the prune (`pruneSkipped: 'changed'`) if the row is gone, or if any of these differ from the leased row: `status`, `pausedReason`, `createdBy`, `connectionId`, `collectionId`, `externalFolderId`, `includeMedia`. Comparing fields, not only "was it paused", catches an erasure or a revocation that lands on a source that was *already* paused under a user's Sync-now override. The eraser and the revoke hook skip already-paused rows, so a status-only check would miss them.
- **Deleted mid-pass.** If the row is gone at the terminal write, the pass removes the cursors and documents it wrote (same deletion rules as D6). Together with D5's post-delete sweep, this closes the reachable half of the Tier 2 orphan residual.

### D2 — The sync lane pins the bound connection (closes `KS2WF-2`)

- `KnowledgeFetchDeps` gains `connectionId?: string`. Every `brokeredFetch` call in `host/knowledgeSourceFetch.ts` forwards it as the call's `connectionId` option (`brokeredEgress.ts:220`), which reaches `selectPinnedConnection`: the exact row or nothing. That means no fall-through, a `status_*` refusal on a non-active row, `not_owner` for someone else's user row, and a pinnable workspace row (ADR 0783 D3).
- The runner and the browse route both pass the connection they validated.
- A **source-walking ratchet** asserts that every `brokeredFetch(` in that file passes the pin through from `deps`. It is sabotage-witnessed, because a missed site falls through silently. Callers without a pin (agent-knowledge's connection ingestion) are unchanged.
- **Fail-fast before egress:** a bound connection that is not `active` produces the typed `connection_unusable` whole-run failure, with backoff.
- **Org-shared rows (no `userId`, with `orgId`) are refused at create** with a 400 that says to use a personal or workspace connection. They never synced: the actor is the tenant id, which holds no `connections:use`, both before and after the pin. Browse worked for them only because browse acts as the requester. Verified sound with the pin: user rows (the actor is exactly `conn.userId`), workspace rows (pinnable; the tenant-id actor is not person-shaped, so `actingUserPresent` passes), and personal tenants.

### D3 — Only the scheduler runs the per-source workflow; the acting person must still have write authority (closes `KS2WF-3`, `KS2WF-4`, and the scheduler "Run now" door)

- **Run lane: the `kb.reindex` structural gate, not a membership floor.** `runOnce` refuses (typed failure, 403, naming neither the expected id nor the source) unless both hold:
  - (a) `scope.workflowId === knowledgeSyncWorkflowId(sourceId)`;
  - (b) the run has **no acting user**.

  A builder run, a `/`-picker run, a gallery copy and a re-executing `:fork` all carry a person, or carry the wrong workflow id, so all are refused. The HTTP "Sync now" (`workspace:write` on the source's org) is the one person lane. This is the `assertReindexWorkflow` precedent (`features/kb/surface.ts:209-225`) and replaces the first draft's org floor. That floor treated an actorless run as tenant-trusted, which the scheduler's "Run now" is.
- **The scheduler's generic doors:**
  - The feature registers a `registerScheduledJobFireGate('knowledge-sync', …)`, with `owns` matching `featureId === 'knowledge-sync'` plus the `ksync:` prefix, `reservedJobIdPrefix: 'ksync:'`, and `managedBy` pointing at the collection's Drive-sync panel. The generic scheduler can then only disable a ksync job, never retarget it, re-enable it or rewrite its metadata.
  - The fire gate's `gate` refuses (`target-refused`) when the registered definition is not the expected shape: exactly one node of type `feature.knowledge-sync.nodes.run`, no edges, `config.sourceId === sourceId`. That closes `KS2WF-8` **for this feature** (an edited definition never fires). The class stays routed.
  - The job carries `metadata.kind: 'knowledge-sync'`, and a `registerScheduledJobReadGate('knowledge-sync', …)` makes it unreachable in the generic scheduler, including "Run now", to anyone without `workspace:write` on the source's org.
- **Pass time (both lanes).** When the bound connection names a person, the runner checks before any egress that `conn.userId`, under any spelling `actingUserIds(tenantId, conn.userId)` returns (home-tenant-only aliasing, ADR 0780 D2), holds `workspace:write` on `source.orgId`. It uses **the same predicate the routes use**: one helper, `holdsOrgScope(tenantId, subjects, orgId, scope)` over `resolveEffectiveAccess`. The pass is never held to a stricter test (for example org-row existence) than the door that created the source.
  - A refusal is a **typed outcome, not a throw.** It is written in the same CAS lane as a pause with `pausedReason: 'creator-no-access'`, and it counts no failure and spends no egress.
  - A membership read that *errors* is an ordinary whole-run failure.
  - A tenant-level connection names no person, so there is no check (ADR 0605's reading).

### D4 — The per-source workflow is host machinery: transient, and archived on delete (closes `KS2WF-5`, `KS2WF-6`, `KS2WF-9`)

- The chain gets `internal: true` (pack and chain 1.0.1 → **1.0.2**). RFC 0135 makes this presentational, not a fence. D3's structural gate is the fence.
- The per-source definition is registered as in `kb.reindex`. `withHostLifecycle({ transient: true, generatedBy: 'knowledge-sync.run' })` plus a `transient` ownership record hide it from `/builder` and the `/` picker, and it stays resolvable by id for runs and replay.
- `deleteSyncSource` archives it (`transient` + `archivedAt`) and never deletes it, so the transient GC (`runRetentionSweeper.ts:192`) reclaims it once its runs have aged out. Runs re-resolve by id, so a hard delete would orphan them.
- The definition's `metadata.name` and the ownership `name` are `Knowledge Sync — <folder>` (D8's `folderName`, else the folder id), so the archive re-stamp keeps it.

### D5 — Removing a source removes what it synced (closes `KS2WF-7` / `KSC-10`, `KS2UX-3`)

The collection is a one-way **mirror** (ADR 0107 OQ-1, resolved 2026-08-31). Ending the mirror ends its copies. "Remove" is a resumable removal:
1. **Refusals.** It refuses with 409 `sync_running` while `syncLeaseHeld`. It refuses while a retention hold is active (`assertNoRetentionHold(tenantId)` inline, the projects/documents shape). It refuses `collection_unreadable` if `getCollection(…, callerSubject(req))` returns null; the cursors are kept, so nothing is lost.
2. **Mark.** Mark the source `paused` with `pausedReason: 'removing'` (CAS). Passes and Resume both refuse a `removing` source.
3. **Delete a bounded batch.** Up to 200 documents per request, each as the deleting member (they hold `workspace:write` on the org, which the route checked). After each document, delete its cursor. Only a *document-level* miss counts as removed: the document row is pre-read, so the missing-document case is distinguished from a collection-gate 404, which aborts. Any other error aborts with the cursor kept.
4. **More left?** Answer **202** `{ removing: true, remaining }`. The panel calls again until done, and a crash leaves a `removing` source that a second Remove continues.
5. **Last batch.** Delete the job, archive the workflow (D4), delete the row, then **re-list cursors and sweep until empty**. That catches anything a lease-expired pass wrote. Answer **200** `{ deleted: true, documentsRemoved }`.

Removal is silent per document (the prune lane's posture), with no new event payload shape. `GET` lists carry `syncedDocuments` (the cursor count) so the confirm can say what will go.

> **Corrected during implementation (2026-11-11):** the line above first said removal "gets its own `destructive-lane-census` row". It cannot. That census DERIVES its population from function names (`sweepExpired*`, `__run*Once`, `purgeTenant*`) and from calls of terminal primitives (`deleteAllTenantData`, `pruneOnceByPrefix`, …). `removeSyncSource` matches neither, and the census fails on a row it did not derive ("an extra row is stale"). So the hold is asserted inline, and a behavioural witness holds it instead: `knowledge-sync.test.ts`, "Remove honours the tenant legal hold". Widening the census to per-row KB deletes is a census-owner decision, recorded here rather than made by one feature.

### D5b — Rebind: the exit that keeps the mirror (from architect finding 7)

The exit the first draft named for `creator-erased` / `creator-no-access` was "remove and add again". Under D5 that deletes every document and re-mints every `documentId` (`sync:<sourceId>:<fileId>`), so the folder is re-ingested and there is a citation gap. Instead:
- `PATCH /:id { connectionId }` **rebinds** a source that is `paused` or `error` (never an `active` one; pause it first). The connection goes through `requireOwnConnection` and must be the same provider. The route sets `createdBy` to the caller, clears the pause, the retry state and `lastErrorCode`, and keeps the `sourceId`, so cursors and document ids stay.
- The confirm says so: the next sync reads the folder as *you*, and files your account cannot see are removed.
- Resume is offered for `creator-no-access` too, because a restored membership makes the next pass's check pass.

### D6 — Prune counts only real deletions (closes `KS2CD-6`)

Prune treats a document as removed only on a *document-level* miss (pre-read the row; or `not_found` whose details name the `documentId`, never the `collectionId`). A collection-gate refusal (the connection owner lost access mid-pass) ends the prune phase with `collection_unreadable`, keeping every cursor. Any other error keeps that cursor and counts the file as failed.

### D7 — Outcomes a person can read in their own language (closes `KS2UX-2`)

- The row gains `lastErrorCode`, the **cause** only, from a closed enum: `listing_incomplete` (`reason`, `max`), `files_failed` (`count`), `connection_revoked`, `connection_unusable`, `connection_missing`, `connection_owner_changed`, `creator_erased`, `creator_no_access`, `collection_unreadable`, `removing`, and `sync_failed` (the fallback). It also gains `lastErrorParams` (numbers and short tokens only).
- The retry state is **not** a code. It renders from the structured `consecutiveFailures` / `nextAttemptAt` / `status`.
- A clean pass, a Resume and a Rebind clear the code and `lastError`. Today Resume keeps `lastError`, so a resumed source kept saying "reconnect".
- `lastError` stays as the English detail for logs and old clients.
- ~~A census test enumerates every writer of `lastError`, and each must write a code (or clear both).~~ **Corrected during implementation (code re-grade #11):** this is guaranteed structurally rather than by a census. The only code that sets the field is `withError`, which always writes a code or clears both, and `setSyncStatus` defaults an uncoded message to `sync_failed`. The writers it covers are `syncNow` ok and fail, the revoke hook, the eraser, the D3 pause, D2's `connection_unusable`, the runner's throws, provider and `listFolder` failures, and D5's `removing`. The behavioural witnesses are in `knowledge-sync-pass-integrity.test.ts`.
- The panel renders `t('error_<code>', params)` with the raw detail in a "Details" disclosure. The client throws `ApiError` (status plus body, the `CONNUX-3` shape), classified by `classifyHttpError`: forbidden → a permission sentence, 409 → in-flight or paused, anything else → the action's own sentence plus the detail.
- Four-locale parity for every new key.

### D8 — The panel offers only what the host will do (closes `KS2UX-1`, `-4`..`-8`)

- **Writer controls.** `KnowledgeBasePage` passes `showWrites` (`accessPending || canWrite`, the sibling convention: controls render *disabled* while access loads rather than jumping in) and `writesDisabled` (`accessPending || writesLocked`). A reader gets the list, the last-run lines and one read-only note: no Sync now, Pause, media toggle, Remove, Rebind or add form.
- **Polarity:**
  - `active` → Pause;
  - `paused` (user, `creator-no-access`) → Resume;
  - `error` → Resume, which also clears the retry counter. A person re-arming a stopped source starts a fresh count; before this, the next failure was immediately terminal.
  - `connection-revoked` → Reconnect link plus Resume;
  - `creator-erased` / `creator-no-access` / `error` → **Use my account** (Rebind, D5b);
  - `removing` → "Removing…" plus Remove (continue).
- **Labels.** `folderName`, the name picked in the FolderPicker, is accepted at create (cleaned, ≤ 200 characters) and shown instead of the raw id.
- **Layout.** The media checkbox and the FolderPicker move inside the add form.
- **Pending state.** It is per row: only the row being synced is busy, and its Pause and Remove are disabled during its pass.
- **Copy.** `noConnections` names all four providers; "Folder ID" becomes "Folder"; FolderPicker errors become a `Notice` with localised copy. ~~Reconnect becomes a router `Link`~~ (**not done**: the panel's tests render it without a Router, and a full reload of `/access` is a Low; filed).

### D9 — Record honesty

- The toggle description stops claiming hand-uploaded documents are deleted (`KS2CD-2`).
- The `routes.ts` header stops claiming a uniform 404 for no-access (`KS2CD-4`).
- The dead `SyncSource.runId` is replaced by `lastRun.runId`, stamped when the pass ran inside a workflow run (`KS2WF-10` / `KSWF-8`).
- Claim pruning moves behind the spend gate (`KS2CD-5`).
- "CHAN-F1 covers only `ws:`" is partly stale: since 2026-11-07 it also covers declared default workspaces. D3's pass-time check is the authority either way.

### Corrections (from the architect pass, before code)

| # | First draft | Corrected to | Why |
|---|---|---|---|
| 1 (Blocker) | D5/D6 "tolerate only `not_found`" | document-level miss only; a collection-gate 404 aborts | `deleteDocument` throws the same `not_found` for an unreadable collection (`kbService.ts:2171`) as for a missing document (`:2174`). The draft would have reported N removed and stranded all N |
| 2 (Blocker) | D5 pause-then-delete | refuse while leased; `removing` state; post-delete re-list sweep | a running pass keeps ingesting after the cursor listing, and its end-of-pass check can run before the row is deleted |
| 3 | `assertRunOrgScope(conn.userId)` | one shared `holdsOrgScope` helper over `actingUserIds` | a single spelling locks out a legacy `oidc:`-keyed creator, and `assertOrgScope` 404s on a missing org row where the door does not |
| 4 | org floor in `runOnce` | the `kb.reindex` structural gate plus scheduler fire/read gates | scheduler "Run now" fires actorless, which the floor trusts |
| 5 | `internal: true` closes the trigger | presentational only; D3 is the fence | RFC 0135: "NEVER an authz boundary" |
| 6 | `mutateSource` exhaustion → 409 | `write_contention` 503; terminal write outside the outcome try | the surface maps every 409 to "skipped" |
| 7 | exit = remove + re-add | Rebind (D5b); Resume offered for `creator-no-access` | re-adding re-mints every document id and re-ingests the folder |
| 8 | pre-prune "paused now, not at start" | field comparison against the leased row | the eraser and the revoke hook skip already-paused rows |
| 9 | lease via retrying mutator | one CAS against the claimed row; superseded passes write nothing; clone; never insert; job effects after the swap | each was a way for D1 to wedge or to clobber a newer pass |
| 10 | D2 implies org rows sync | refuse org-only rows at create; pin ratchet | they never synced; a missed pin site falls through silently |
| 11 | D5 inline | legal hold inline; bounded 202 batches | new bulk-destruction cascade; 1,000 deletes exceed the `/api` rewrite timeout |
| 12 | "as on the pass lane" events | silent | prune is silent; `document.deleted {count}` would be a new payload shape |
| 13 | `retrying`/`stopped` codes | cause-only code; retry from structured fields; clears on Resume | codes co-occur |
| 14 | D3 refusal thrown | typed outcome in the CAS lane | a throw counts a failure |
| 15 | matrix row 9 | "a fork that re-executes the node" | served forks never call `runOnce` |
| 16 | hide writes while access loads | `showWrites` / `writesDisabled` | sibling convention |
| 17 | name on ownership only | also on `def.metadata.name` | the archive re-stamp reads it |

### Not decided here (routed)

- **`KS2WF-8` (cross-cutting).** Any member who can save a feature-owned scheduled workflow (gmail sync, strategy cadence, …) can make the next fire run arbitrary nodes with no actor, which the ADR 0832 floor treats as tenant-trusted. D3's fire-gate shape check closes it **for knowledge-sync only**. The cure for the class is a scheduler/ownership-seam rule (a feature-owned job binds the definition digest it registered, or such definitions refuse builder saves). Routed to the workflow-builder / scheduling owners.
- **Closing-grade residue (2026-11-11):**
  - The per-row Notices other than the first still carry their own live region, because the shared `ui/Notice` has no non-live mode. Adding one touches an entry-chunk primitive with about 320 B of headroom left, so it is filed for the design-system owner.
  - D3's gate (b) refuses an actor and a causing member (`orgScopeSubject`), but it cannot yet tell the scheduler from any other actorless lane bound to this hidden workflow id, such as a trigger. The full cure threads the firing job's id into `BundleScope`. That is a seam change, so it is routed rather than made here.
- **Filed from the final re-grades (A− / A−, 2026-11-11):**
  - **Code N2:** a speaking pause keeps its message through a clean pass. A `creator-no-access` source whose access was restored, and that then ran a clean "Sync now", stays paused (correct) but still says "no longer has write access" until it is resumed. The fix is to narrow the rule to pauses that landed DURING the pass (row `updatedAt` > stamp).
  - **Code N4, stated, not changed:** boot backfill re-asserts `enabled` from the source status. A ksync job someone disabled through the generic scheduler therefore re-arms at the next deploy while its source is `active`. The panel's Pause is the real switch. Refusing that generic door outright is the follow-up.
  - **Code #11:** D7's census test is struck above. The guarantee is structural, through `withError`.
  - **Fixes without their own witness** (each reviewed, none sabotage-tested): the job-reconcile loop, the `orgScopeSubject` refusal, the strict pre-delete sweep, the lease release on a failed bookkeeping write, the hold on the orphan sweep, rebind with no person, and the boot re-assert.
  - **UX partials and Lows:**
    - Row notices still address a reader with editor actions (softened by the read-only note).
    - Pause, media and Remove use `disabled` while their row is busy, so keyboard focus drops; Sync now uses `aria-disabled`.
    - `refocus` also runs on an incomplete removal.
    - The withheld Sync now has no reason in its title, and `backoff` is unmapped.
    - The open picker sits between Folder and Cadence.
    - Chips carry no icon.
    - The load and connection failure Notices still nest `<details>` in the Notice span.
    - A needs-account row pairs a warning chip with an error Notice.
    - A picked root shows the literal `root`.
    - Nothing was checked live in a browser, in light and dark, at 280–360 px in fr.
- `KSWF-13` (no per-run spend bound), `KSWF-20` (narrowed by D1), `KSU-5/6` (inline "Sync now"), `KS2WF-11` (cron herd), `KS2WF-12` (no org-deletion cascade; D3 turns a deleted org into a clean pause), `KSC-22` (DSAR by email only), and the re-check granularity during a long ingest phase (D1 re-checks before prune only).

## Alternatives weighed

- **D1: keep the read-then-put and re-read `status` just before the terminal write.** Rejected. It shortens the window and leaves it open. The pause route and the pass can still interleave between the read and the put, and so can the eraser and a PATCH. A CAS is the shape every other durable mutator here already uses.
- **D2: check `conn.status === 'active'` in the runner and keep the unpinned broker call.** Rejected. That still lets the broker choose a *different* active connection (an org row, the workspace row), so it fixes the one sub-case read so far and leaves the class.
- **D3: pause sources from an issuer-removed handler, the ADR 0815 shape, instead of checking at pass time.** Rejected as the only mechanism: that signal fires only when the subject leaves the workspace root, not an org, and a missed signal fails open. The pass-time check is the authority. A handler could be added later for promptness, but it is not needed for correctness.
- **D3: stamp `actingUserId: createdBy` on the job, so the run lane, the broker and ADR 0815 all see the creator.** Rejected. Combined with `KS2WF-8`, an edited definition would then run *as the creator*, with their personal credentials. `orgScopeSubject` (narrowing only) is the safe variant, and it belongs to the seam fix.
- **D5: keep the synced documents on removal, or offer "remove and keep".** Rejected. It contradicts the mirror decision, and a kept copy has no cursor, so it can never be updated or pruned. "Import, not mirror" stays the explicit non-goal ADR 0107 OQ-1 named.
- **D7: translate server sentences on the client by pattern-matching.** Rejected: fragile, and it couples the client to English text.

## Feature evaluation matrix (deltas against ADR 0107 / 0605 only)

| # | Dimension | Verdict |
|---|---|---|
| 1 | Feature-package | All logic stays in `features/knowledge-sync`. One additive optional field in `host/knowledgeSourceFetch.ts`. No core seam is changed. |
| 2 | Toggle | `knowledge-sync`, unchanged. Its description is corrected. |
| 3 | Workflow | Same chain, now `internal`. The per-source definition is transient host machinery (the `kb.reindex` precedent), archived on delete and reclaimed by the transient GC. Doctrine still passes. |
| 4 | Nodes | `feature.knowledge-sync.nodes.run` is unchanged (`index.mjs` is not edited; its output contract is unchanged; a new typed failure code rides the existing failure branch). |
| 5 | AI exchange | None. No model reads or writes this lane. Synced text stays `contentTrust:'untrusted'`. |
| 6 | Agents | None. |
| 7 | Public surface | Additive response fields (`syncedDocuments`, `documentsRemoved`, `remaining`, `lastErrorCode`, `lastErrorParams`, `folderName`, `lastRun.runId`, `pruneSkipped`). Create accepts `folderName`. PATCH accepts `connectionId` (Rebind). DELETE may answer 202. Create refuses org-only connections. |
| 8 | RBAC | Only the scheduler runs the per-source workflow (D3 structural gate). The generic scheduler doors are narrowed to `workspace:write` on the source's org. The pass re-checks the actor's authority through the routes' own predicate. The panel hides writes from readers. |
| 9 | Replay | The node stays in the served set; a served fork never calls `runOnce`. A fork that **re-executes** the node carries the forker as actor and is refused by D3's structural gate. Archive-not-delete keeps old runs resolvable. |
| 10 | DSAR / retention | The eraser keeps its semantics, now on the CAS writer. Removal deletes the source's documents (D5), honours the legal hold, and has a census row. No new store. |

## Phases

| Phase | Scope |
|---|---|
| P1 (backend) | D1, D2, D3, D4, D5, D5b, D6, D9, plus D7's row fields and the `folderName` input |
| P2 (frontend) | D7's rendering, D8 |

Both phases ship in one PR (`fl2-90/knowledge-sync`).

## Open questions

- [ ] Should D5's removal be offered as "remove and keep documents" for a tenant that asks? Not without a use case (see Alternatives). D5b's Rebind covers the case that motivated it, keeping the mirror while the person changes.
- [ ] `KS2WF-8` owner and shape (routed).

## Implementation record

| Phase | Commit | Witnesses |
|---|---|---|
| P1 backend (D1–D6, D9, D7 row fields) | `feat(knowledge-sync): pass integrity, pinned credential, scheduler-only run lane, removal (ADR 1101 P1)` | `knowledge-sync-pass-integrity.test.ts` (D1/D2/D3/D6/D7), `knowledge-sync-connection-pin.test.ts` (D2 behaviour + source ratchet), `knowledge-sync-workflow.test.ts` (D3 gate, fire/read gates, D4 transient + archive), `knowledge-sync.test.ts` (D5 removal, legal hold, removing-state guards, Resume re-arm, D5b rebind), `knowledge-sync-connection-owner.test.ts` (org-only refusal) |
| P2 frontend (D7 rendering, D8) | `feat(knowledge-sync): panel offers only what the host will do (ADR 1101 P2)` | `KnowledgeSyncPanel.test.tsx` (reader gating, polarity, codes, Remove count, rebind, per-row busy, removing), `knowledgeSyncClient.test.ts` (202 loop, ApiError), `FolderPicker.test.tsx` |
| Independent re-grades folded | `fix(knowledge-sync): fold the independent code + UX re-grades (ADR 1101)` | The code re-grade's 11 findings and the UX re-grade's 15 findings, closed or filed (§ Not decided here). |
| Targeted-test fixes | `fix(knowledge-sync): targeted-test fixes (ADR 1101)` | A clean pass keeps an instruction-bearing pause that landed during it, which the D1 revocation witness caught in my own first cut. Rebind refuses a caller with no person, which the subject-erasure ratchet caught. |

**Prod:** latent, with 0 sources, runs, jobs, cursors and synced documents (row-90 SQL, 2026-11-11). Nothing to migrate.
**Verification:**
- Targeted backend runs: 10 knowledge-sync files, 64 importers/ratchets/census/steward tests and 9 chain walkers, all green.
- Frontend: knowledge-sync, the ui ratchets, the KB page and i18n, all green.
- tsc: 0 on both.
- Every generator `--check` is current on the rebased base, with no regeneration.
- `ci:quick` is recorded in the PR.
