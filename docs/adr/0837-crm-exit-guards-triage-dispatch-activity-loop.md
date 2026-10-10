# ADR 0837 — CRM exit guards, a real triage dispatcher, and the activity loop

Status: implemented (feature loop 2026-10 row 23, `feat/fl2-23-crm`; architect pass 2026-10-06 — 4 Blockers corrected in the decision text before code)

Feature loop 2026-10 row 23 (CRM). Extends ADR 0008 (CRM), 0209 (merge/convert),
0272 (territory visibility), 0402 (booking links + e-sign), 0464 (subject erasure),
0567 (activity-based selling, Proposed), 0627 (fork-guarded writes, one-site events),
0819 §6 (variant bindings: "say what is true") and 0832 (the surface org floor).
No new toggle: `crm` keeps its id, default ON, `bucketUnit: tenant`.

## Context

The row-23 workflow grade (`docs/steward/WORKFLOWS-ASSESSMENT.md` § CRM row 23, ids
`CRM2WF-`) re-measured round 1's A− at `869ac06bf` and found the chain layer clean:
the 14 writer nodes are side-effect and in the fork floor, there is one emit site per
transition, and the host-event catalog is closed-world. A parallel exit sweep of the
same baseline found what the chain layer does not cover. The competitive backlog
(`docs/research/crm-gap-analysis.md`, `docs/steward/UX_UPGRADE-crm-console.md` R2)
names activity-based selling as the largest remaining capability gap against the
leader set. ADR 0567 designed it on 2026-08-14 and nobody built it.

Findings, each re-read in code:

1. **Cross-tenant booking deletion (Blocker).**
   `DELETE …/crm/orgs/:orgId/booking-links/:bookingLinkId` (`bookingRoutes.ts:105`)
   checks the CALLER's org and then calls `deleteBookingLinkCascade`
   (`bookingService.ts:364`). That function deletes `deleteBookingsForLink(id)` FIRST:
   a raw prefix scan `${id}:` over the whole `crm:booking` collection
   (`entities/bookings.ts:68,121`, `listByPrefix` → `kvList`, not tenant-indexed).
   Only then does `svcDeleteBookingLink(tenantId, orgId, id)` check ownership, return
   false, and the route answers 404. The rows are already gone.
   - A booking id is `${bookingLinkId}:${slotMs}` (`entities/bookings.ts:50`), and the
     public claim response and manage view return it. One booking with a victim
     therefore leaks their link id.
   - Link ids are `booking-link:<uuid>`, so `:bookingLinkId = booking-link` makes the
     prefix `booking-link:`, which matches every booking of every tenant.
   - Any `workspace:write` member of ANY org (a personal workspace is enough) can do
     this. No test covers link delete.
2. **The workflow surface asks less than the routes for writes (`CRM2WF-2`, the
   `CMS2WF-2` class).** `crm` registers its surface with no `orgPolicy`
   (`feature.ts:74`), so the ADR 0832 floor asks `workspace:read` of every method,
   including the ten org-scoped writers whose routes need `workspace:write`.
3. **Concurrent merges can lose both contacts or form a cycle.** `mergeContacts`
   (`crmMergeService.ts:104-198`) checks `source.mergedInto` once, outside its CAS
   loop. Only the survivor is compare-and-swapped; `tombstoneContact`
   (`contactsService.ts:743`) is a blind `put`. A←B and B←A at the same time both pass,
   each tombstones into the other, both leave `listContacts`, and
   `resolveContactSurvivor` returns null on the cycle. S merged into two survivors at
   once relinks S's records twice and writes two merge events. `mergeCompanies` has
   the same shape (`:217-260`). `erasure.ts:92` says "cycles cannot arise", which is
   only true without concurrency.
4. **Erased subjects are re-created by unattended lanes.** The forms sink refuses to
   re-create a contact whose subject was erased (`formsSubmissionSink.ts:77-86`).
   `ensureContact` (`contactsService.ts:395-442`), the seam every other unattended lane
   uses (public booking `bookingService.ts:284`, the anonymous widget
   `agentTools.ts:439`, guest checkout `commerce/routes.ts:520`, webinar sync), does
   not check. The booking lane also copies the invitee's free-text note and cancel
   reason into an activity body (`bookingService.ts:276,430`). Erasure keeps activity
   bodies by design (`erasure.ts:306-316`), so the note outlives the erasure.
5. **Territory reads leak linked records.** With territories on, the task and activity
   reads (`orgRoutes.ts:545,586,626`) and the task/activity export (`:521-529`) never
   filter by the linked deal or company's visibility. The writes do
   (`assertLinkedVisible`, `:122`). A rep restricted to some territories reads the
   tasks and timeline of deals they cannot open (`CRM-7` in
   `CODEBASE-ASSESSMENT.md`, open since 2026-09-02).
6. **Smaller exits.**
   - The lead-score route takes `orgId` from the query string and reads that org's
     orders with no membership check (`routes.ts:202-210` → `leadScoreService.ts:45`).
     It stays within the tenant.
   - A booking link's `ownerUserId` is any string from the body (`bookingRoutes.ts:66`,
     `surface.ts:404`). The public page then shows that user's display name
     (`bookingRoutes.ts:200`), and booking notifications go to them.
   - The CSV formula guard is `/^[=+\-@]/` (`csvExport.ts:8`). It misses the leading
     tab and carriage return that OWASP lists (`CRM-17`).
   - `setContactTriage` is a blind read-modify-`put` (`contactsService.ts:657-665`), so
     a triage stamp can overwrite a concurrent contact edit.
7. **The Triage action runs a demo (`CRM2WF-1`).** The contact Triage button launches
   `body.workflowId ?? OPENWOP_CRM_TRIAGE_WORKFLOW_ID ?? 'openwop-app.uppercase'`
   (`routes.ts:509-512`). That is a one-node upper-casing demo pinned in catalog
   source A (`host/index.ts:502`), and it never reads the contact. The variant
   bindings (`feature.ts:87,92` → `feature.crm.nodes.triage` / `triage-enriched`) are
   stamped and never consumed. ADR 0819 §6 deferred this exact dispatcher. The user
   sees "Triage started" and nothing about the contact changes.

## Boundaries audit

- **Single owners.** `contactsService` owns contacts and the find-or-create seam;
  `entities/bookings.ts` and `bookingService` own bookings; `crmMergeService` owns
  merges; `host/crmRecordVisibility.ts` owns territory visibility;
  `host/featureSurfaces.ts` owns the org floor; `entities/tasks.ts` owns tasks;
  `reportService.ts` owns aggregates. Each decision below lands in its owner. No new
  store and no parallel concept.
- **Existing helpers reused.** `filterVisibleCrmRecords` (territories);
  `isErasureTombstoned` (erasure); `orgScopeGranted` (`routes.ts:128`); the
  `FeatureSurfaceOrgPolicy.methodScopes` field (`app-builder`, `cms`,
  `kicktodo-organizations` precedents); `casUpdateContact`; the seed lock's
  insert-if-absent + stale-steal shape (`host/seedLock.ts:40-90`); the chain loader +
  `registerChainBackedWorkflow` (same-id, `hostOwned`).
- **Stage totals already ship.** ADR 0567 §3 ("stage totals") exists today as the
  board's column footer, a currency-grouped sum computed by `formatGroupedSums`
  (`DealsTab.tsx:204-208`, `dealMoney.ts`). It is not rebuilt here.
- **No wire.** Every change is a host-extension route, a host surface or a pack in
  this repo. The triage chain uses existing RFC 0013 chain shapes (params, plain
  edges). No new envelope kind, event type or capability.

## Decision

### D1 — Booking cascade: check, then delete only what was checked (Blocker 1)
`deleteBookingLinkCascade` loads the link with the tenant + org guard FIRST
(`getBookingLink(tenantId, orgId, id)`). If the link is missing, it returns false
having touched nothing. It then deletes only rows that `listBookings(tenantId, orgId,
{ bookingLinkId: link.bookingLinkId })` returns (tenant-indexed and org-filtered), not
the raw prefix scan.

`listBookingsForLink` (the unindexed prefix scan) is kept for the public slot and
daily-cap reads, which receive a link they already resolved. Its result is
filtered to `tenantId === link.tenantId`, so a prefix collision cannot cross a tenant
even there. **The exit guard:** `deleteBookingsForLink` is removed, and the only
delete path takes the resolved `BookingLink`, not an id string. A ratchet test pins
that no `bookings.delete(` call sits outside a function whose parameter is a
resolved link or booking.

### D2 — Surface `methodScopes` for every writer (`CRM2WF-2`)
`crm` registers `orgPolicy.methodScopes` mapping every org-scoped writer to
`workspace:write`. A ratchet derives the writer set from the node pack, as every
surface method a `role:"side-effect"` node calls. Every such method that takes an
`orgId` must be in `methodScopes`. A new writer cannot ship at read tier without
reddening the test.

### D3 — One merge at a time per tenant (finding 3)
Contact merge, contact unmerge, company merge and company unmerge run under a
per-tenant durable lock, `crm-merge:<tenantId>`. This also covers the approval-lane
apply, which calls `mergeContacts`. The lock is a `kvCompareAndSwap` insert-if-absent
with a stale steal after 5 minutes, the `seedLock` shape. That shape is extracted to
`host/tenantOpLock.ts` and `seedLock` delegates to it, keeping its key and message, so
there is one lock primitive rather than two copies.

A busy lock answers 409 `merge_in_progress`. Merges are rare human or steward acts,
so serializing them per tenant costs nothing measurable. Inside the lock the
existing checks are sound: the source is live, the survivor is live, and the survivor
fill is CAS'd. As defence in depth, the source tombstone becomes a CAS against the
row read at the start, and a lost CAS answers 409 rather than writing blind.

### D4 — Erased subjects are not re-created by unattended lanes (finding 4)
- `ensureContactWithOutcome` checks the erasure tombstone (raw and folded spellings,
  the forms sink's probe) before it creates. An erased subject returns
  `{ contact: null, created: false, erased: true }`. Every caller already handles a
  null contact. A tombstone read failure refuses the create (fail closed) and logs.
- The forms sink's inline probe is replaced by the same shared predicate,
  `isSubjectErased(tenantId, email)` in `contactsService`.
- Authenticated member creates (the contact POST route, CSV import, the run surface)
  are unchanged: ADR 0464 lets a member deliberately re-add a person.
- The booking lane no longer copies the invitee's note or cancel reason into the
  activity body. The activity says what happened ("Booked <title> via <slug>",
  "Cancelled by invitee"). The note stays on the booking row, which erasure already
  scrubs.
- The anonymous widget answers an erased subject with the same generic success the
  widget gives an existing contact, so it is not an erasure oracle. No contact id is
  returned in either case.

### D5 — Territory visibility on the linked-record reads (finding 5)
One predicate, `filterRowsByLinkedVisibility(tenantId, orgId, viewer, rows)` in
`orgRoutes`' visibility helpers, drops a task or activity whose `dealId` or `companyId`
the viewer cannot see. Each distinct linked id is resolved once, not once per row. It
is applied at every read exit for tasks and activities: list tasks, get task (404),
list activities, the task and activity export, the surface `listTasks`, and the new
next-task rollup (D8). Rows linked only to a contact stay visible, because contacts
are tenant-scoped. It is a no-op when the territories resolver is off.

### D6 — Smaller exits (finding 6)
- **Lead score:** an `orgId` in the query must pass `orgScopeGranted(…,
  'workspace:read')`, else 404.
- **Booking link owner:** an `ownerUserId` other than the caller must hold
  `workspace:read` in the link's org (`orgScopeGranted`), else `validation_error`.
  This applies on create, on update, and on the surface `createBookingLink`.
- **CSV:** the formula guard becomes `/^[=+\-@\t\r]/`.
- **Triage stamp:** `setContactTriage` uses the contact CAS with one re-read retry, so
  it can no longer overwrite a concurrent edit.

### D7 — `crm-ops.triage`: the variant bindings select real work (`CRM2WF-1`)
- **The chain.** A new chain in `core.openwop.workflows.crm-ops` (1.3.2 → 1.4.0):
  `crm-ops.triage`, params `contactId` (required) and `variant` (`basic` |
  `enriched`, default `basic`). It has three nodes:
  - `load`: new read node `feature.crm.nodes.get-contact`, role `action`, a
    tenant-guarded read that refuses a tombstone.
  - `score`: `feature.crm.nodes.triage` 1.1.0, which takes `config.variant`. The
    existing `triage-enriched` node stays registered for compatibility, with the same
    scoring.
  - `record`: new writer `feature.crm.nodes.record-triage`, role `side-effect`, which
    stamps `{ variant, score, priority, runId, at }` onto the contact through the
    contact CAS.
- **Registration.** The chain is registered chain-backed same-id
  (`registerChainBackedWorkflow('crm-ops.triage', { hostOwned })`), so the route
  resolves a stable id and the chain stays builder-editable and gallery-visible.
- **The route.** It launches `crm-ops.triage` by default. The explicit
  `body.workflowId` and `OPENWOP_CRM_TRIAGE_WORKFLOW_ID` overrides still win, and
  `openwop-app.uppercase` is no longer the default.
- **Binding → param.** The route reads the stamped binding for slot `crm.triage` and
  maps it through a CLOSED candidate set declared beside the toggle in `feature.ts`:
  `feature.crm.nodes.triage` → `basic`, `feature.crm.nodes.triage-enriched` →
  `enriched`. A binding outside the set answers 422 `triage_binding_unsupported`
  rather than silently running `basic`; that is ADR 0819 §6's "say what is true". The
  param is part of the run's inputs. Replay and `:fork` read the run's inputs and
  stamp and never recompute the assignment.
- **The contact list.** The Triage column shows the recorded priority and score once
  the run completes ("High · 85"), and still links to the run. Until then it shows
  "Triage running" for that run id.
- **Docs.** FEATURES.md's multivariant section is corrected: the CRM triage slot is
  now the one wired consumer. ADR 0819 §6 gets a correction note pointing here.

### D8 — The activity loop (implements ADR 0567 D1, D2, D4)
- **Next-task rollup (server).** `GET …/deals` and `GET …/deals/:dealId` gain
  `nextTask: { taskId, title, dueDate } | null`.
  - It is the earliest OPEN task (`open` or `doing`) linked to the deal: dated tasks
    first by `dueDate`, then undated tasks by `createdAt`.
  - It is computed with ONE `listTasks(tenantId, orgId)` pass per request, grouped by
    `dealId` and filtered by D5. There is no per-deal query.
  - `null` is a first-class answer meaning "no next activity", never "unknown".
- **Board markers.** Each deal card shows its next activity (title plus a
  date-relative due label), or an explicit "No next activity" marker.
  - An overdue next task shows a "Rotting" marker. Overdue means `dueDate` is earlier
    than the viewer's local today; `dueDate` is a date-only string, so it is compared
    as a calendar date.
  - A marker is never colour-only: it always has text, plus an icon from `ui/icons`.
  - Won and lost deals show no marker.
- **Close the loop on DealDetail.** Each open task in `DealTasksSection` gets a
  "Mark done" control through the existing `setTaskStatus` client.
  - Completing the deal's last open task focuses the add-task title field, and an
    inline notice reads "No next activity on this deal. Schedule one?". It is an
    offer, not a modal.
  - The notice is announced via the section's live region.
- **Stage totals** already ship (Boundaries audit). ADR 0567 is marked implemented,
  with a correction note recording that §3 pre-existed and that its `dueAt` is
  actually `dueDate`.

## Architect pass (adversarial, decision text, before code) — 2026-10-06

An independent `/architect` pass over D1–D8 found **4 Blockers, 3 Highs and 6
Mediums** in the decision as first written. Each is corrected below. The original
text above is kept, so the reasoning trail survives; **where the two disagree, this
section wins.**

- **A1 (Blocker, D7): the variant and `contactId` never reach the run.** In deferred
  mode, `expandChain` defers only a whole-value `{{params.x}}` in top-level
  `node.inputs` (`workflowChainPackLoader.ts:1424-1437`). Every `config` key is
  substituted from its default at expansion (`:1507-1520`). So `config.variant` would
  bake `basic` in forever. The route also builds its `RunRecord` by hand and never
  seeds the variable bag (`routes.ts:536-561`); only `startWorkflowRun` does
  (`runStarter.ts:198`).
  **Corrected D7:**
  - The chain declares `inputs: { contactId: "{{params.contactId}}", variant:
    "{{params.variant}}" }` on the nodes that need them, and `triage` reads
    `ctx.inputs.variant`.
  - The route launches through `startWorkflowRun({ inputs: { contactId, variant },
    metadata: { crm, featureVariant }, orgScopeSubject: caller })`, which seeds the
    bag, applies the plan's run limit and dispatches durably.
  - `:fork` reseeds from `run.inputs` (`routes/runs.ts:2069-2072`), which is what
    makes "replay reads the run's inputs" true.
  - A real-executor test must show that `enriched` produces the enriched score.
- **A2 (Blocker, D3): the extracted lock lets a third holder in.** `seedLock`'s
  release is a blind `kvDelete` (`seedLock.ts:56-60`), and its value is a bare
  timestamp. If holder X outlives the TTL, Y steals the lock, and X's `finally` then
  deletes Y's lock, Z can acquire while Y is still running.
  **Corrected D3:**
  - The token is `${ms}:${uuid}`.
  - Release is `kvCompareAndSwap(key, token, 'released')`, and acquire treats `null`
    or `'released'` as free. `Storage` has no compare-and-delete.
  - A holder that has lost its lock logs `tenant_op_lock_lost`.
  - The TTL is a parameter: seed keeps 1 h, merge uses 5 min.
  - `seedLock` delegates to the primitive, which fixes its own instance of the bug.
- **A3 (Blocker, D3): the "defence in depth" tombstone CAS creates a half-applied
  merge.** By the time the source is tombstoned, the survivor fill, the relink and the
  email-claim re-point have all committed. The lock does not cover ordinary edits to
  the source (PATCH, identifiers, triage), so a CAS against the row read at the start
  can lose to an edit. Answering 409 at that point leaves a merge nothing can undo.
  **Corrected D3:** `tombstoneContact` becomes a CAS loop on a FRESH read. It sets
  `mergedInto` and keeps concurrent edits, and it aborts only if `mergedInto` is
  already set, which the lock makes impossible.
- **A4 (Blocker, D2): the org-less writers stay unchecked, and matrix row 3 was
  false.** The floor fires only when `args.orgId` is present
  (`featureSurfaces.ts:176`). `createContact`, `updateContactStage`,
  `updateContactOwner`, `persistSegment` and the new `recordContactTriage` take no
  `orgId`, while their HTTP doors need tenant `workspace:write` (`routes.ts:216,256`).
  **Corrected D2:**
  - `FeatureSurfaceOrgPolicy` gains `tenantMethodScopes`. For a listed method, the
    floor calls the existing `assertTenantScope` for the person behind the run: the
    actor, or else the causing member, with the run's `personalTenant`. This is the
    predicate `crm/agentTools.ts:154` and `workflowWriteAuthority.ts:80` already use.
    No person means no check (system runs stay tenant-trusted, the floor's existing
    rule).
  - The ratchet is a closed-world PARTITION of `buildCrmSurface(...)`'s keys. Every
    method must be in exactly one of `CRM_SURFACE_READS`, `methodScopes`,
    `tenantMethodScopes` or `CRM_SURFACE_LANE_INTERNAL` (the gmail-sync helpers,
    whose authority is the owner-bound sync row; see A5). A writer with no node can
    no longer slip through.
- **A5 (High, D2): a gmail-sync permission loss would become silent data loss.**
  Gmail sync runs as `sync.userId`. Raising `logGmailActivity` to `workspace:write`
  throws inside the node's per-message `try`, which swallows it, and the messages are
  then released past the cursor. **Corrected:** the gmail-sync helpers go in
  `CRM_SURFACE_LANE_INTERNAL` and keep the membership floor; they are not raised to
  write tier. Filed as `CRM2-D1`: "a demoted (read-only) member's sync keeps logging
  activities". The cure, a typed self-pause in the node, needs a new closed-world
  `pausedReason`.
- **A6 (High, D5): the task write exits return invisible rows.** `PATCH {}` on
  `/tasks/:id` returns the full row of a task linked to an unseen deal
  (`orgRoutes.ts:598-621`). So do the surface `completeTask` (`surface.ts:369`) and an
  explicit-id `createTask` that returns an existing row (`tasks.ts:121-127`). D8's
  "Mark done" uses the PATCH path. **Corrected D5 (Open Question 2 is decided):**
  task GET, PATCH and DELETE, the surface `completeTask`, and an explicit-id create
  answer a uniform 404 for a task linked to an invisible deal or company.
- **A7 (High, D7): there are two `lastTriage` writers and nothing orders them.**
  **Corrected:**
  - The route stamps `{ variant, runId, at }` at dispatch.
  - `record-triage` writes `{ score, priority }` through a CAS ONLY when
    `lastTriage.runId === ctx.runId`. Otherwise it no-ops with the typed outcome
    `superseded`, so a newer click or a `:fork` (a new run id the route never
    stamped) never overwrites.
  - The column never claims "running". It shows the variant and "started <relative>"
    with a link to the run until a result lands.
- **A8 (Medium, D1):**
  - `listBookingsForLink` filters on the exact `bookingLinkId` AND the tenant, because
    `booking-link:foo` and `booking-link:foo:bar` share a prefix inside one tenant.
  - The cascade deletes the link (and its slug) FIRST, which closes the public claim
    door, and then sweeps the bookings.
  - The ratchet keys on the collection name `crm:booking`, because `erasure.ts:75`
    opens a second handle on it.
- **A9 (Medium, D7):**
  - When a tenant override yields no binding, the variant defaults to `basic` and is
    stamped `bindingSource: 'default'`. It is not a 422.
  - The candidate set is keyed on the node NAME (bindings pin `1.0.0` while the node
    moves to 1.1.0).
  - Ownership is `hostOwned` with `featureId: 'crm'`.
  - "Builder-editable" applies to a from-chain COPY, which gets a new id the Triage
    button does not launch. The ADR says so rather than implying the button runs the
    edited copy.
- **A10 (Medium, D8): `dueDate` is any string up to 40 characters**, not a date-only
  value. A leading `YYYY-MM-DD` counts as dated; anything else is undated, both for
  ordering and for "Rotting".
- **A11 (Medium, D4):**
  - The run surface's `createContact` in a run with no person (a webhook-triggered
    chain) is also an unattended lane, so it applies the probe.
  - The widget's null branch says "A valid email is required" (`agentTools.ts:440`),
    which differs from the found branch, so the earlier "every caller handles null"
    was wrong. The widget now gives the same success text in both cases and returns
    no `contactId` in either.
  - Booking skips the contact silently on an erased subject, with no warning log.
  - **Residue, named:** activity bodies that already hold booking notes from before
    this change are not backfilled.
- **A12 (Medium, D6):**
  - The owner check applies only to an EXPLICIT `ownerUserId` that differs from the
    caller. The surface default (`viewer ?? actor`) is untouched.
  - "On update" is dropped: the patch type has no `ownerUserId`.
  - The harm named precisely: the public page calls the global `getUser`
    (`bookingRoutes.ts:200`), which could show another tenant's user's display name.
- **A13 (Medium, D3):** `demoCrmSeed.ts:201` merges under the seed lock. The two locks
  use different keys, so they do not deadlock. A seed that meets a busy merge gets
  the 409 and is reported as such.
- **Verified accurate:**
  - D1's premise (delete first, guard after).
  - `getBookingLink(tenantId, orgId, id)` and the indexed, org-filtered
    `listBookings`.
  - The `deferredParameterAliases` input rename (`chainBackedWorkflows.ts:84-138`).
  - The pack bump winning over the registry copy (`workflowChainPackLoader.ts:485-498`).

## Alternatives weighed
- **D1, guard the prefix scan's input** (reject an id without a uuid tail). Rejected
  on its own: it guards one writer's input and leaves the exit raw. The cure is to
  delete only rows the tenant-indexed read returned. The input shape check would
  only be cosmetic on top of that.
- **D3, claim-first CAS on the source tombstone with no lock.** This is sound against
  cycles, but it moves the tombstone before the email-claim re-point. That reopens
  the ADR 0627 N1 takeover window, and it needs a rollback when the survivor CAS
  then fails. A per-tenant lock is simpler, and merges are rare enough that
  serializing them costs nothing.
- **D4, refuse the public booking or checkout outright for an erased subject.**
  Rejected. The person is actively asking for a meeting or a purchase, and the
  booking or order row is needed to serve them. What erasure forbids is rebuilding
  the CRM profile, so only the contact is skipped.
- **D7, let the binding name an arbitrary node and rewrite the chain per launch.**
  Rejected. A per-launch definition rewrite breaks same-id resolution and replay
  (replay resolves the id, not the rewrite). A closed candidate set is what
  `VariantBinding`'s docblock already says the owning manifest declares.
- **D7, two chains (`triage-basic`, `triage-enriched`).** Rejected. It duplicates the
  graph to vary one config value.
- **D8, a client-side rollup.** Rejected for the reasons ADR 0567 gives: N+1 reads
  against the per-IP read budget, and the tasks tab may not hold every deal's tasks.

## Product decisions made here (named, not silent)
1. **D4:** a person who was erased and then books a meeting, checks out as a guest,
   or talks to the anonymous widget is served, but no CRM contact is re-created. A
   member can still add them by hand.
2. **D4:** booking notes and cancel reasons no longer appear in the timeline. They
   stay on the booking.
3. **D3:** a second merge started while one is running in the same workspace answers
   "A merge is already running. Try again in a moment."
4. **D7:** Triage now scores the contact and records a priority. Previously it
   started a run that did nothing visible.

## Phased plan
| Phase | Scope |
|---|---|
| P1 | D1 + D2 + D6 (security, each witnessed RED on `origin/main` first) |
| P2 | D3 + D4 + D5 |
| P3 | D7 (node pack 1.10.1 → 1.11.0, chain pack 1.3.2 → 1.4.0, same-id registration, route, contact list column) |
| P4 | D8 (rollup, board markers, DealDetail loop) |
| P5 | Docs: FEATURES, ADR 0567/0819 correction notes, trackers |

## Evaluation matrix (extension of `crm`)
| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | All changes in `features/crm/` plus `host/tenantOpLock.ts` (a new core primitive that `seedLock` delegates to). Core imports no feature. |
| 2 | Toggle | `crm` unchanged. The triage candidate set is declared beside its variants. |
| 3 | `ctx.features.crm` | +`getContact` (read), +`recordContactTriage` (tenant write, at `workspace:write` via `tenantMethodScopes`, A4). `FeatureSurfaceOrgPolicy` gains `tenantMethodScopes` (a core seam extension, generic). |
| 4 | Node pack | `feature.crm.nodes` 1.11.0: +`get-contact` (action), +`record-triage` (side-effect, joins the fork floor), `triage` 1.1.0 takes `config.variant`. Registry republish owed, as for every pack bump. |
| 5 | Envelopes | None. |
| 6 | Agent pack | Unchanged. `sales-ops` gains no write. |
| 7 | Public surface | The booking pages are unchanged in shape. D4 changes what a public lane writes, never what it returns. |
| 8 | RBAC | D2, D5 and D6. Writes stay `workspace:write`, reads `workspace:read`. |
| 9 | Replay | D7's variant reaches the run as an input. The writer is side-effect, so a `replay` fork does not re-record. The stamp is read and never recomputed. |
| 10 | Frontend | `DealsTab` card markers, `DealDetailPage` task completion and offer, `ContactsTab` triage column. All inside lazily loaded CRM chunks, so no entry-chunk growth. Four locales. |

## RFC verdict
Host work only. No RFC.

## Open questions
1. Should the "Rotting" marker also fire on "no activity for N days" (ADR 0567 Q2)?
   v1 is overdue-only. The explicit no-next-activity marker covers the other half's
   visibility.
2. Should D5 also refuse task PATCH or DELETE on a task linked to an invisible deal?
   v1 keeps writes org-scoped, as the ADR 0272 comment at `orgRoutes.ts:111` states.
   Filed as a follow-up.

## Corrections found in the first cut (2026-10-06, `/grade-code` + `/grade-ux`)

The decision text above is kept as written; these notes record where the first
implementation, or the decision itself, was wrong. Where a note and the text
disagree, the note wins.

- **D7 — which workflow triage runs is the operator's choice (`CRM2CD-1`, High).**
  The first cut launched the run with no person behind it and justified that in a
  comment ("the run touches only the contact it names"). That was false:
  `body.workflowId` let any member pick ANY workflow, and a run with no person
  meets no org or tenant floor, so a member of org A could write into org B.
  - **The second cut also failed.** It stamped the clicker as `orgScopeSubject`.
    An independent re-check (R1) showed the tenant floor then refused the record
    step for the wildcard operator (`bearer:…`), anon sessions (`session:…`) and
    unbound OIDC subjects in a personal workspace. The starter carries no
    `personalTenant`, so the implicit-owner shortcut cannot fire. The ADR's earlier
    claim that "a causing member passes in a personal tenant" held only for a bound
    user.
  - **What shipped.** A member naming a `workflowId` gets a 400; only the wildcard
    operator, or the `OPENWOP_CRM_TRIAGE_WORKFLOW_ID` env override, chooses one. The
    run stays host-trusted.
  - **Witness.** A personal-workspace triage completes, and a member-chosen
    workflow is refused (RED on `869ac06bf`).
- **D7 — a refused start no longer leaves a phantom stamp (`CRM2CD-2`, High).** The
  stamp is written before the start, as A7 requires. A start that is refused (the
  budget cap, the plan limit, a failed insert, a `null`) used to leave the contact
  naming a run that never existed, and erased the last real result.
  `restoreContactTriage` puts the previous stamp back, but only while the stamp
  still names the failed run.
- **D7 — the column states.** The text said "Triage running"; A7 said the column
  "never claims running". The shipped column polls the run it started (bounded to
  a minute). It shows **"Scoring…"** while the run is live, the recorded result
  when it completes, and **"Triage failed"** when it does not (`CRM2UX-3`). The
  variant names are translated.
- **D4 — the erasure probe is tri-state (`CRM2CD-4`).** A tombstone read failure
  was reported as `erased`, which labelled a person who never filed a DSAR. Every
  lane still refuses to create on a read failure; the forms sink now records it as
  `suppression_unreadable`, and the run surface as a 503. The actorless-run refusal
  no longer says why (`CRM2CD-8`).
- **D5 — one org read per entity type (`CRM2CD-3`).** The first cut did one
  `getDeal` per linked id through an unbounded `Promise.all`: about 500 concurrent
  reads per board load against a 4-connection pool.
- **D1 — the cascade sweep is best-effort per row (`CRM2CD-6`).** Once the link is
  gone a retry 404s, so a throw midway stranded the remaining rows.
- **D3 — the lock has a witness (`CRM2CD-5`).** `test/adr0837-tenant-op-lock.test.ts`
  was sabotage-checked: a blind `kvDelete` release, and a `released` sentinel that
  is not treated as free, each turn it red.
- **D8 — wording and closed deals.** The ADR's "Rotting" ships as **"Overdue"**,
  which is plainer. The schedule-next offer is not shown on a won or lost deal, is
  retired by any open task, and is keyed by deal (`CRM2UX-6`). Completing one of
  several open tasks moves focus to the next task's control (`CRM2UX-1`), and a
  viewer is not offered task writes at all (`CRM2UX-2`, the `useKbOrgAccess`
  precedent, INCLUDING its failure state: a failed permission read says so and
  offers a retry rather than silently hiding a writer's controls, re-check N3).
- **Re-check (an independent pass over the fix commit) — N1, N5, N6.**
  - **N1.** The triage poller is one stable interval. It reads the pending set
    through a ref, skips a run already being read, reloads at most once per tick,
    and stays silent after unmount.
  - **N5.** The due label sits outside the truncated title, so a long title no
    longer hides when the task is due.
  - **N6.** Focus reaches the title field only after the offer that describes it
    has rendered.

## Implementation record

Commits are cited by subject, because a rebase moves SHAs (the ADR 0826 lesson).

| Phase | Decisions | Commit (subject) | Witness |
|---|---|---|---|
| P1/P2 | D1–D6 | `fix(crm): exit guards — booking cascade, surface floors, merge lock, erasure, territories (ADR 0837 D1-D6)` | `test/adr0837-crm-exits.test.ts` (7 legs RED on `869ac06bf`) |
| P1/P2 | D2, D5 | `test(crm): ADR 0837 D2/D5 witnesses — surface floors + territory reads` | `adr0837-crm-surface-floors`, `adr0837-crm-territory-reads` (all RED on `869ac06bf`) |
| P3 | D7 | `feat(crm): Triage runs crm-ops.triage with the bound variant (ADR 0837 D7)` | `adr0837-crm-triage-chain` (real loader, starter, executor, pack, surface); `crm-node-through-surface` (29/29 nodes) |
| P4 | D8 | `feat(crm): activity loop — next task per deal, overdue marker, close-the-loop offer (ADR 0837 D8 / ADR 0567)` | `adr0837-crm-next-task`; FE `nextActivity.test.tsx`, `DealDetailPage.test.tsx` |
| P5 | grader fixes | `fix(crm): grade-code + grade-ux findings on ADR 0837 first cut (CRM2CD-1..9, CRM2UX-1..11)` | `adr0837-tenant-op-lock` (sabotage-witnessed); the triage stamp-restore leg; FE focus/viewer/closed-deal legs |
| P5 | re-check fixes | `fix(crm): re-check findings — operator-only triage workflow, poller, access failure state (ADR 0837 R1/N1-N6); copy honesty (CRMWF-7, WF-CRM-5)` | the operator-only + personal-workspace triage leg; FE `triageFollowUp.test.tsx` |

**Pack versions.** `feature.crm.nodes` is now 1.11.0 and `core.openwop.workflows.crm-ops`
is 1.4.0. A **registry republish of `feature.crm.nodes@1.11.0` is owed**, as for
every pack bump: until it is published, a boot with `OPENWOP_MOUNT_LOCAL_PACKS=false`
serves the 1.10.1 nodes, and the Triage chain fails at `get-contact`.

## Deferred (filed, with reasons)

- **`CRM2-D1` — a demoted member's Gmail sync keeps logging activities (A5).** The
  cure is a typed self-pause in the node, which needs a new closed-world
  `pausedReason`.
- **`CRM2-D2` — the cancellation note on the timeline is English and does not link
  to the booking (`CRM2UX-7`).** Every booking-generated timeline note is
  backend-composed English today. The cure is a typed activity reference (a
  `bookingId`) rendered as a translated link.
- **`CRM2-D3` — booking notes in timeline activities written BEFORE this change are
  not backfilled.** Erasure keeps activity bodies by design. A backfill is a prod
  data change, which needs approval.
- **`CRM2-D4` — the ADR 0567 Q2 "no activity for N days" rot rule.** v1 is
  overdue-only.
- **`CRM2-D5` — the anonymous widget's not-found branch costs two extra tombstone
  reads**, a timing difference (`CRM2CD-8`, Low).
- **`CRM2-D6` — the forms sink reports an erasure-register read failure as
  `suppression_unreadable`** (re-check N4, Low). That is the right refusal under the
  wrong register's name. The sink's error vocabulary is shared with forms, so the
  rename belongs with it.
- **`CRM2-D7` — a task linked to a MERGED-away company in a hidden territory**
  counts as unlinked (re-check N2, Low). Merge relinking makes this rare.

