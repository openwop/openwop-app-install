# ADR 0859 — CMS editorial approval gate: one review per submission, a reviewer who is told, a second pair of eyes, and a card that says what it does not cover

Status: implemented (2026-10-07; Accepted after the pre-code `/architect` pass, then corrected by `/grade-code` and `/grade-ux` — see the correction notes and the implementation record; feature loop round 2 row 34, branch `feat/fl2-34-cms-approval`)

Extends **ADR 0066** (the gate), **ADR 0593** (the fix batch and its terminal row lifecycle),
**ADR 0594** (live-reference sections — this ADR builds its unbuilt D1/D2), **ADR 0672** (the
audience owner `approvalAudience.ts`), **ADR 0836** (page CAS + publish blockers) and **ADR 0845
D5** (separation of duties on the sibling `strategy-activation` gate). Composes **ADR 0848 D1 /
ADR 0754** (create at a caller-chosen id) and **ADR 0832** (the org floor in `gate()`). Gap ids
`CMSA2WF-1..7` in `docs/steward/WORKFLOWS-ASSESSMENT.md` § "CMS editorial approval gate — round
2 re-grade (feature loop row 34)".

## Context

Round 1 left this sub-feature at WF **B**; UX and CODE were never graded. This pass re-measured
it on `origin/main` @ `42f252ffc`.

**The publish-status surface holds.** With the toggle ON no lane writes `published` without a
decide through `decideContentPublish`. I re-ran the census instead of inheriting row 22's:
every `transitionPage(` / `restoreVersion(` / `setLocalePublishState(` caller is the system site
(exempt by tenant), the demo seed, a gated route, the protocol lane (`publish:true` 409s,
`contentProtocolRoutes.ts:284`), the sweep (re-checks the gate), the experiment promote (its
gated arm submits) or the decide handler. Nothing here re-opens that.

What the grade moves on is everything around the decision:

1. **`CMSA2WF-1` (Blocker, issue #4515) — a run in org B can replace org A's approved page.**
   `surface.ts:32-48` → `createPage` (`cmsService.ts:1058`). With a node-chosen `pageId`, the
   idempotency read is `getPage(tenant, B, pageId)`, which filters by org, so A's row reads as
   absent and `pages.put` (`:1101`) writes over it — the kernel key is tenant + id. The ADR
   0832 floor asks only whether the actor holds `workspace:write` in **B** (`feature.ts:35`).
   A's live page becomes a B-owned draft with B's content; A's readers get a 404. The protocol
   lane already refuses this (`createOnly`, ADR 0754); the run surface does not.
2. **`CMSA2WF-2` — racing submits mint two review cards** (`CMSAWF-5`, deferred twice).
   `queueContentApproval` scans (`contentApproval.ts:412`) and then creates
   `appr:${randomUUID()}` with a blind `put` (`approvalService.ts:1403,1419`). ADR 0836's page
   CAS does not serialise two submits, because `submit` is legal `in_review → in_review`.
3. **`CMSA2WF-5` — the gate tells nobody.** No `notify` call on submit or decide. Managers learn
   of a review only from the opt-in SLA rungs or by opening the inbox; the submitter learns of a
   rejection only by reopening the page. Every comparable editorial workflow notifies the
   reviewer on submit and the author on the decision (Contentful workflows, Storyblok stages,
   PublishPress; `UX_UPGRADE-content.md:192` records Framer routing on-site edits to an
   approval email).
4. **The gate does not require a second person.** An org admin can submit and approve their own
   page (corrected after review: the defect is submitter = approver; who EDITED is not tracked,
   see D4). The sibling gate with the same decide bar, `strategy-activation`, refuses that when
   someone else in the org could approve (ADR 0845 D5, `activationApproval.ts:141-160`, using
   `hasDistinctScopeHolder`). "A real human approval" is true here; "someone other than the
   author looked at it" is not.
5. **`CMSA2WF-3` — ADR 0594's condition is unbuilt.** ADR 0594 accepted that an `entityList` /
   `entityDetail` section changes after approval, on the condition (D1) that the approval card
   says so, and pinned (D2) that no CMS lane can widen `publicRead`/`neverPublic`. `grep -rn
   liveReferenceSections` over backend and frontend: zero hits.
6. **`CMSA2WF-4` — the page forgets its last decision.** `pruneResolved`
   (`approvalService.ts:2576`) keeps the newest 100 resolved rows per tenant across ALL kinds;
   `GET …/pages/:id/review` (`routes.ts:549`) reads only those rows. On a busy tenant a
   rejection's reason vanishes before the author reads it.
7. **`CMSA2WF-6/-7`** — the demo seed leaves an `in_review` page with no row
   (`demoContentMarketingSeed.ts:120`); `/reviews` content-publish visibility and the sweep's
   daemon wiring have no witness.

## Boundaries audit (what already exists — composed, not forked)

| Need | Owner | Cite |
|---|---|---|
| create at a caller-chosen id | `insertOwnedOrConflict` rule; kernel adapter `create` | `host/ownedInsert.ts`, `features/entities/kernelAdapter.ts:57-59` |
| deterministic approval create | `compareAndSwap(null, row)` | `approvalService.ts:1550` (anon-surface-write) |
| who may learn a row exists | `approvalRecipients` (addressed only) | `host/approvalAudience.ts:148` |
| notification delivery | `getNotificationEmitter().emit` | `approvalSla.ts:288` |
| separation of duties | `hasDistinctScopeHolder(…, { orgId })`, `canonicalDecider` | `accessControlService.ts:2065`, `strategy/activationApproval.ts:79` |
| "resolves live" | content-section resolver registry | `host/contentDataSources.ts:109,177` |
| deliverable sections | `deliverableSectionsForPage` | `cmsService.ts:2233` |
| subject erasure on approval rows | `registerApprovalRedactor` | `approvalService.ts:1169` |

No new store, kind, toggle, route, pack or envelope.

## Decision

### D1 — `createPage` never writes over a row it does not own (`CMSA2WF-1`)

`createPage` reads the RAW row by tenant + id (`pages.get`, which `casPage` already uses) when a
`pageId` is given. Owned by the same org ⇒ return it (seed/replay convergence, unchanged) or 409
under `createOnly` (unchanged). Owned by another org ⇒ **409 `That id is already in use.`**, no
org or title in the message (the ADR 0848 D1 wording). Absent ⇒ `pages.create` (create-only), and
a lost race re-reads and applies the same rule. Every create is create-only: `createPage` never
overwrites. This fixes the run surface and every other caller in one place.

### D2 — one review row per submission (`CMSA2WF-2`)

The page gets a `reviewCycle` counter, bumped by `transitionPage` **only** on `submit` from
`draft` (the edge the page CAS serialises — exactly one submit wins it). `in_review →
in_review` resubmits keep it. `queueContentApproval` then creates the row at a deterministic
id, `appr:cms:<sha256(JSON.stringify([tenantId, pageId, page.createdAt, reviewCycle]))>`, with
`compareAndSwap(null, row)`. (JSON, not a `:` join: tenant ids and node-chosen page ids both
contain `:`. `createdAt` because a deleted page re-created at the same caller-chosen id restarts
its cycle — review M1.) A loser of that CAS repins the winner's row only after checking the row
is a `content-publish` row for **this** tenant and page, and re-indexes it idempotently (a crash
between the CAS and the index must not leave a row the inbox cannot see — review M2). Pages and
rows from before this ADR have no cycle; for them the existing find-pending-then-repin path still
runs first, so nothing changes for an open legacy row, and a legacy `in_review` page stays racy
until its next draft→submit (review L1). If the deterministic id holds a row that is resolved,
or belongs to another page, the queue falls back to a random id and logs at `warn` — never a
stranded page.

The id scheme changes for `content-publish` only. Every other kind and every reader keys on
`approvalId` as an opaque string.

### D3 — the reviewer is told, the author is told (`CMSA2WF-5`)

- **Only when the caller says so.** `queueContentApproval` takes an explicit
  `{ submittedBy?, notify }` argument rather than inferring either (review H3 — it has five
  callers, not two). Submit route: the user, notify. Run surface: the run's subject, notify.
  Gated experiment promote: the promoting admin, notify. The decide route's lazy backfill and
  the demo seed: no submitter, no notify (the backfill runs inside a decide; the seed must not
  page demo managers).
- **On a NEW review row** (not a repin): one addressed notification per org manager, from
  `approvalRecipients` — `type: 'approval.content-review-requested'`, title = the page title,
  `actionUrl` = the inbox deep link. **Never** the tenant-wide emit: if the resolver names nobody
  (the system site, an org of descriptive members), emit nothing — the SLA rung already owns the
  redacted fallback. The submitter is excluded (they know).
- **On a decision** (approve or reject by a person, in `decideContentPublish` after the transition
  lands): one addressed notification to each of the row's `submitters` who still holds
  `workspace:write` in the org (review L5), `type:
  'approval.content-review-decided'`, carrying outcome and (for reject) that a reason exists — not
  the reason text, which stays behind the page's own `workspace:write` read. No notification for
  system closures (deleted page, left review) — there is nobody's decision to report.
- **`submitters`** (a set, never overwritten) is recorded on the row at create and UNIONED on
  every repin within the cycle — review H2: an overwrite let a second person's resubmit erase
  the first submitter, and with it D4. The subject is `user.userId` on the route, and on the run
  surface `runOrgScopeSubject(scope)` (the actor, else the member who caused an actorless run —
  a narrowing use, which is what that helper permits; without it a manager could launder a
  self-approval through a scheduled run, review M3). `content-publish` moves out of the shared
  empty-redactor loop (`approvalService.ts:1168`) with `submitters` as an id field (review L4).
- Notification is best-effort and AFTER the durable write: a failed emit is logged, never
  thrown (the `notify.ts:215` rule).

### D4 — the submitter cannot approve their own page while someone else can (gate ON)

In `decideContentPublish`, on APPROVE, before the CAS: if the cms-approval-gate is ON for the org
(`liveEditGateActive`, so the system site is exempt), and the canonical decider is one of the
canonical `submitters`, and `hasDistinctScopeHolder(tenant, 'host:members:manage', decider, {
orgId })` — refuse **403 `forbidden`, `reason: 'separation-of-duties'`**. A row with NO recorded
submitter (legacy rows, the backfill, an actorless run with no cause) is allowed with a `warn`
log — the strategy precedent exactly (`activationApproval.ts:143-160`); "fail closed" there
would count every manager as distinct and strand the page (review M3). A submitter that cannot
be canonicalised (an unresolvable delegated key) is treated as matching — fail closed.

**Scope of the promise, stated honestly (review H2).** This is separation of duties between the
**submitter** and the approver, as ADR 0845 D5 is. It does not track who EDITED the content: a
manager who writes a page and has an editor submit it can still approve it. Authorship tracking
is deferred (below); the Context's "someone other than the author" is corrected to "someone
other than whoever submitted it". The ADR 0845 D5 rule
verbatim, for the same reasons: a sole approver is never locked out; a REJECT of your own
submission is a withdrawal and stays allowed; an unknown submitter or decider fails closed.

**Gate OFF ⇒ no refusal.** With the toggle OFF an admin may publish directly; refusing their
self-approval would only push them to the bypass. The rule exists where the gate's promise is
"reviewed before it goes out". `canonicalDecider` moves from `strategy/activationApproval.ts`
to `host/delegatedSubject.ts` (strategy re-exports it; *corrected at implementation: the draft said `accessControlService.ts`, but the function's only dependency is the delegation lookup, which lives in `delegatedSubject.ts`*); no fork. Every decide lane reaches the
one handler through `KIND_DISPATCH` (`approvalDecision.ts:302-308`): the CMS route keys the
decider on `user.userId`, `/approvals` on `req.userId`, `/reviews` on `ctx.subjectRef` — equal in
production, and a mismatch fails OPEN here, so P4 witnesses the refusal through all three
(review M4).

**Owner decision (OD-1).** This changes behaviour for an org that runs the gate ON with two or
more managers. Recommended as above; the alternative is a per-org opt-in.

### D5 — the card says what the signature does not cover (`CMSA2WF-3`, ADR 0594 D1/D2)

`queueContentApproval` derives `liveReferenceSections` from
`resolveSharedRefs(deliverableSectionsForPage(page))` — a shared-section reference renders the
shared row's type, so an `entityList` held in a shared section would otherwise go undisclosed
(review M5):
the section types for which a content-section resolver is registered
(`hasContentSectionResolver`) — `entityList`, `entityDetail`, `challengeCatalog` today. The
registry IS the definition of "resolves live at read time", so a future resolver is disclosed
without touching this code. Recomputed on every repin, like `aiDraftedLocales`. The inbox card
(`ContentReviewContext`) renders a chip — "N sections show live data; approving does not freeze
it" — with the sentence in the accessibility tree, not a tooltip (the ADR 0593 F7.1 lesson).
ADR 0594 D2's tripwire ships as a test: no CMS route or surface can set `publicRead` or
`neverPublic`, and the entities `publicRead` flip stays `host:members:manage`. The demo seed's
`updateEntityType(cms.page, { publicRead: true })` is a host seed, not a CMS lane, and is a NAMED
exemption in the test (review L3). Entities registers its resolvers when the feature activates
(`entities/publicRead.ts:225`), so the witness composes entities explicitly.

### D6 — the page's latest decision survives pruning (`CMSA2WF-4`)

**Revised (review H1).** The first draft stamped `lastReview` onto the page. That would have
published the reviewer's free-text reason to `workspace:read`: `pageToKernel` carries every
non-section field in `ext.page`, and `GET …/pages` / `GET …/pages/:id` (`routes.ts:81,145`)
return the whole `Page` at read tier, while the reason is meant for the author at
`workspace:write`.

Instead `pruneResolved` keeps, in addition to the newest 100, **the newest resolved
`content-publish` row per page**. No new store, no new eraser (the approval redactor already
covers the row), no new teardown lane, and `/review` reads what it reads today. The bound is one
retained row per page that has ever been reviewed; `deletePage` removes the page's resolved
`content-publish` rows after closing its pending one (the governance chain keeps the decision),
so a deleted page retains nothing. Retention is a pure function over the rows `pruneResolved`
already lists — no extra read.

### D7 — the demo seed queues its review; two witnesses (`CMSA2WF-6/-7`)

The seed calls `queueContentApproval` after its `submit`. Tests: a non-manager cannot see or
decide a `content-publish` row through `/reviews`; `startCmsPublishSweep` is wired at boot.

## Alternatives weighed

- **D1: compare the org after the read, keep `put`.** Leaves the read→put window. `create` closes
  it for free.
- **D2: a per-page lock.** `withApprovalLock` is keyed by `approvalId` and process-local; Cloud
  Run runs more than one instance. A deterministic id + storage CAS works across instances.
- **D2: id from `(pageId, version)`.** Reject → resubmit of unchanged content collides with the
  resolved row. The cycle counter does not.
- **D3: include the reject reason in the notification.** Notifications fan out to push and
  email; the reason is free text a reviewer wrote for the author in the editor. Keep it behind
  the page read.
- **D4: refuse self-approval always.** Bricks the default one-admin workspace (ADR 0845 §222).
- **D6: a stamp on the page.** Leaks the reason to `workspace:read` (review H1).
- **D6: a sidecar store.** A new collection needs its own eraser, teardown and delete cascade —
  three lanes to keep right for one field that the existing row already holds.
- **D6: exempt all `content-publish` rows from pruning.** Unbounded per page; keeping one per
  page is enough for the author's read.
- **Approve-then-schedule (row 22's G7).** Wanted (Contentful scheduled releases), but it changes
  the gate's semantics (an approval that publishes later must re-check the pin at fire time).
  Deferred, recorded below.

## RFC verdict

Host-extension only. Approval rows, notifications and `/v1/host/openwop-app/*` routes are
non-normative; no run-event, capability or endpoint contract changes. No RFC.

## Matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | Inside `features/cms` + the host approval/notification owners; `canonicalDecider` lifts to host. No core→feature import. |
| 2 | Toggle | `cms-approval-gate` unchanged (tenant, default OFF). D4 applies only while it is ON. |
| 3 | Workflow surface | `ctx.features.cms.createDraftPage` gains D1; `submitPage` records `submittedBy` from `actingUserId`. |
| 4 | Node pack | No change; `create-draft-page`'s caller (campaign-channels) uses an own-org deterministic id. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None — agent tools stay draft + submit. |
| 7 | Public surface | None. |
| 8 | RBAC | D1 refuses cross-org ids; D3 is addressed-only through the audience owner; D4 adds SoD. |
| 9 | Replay | `submit-page` stays served; D2's deterministic id makes a re-executed submit converge too. |
| 10 | Frontend | Inbox chip (D5), SoD refusal copy, review panel unchanged (D6 is server-side). 4 locales. |

## Implementation plan

| Phase | Work | Witness |
|---|---|---|
| P1 | D1 | same-tenant two-org `createDraftPage` naming A's id → 409, A intact (RED first) |
| P2 | D2 | two concurrent submits → one pending row (RED first) |
| P3 | D3 + `submittedBy` + redactor | submit notifies managers only, not the submitter, not non-managers; decide notifies the submitter; no emit when nobody resolves |
| P4 | D4 | self-approve refused with a second manager; allowed when sole; gate OFF allowed; self-reject allowed |
| P5 | D5 + FE chip | entity section ⇒ disclosed; removed ⇒ cleared on repin; D2 tripwire |
| P6 | D6 | 101 resolved other-kind approvals → `/review` still answers |
| P7 | D7 | seed row exists; `/reviews` non-manager; sweep wired |

## Deferred

- **Approve-then-schedule (G7).** Needs a pin re-check at fire time; separate ADR.
- **Authorship-aware separation of duties.** D4 compares submitters, not editors. Tracking who
  edited the content within a review cycle needs an editor set written by `updatePage`;
  deferred.
- **Per-org gate.** The toggle is tenant-wide (`contentApproval.ts:166`); per-org gating is a
  product change.
- **Forms and media in D5.** A form section and a media asset also change after approval, but
  neither resolves through the content-section registry. Whether their own stores' controls
  govern them (ADR 0594's test) is unasked; recorded, not decided.

## Open questions / owner decisions

- **OD-1** — D4 (self-approval refused under the gate when a second manager exists).
  **Owner decision 2026-10-07: confirmed** as shipped — in an org with two or more managers the
  submitter cannot approve their own page; a sole manager may self-approve, and that decision is recorded on
  the governance chain with the approver as its actor, like any other. Prod context
  measured the same day: the `cms-approval-gate` toggle resolves ON for every tenant except
  `conformance-prod` (stored `beta` with no cohort), so D4 is live on deploy for every org with
  two or more managers; 0 `content-publish` rows existed, so no migration. **Follow-up (not this
  ADR):** a per-workspace strict mode that refuses self-approval even for a sole manager.
- **OD-2** — D3's two types reach the notification list, SSE and push (all addressed). Email is a
  type allowlist (`emailApprovalDelivery.ts:124-125`) and they are NOT added to it, so no email
  goes out. Recommended as shipped; adding them is a one-line follow-up if the owner wants email.

## Pre-code review (`/architect`, 2026-10-07)

An independent adversarial pass over the decision text, against `42f252ffc`. **0 Blockers, 3
Highs, 5 Mediums, 6 Lows** — all folded into the decisions above:

| id | finding | fold |
|---|---|---|
| H1 | D6's page stamp would reach `workspace:read` (`routes.ts:81,145` return the whole `Page`) | D6 rewritten: keep the newest row per page in `pruneResolved` |
| H2 | D3 overwrote `submittedBy` on repin, so a second person's resubmit erased D4; and D4 tracks the submitter, not the author | `submitters` is a union; the promise is restated as submitter ≠ approver; authorship deferred |
| H3 | `queueContentApproval` has five callers; the backfill would make the deciding manager the "submitter" | explicit `{ submittedBy?, notify }` per caller |
| M1 | a deleted page re-created at the same id restarts its cycle and collides with a resolved row | `createdAt` in the hash; fallback claim reworded |
| M2 | `:`-joined hash input ambiguous; the loser repins without checking the row's tenant/page | JSON input; loser checks; idempotent re-index |
| M3 | absent submitter undefined; fail-closed would strand pages; actorless runs launder | strategy precedent (allow + warn); `runOrgScopeSubject` on the surface |
| M4 | three decide lanes key the decider differently; a mismatch fails open | P4 witnesses all three lanes |
| M5 | entity sections inside shared sections were not disclosed | `resolveSharedRefs` over the deliverable union |
| L1–L6 | legacy in_review race; email allowlist decides OD-2; demo seed's `publicRead` exemption; redactor split; notify only current members; line nits | folded / noted |

Verified TRUE by the pass: no `createPage` caller relies on overwrite (every seed reads first; the
POST route passes no id; the protocol lane is already create-only); `transitionPage` is the only
status writer and every page writer spreads `...p`, so a new page field survives every write;
`approvalRecipients` returns the same subject the SLA rung already addresses; every decide lane
reaches the one handler.

## Corrections from `/grade-code` and `/grade-ux` (after the first cut)

> **CORRECTED — D3/D4, the causing member (code grade `CMSA2CD-1`, Blocker).** The first cut
> recorded `runOrgScopeSubject(scope)` as a submitter on the run surface — so a member who merely
> CAUSED an actorless run (a channel poster) was NOTIFIED of the decision. That helper's own
> contract forbids granting on it, and the ADR 0832 reviewed-reader ratchet went red. A cause is
> now stored apart, as `submitterCauses`: counted by separation of duties (it narrows) and never
> notified. Only the run's actor is a `submitter`.
>
> **CORRECTED — D4, distinct approver (`CMSA2CD-3`).** "Someone else can approve" asked for a holder
> other than the DECIDER. With two submitting admins and no third manager, each was refused for
> the other and the page was stuck — the opposite of "a sole approver is never locked out".
> `hasDistinctScopeHolder` takes `alsoExclude`; distinct now means neither the decider nor any
> submitter or cause.
>
> **CORRECTED — D6, the retention bound (`CMSA2CD-2`).** The per-page exemption was unbounded (it
> grew with every page ever reviewed, and every resolve, review read and page delete scans the
> set). Capped at 500 pages per tenant, newest first; and a review older than the page is not shown
> for it, so a page re-created at a reused id does not inherit the old page's decision.
>
> **CORRECTED — D3, where the notice lands (UX grade `CMSA2UX-2`, Blocker).** The requested notice
> linked `/inbox?approval=<id>`, which highlights the NOTIFICATION, not the review. Both notices now
> link the page itself, where a manager reads the content and has Approve / Reject. Both types got
> localized labels and are mutable in notification preferences (`CMSA2UX-1`, `-10`).
>
> **D4 in the editor (`CMSA2UX-4..6`).** The review read reports `awaitingAnotherApprover` (the
> same predicate, asked only of a manager); the editor then hides Approve (also while the review is
> loading), labels Reject "Withdraw from review", and announces who decides.

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1–P7 | `fix(cms): review lifecycle — no cross-org page overwrite, one row per submission, notify, SoD, live-data disclosure (ADR 0859 D1-D7, fl2-34)` | `test/adr0859-cms-review-lifecycle.test.ts` — D1, D2, D6 legs RED on `origin/main` `42f252ffc` (3 failed / 1 control passed) before the fix; `test/adr0859-cms-review-http.test.ts` (SoD on all three decide lanes, notices, disclosure, `/reviews`, sweep) |
| FE | `feat(cms): editor + inbox show who decides and what approval does not freeze; ADR 0594 D2 tripwire (ADR 0859 D4/D5, fl2-34)` | `frontend/react/src/features/cms/__tests__/adr0859Review.test.tsx` |
| grades | `fix(cms): grade-ux + grade-code findings — cause apart from submitter, bounded review retention, no SoD deadlock, notices land on the page (ADR 0859, fl2-34)` | the same files; each fix sabotage-probed red (SoD off, notify off, submitters overwritten, deterministic id off, decision notice off, disclosure off, `alsoExclude` off, retention cap 0, FE Approve filter off) |

Existing tests changed, with reasons in place: `cms-approval-gate.test.ts` (a deleted page's
review rows are removed, so a later claim is 404, not the already-resolved 409; the backstop test
re-creates the stranded row instead of reopening a deleted one), `approval-quorum-cms-lanes.test.ts`
(scans `createContentApprovalOnce` too), `adr0832-org-scope-subject.test.ts` (reviewed reader),
`cms-erasure.test.ts` (the new required queue argument).
