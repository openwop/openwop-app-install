# ADR 0659 — Collaboration / Comments: the author is not the caller — one visibility predicate on every comment lane

Status: implemented (2026-09-11, feature loop it.12 — P1/P2/P6 shipped; P3/P4/P5 and the D13 rows recorded open below)
Date: 2026-09-11
Feature: Collaboration / Comments (ADR 0021; ADR 0334 canvas threads; ADR 0353 P4 creative briefs; ADR 0232 priority ideas; ADR 0643 R3 the subject-bound KB gate; ADR 0608 D4 the `boundSubject` stamp; ADR 0014 workflow surface) · FEATURES.md ordinal 12 of 71 · feature loop 2026-09 it.12
Plan input: `/grade-code` 2026-09-11 rows `CMNT-15..21` (B+ → B); `/grade-ux` 2026-09-11 rows `CMNT-UX-16..22` (B → B−); `/grade-workflows` 2026-09-11 rows `CMWF-1..11` (B → B−)
Related: ADR 0657 D10 (the write-barrier shape this ADR's D4 reuses), ADR 0643 R3 Blocker 2 (the gate the write lane already honours)

## Context

The 2026-08 pass closed three Blockers and graded the feature B / B+. Re-graded
2026-09-11 against `origin/main @ d7bdabf9f` by three independent scouts, the feature has
**one root cause behind two Blockers**, and the scouts found its two ends independently:

**`createComment` uses the comment's AUTHOR as the visibility CALLER.**
`commentsService.ts:195` passes `{ subject: input.authorId }` into the target resolver.
Authorship is provenance — *who wrote this*. Visibility is authorization — *whose access
decides*. Conflating them fails in both directions at once:

- **Too open (`CMNT-15` / `CMWF-1`).** The READ lanes have no such parameter at all, so
  they skip the gate entirely: a member who may not see a corpus reads its whole thread.
- **Too closed (`CMWF-2`).** The workflow lane stamps `authorId = agent:${runId}`
  (`surface.ts:134`), which is never a bound subject, so a node can *never* comment on a
  subject-bound collection — and it is told `not_found`, which is false.

One parameter, two opposite failures. The cure is to separate them.

The gate itself is real and correct: `kb_collection.validate` passes its `caller` into
`getCollection` → `readableCollection` (`kb/kbService.ts:1093-1096`), which returns
`null` for a collection carrying `boundSubject` when the caller is not bound. That is
ADR 0643 R3 Blocker 2, tested on a bound fixture (`kb-subject-gate-doors.test.ts:200-205`).
Only its *argument* and its *reach* are wrong.

Every READ lane skips it. `listThread` (`commentsService.ts:166-170`) and `getComment`
(`:172-175`) call `validate` **zero times** and accept no `SubjectCaller`, so five
doors are open on a corpus the caller cannot see:

| Lane | Site | What leaks |
|---|---|---|
| HTTP thread read | `routes.ts:28-36` | every comment body + authorId |
| HTTP edit | `routes.ts:56` (via `getComment`) | body, and the ability to act on it |
| HTTP delete | `routes.ts:70` (via `deleteComment`, `:302`) | destructive, on an invisible target |
| Agent chat tool | `agentTools.ts:68` | the same thread, **to a model** |
| Workflow surface | `surface.ts:125` | the same thread, into a run's variable bag |

ADR 0608 D4 stamps `boundSubject` on live notebook and project corpora
(`kbService.ts:1065-1068,1145`), so this is not hypothetical. Any org member holding
`workspace:read` and a collection id reads the private corpus's review thread. The
hazard already sat in-tree as unasserted prose (`comments-delete-cascade.test.ts:13-19`)
— written down, never made load-bearing.

The UX scout reached the same line from the other side: because the read never
validates, a deleted or stale deep-linked resource answers `200 {comments:[]}`, the
panel renders "Be the first to leave a note on this resource" with a live composer, and
the post then 404s in English (`CMNT-UX-19`). One missing call, two lanes of harm.

### Premises checked, and two that were wrong

- **There is no `registerCommentable` registry.** `TARGETS` is a *total* static map over
  a closed `ResourceType` union (`commentsService.ts:39,70`), so a missing-resolver
  success-with-empty is structurally unreachable. FEATURES.md's "resolver registry — a
  new commentable type is one entry" describes the ergonomics honestly enough; there is
  no gap here and this ADR adds no registry.
- **`surface.ts:5` says "the run scope carries no human subject". FALSE at this tree.**
  `BundleScope.actingUserId` exists (`host/inMemorySurfaces.ts:244-250`) and 294 sites
  across `src/features` read it. The prose predates the field. This matters: it is the
  reason the surface lane can carry a caller at all, so D1 is implementable on all five
  lanes rather than three.
- Five of six resolvers are pure `(tenant, org)` lookups and need no caller; only
  `kb_collection` is subject-bound. The cure is still uniform — a lane that forgets the
  caller must not be the lane that decides it did not need one.

## Decision

### D1 — the author is not the caller, and every lane carries one (`CMNT-15` / `CMWF-1` / `CMWF-2`, Blockers)

`createComment` takes `authorId` **and** `caller` as separate arguments and stops
deriving one from the other. `commentsService` exports ONE resolver,
`resolveCommentTarget(tenantId, orgId, resourceType, resourceId, caller)`; `listThread`,
`getComment`, `updateComment` and `deleteComment` take a required `SubjectCaller`.

**Ordering, stated precisely** (the first draft said "call it before touching the store",
which is impossible for the by-id lanes — the target is only known from the row):
`listThread` resolves the target BEFORE the store read. `getComment` / `updateComment` /
`deleteComment` read the row first, then run the caller-gate on it, and an invisible
target returns the **identical** `null`/404 the missing-row path returns — **before** any
author or admin guard. That ordering is the point: `updateComment` today throws **403**
`forbidden_scope` for a non-author (`commentsService.ts:239-241`), so without it a
non-bound member probing a comment id still distinguishes 403 (exists, not yours) from
404 (absent) — the existence oracle this decision claims to close.

`caller` is **required and never defaults to `authorId`** — a call site that forgets it
gets `{ subject: undefined }` and is refused on a bound target
(`host/subjectAccess.ts:133`), which is the direction a forgotten gate must fail in. The
three in-process and test call sites that pass an author with no caller today
(`kb-subject-gate-doors.test.ts:200-205`, `document-comments-lifecycle.test.ts:35,41,47`)
are updated to pass one explicitly; that IS the change, not a compatibility shim.

A `null` target is a **uniform not-found** on every lane — never an empty thread, never an
existence oracle:

- `routes.ts` (GET / PATCH / DELETE) passes the authenticated principal; null → 404.
- `agentTools.ts` passes `scope.actingUserId` as the caller; null (or no acting user) →
  `toolEmpty` with a note that names no resource — the ADR 0315 read-tool posture, and
  the CLAUDE.md rule that an app-state tool SHARES its route's access predicate and
  fails EMPTY without an acting user.
- `surface.ts` passes `scope.actingUserId` as the **caller** while keeping
  `agent:${runId}` as the **author** — the run acts with its initiator's visibility and
  is still honestly attributed to the agent that wrote it. Null → the typed `not_found`
  its `post` and `resolve` siblings already throw. **This is what closes `CMWF-2`:** the
  node lane stops being refused on every subject-bound corpus, and stops reporting a
  false `not_found` when the truth was "the agent pseudo-subject is not a member".
  **Scope, corrected:** `surface.ts:95-108` ALREADY refuses every verb on every target
  when `actingUserId` is absent, so D1 changes nothing for a run with no acting user.
  What D1 changes is the BOUND case for a run that HAS one: today the KB gate receives
  `agent:${runId}`, which is never bound, so a bound corpus refuses a legitimate member's
  run.

**The load-bearing claim, checked:** `BundleScope.actingUserId` exists
(`host/inMemorySurfaces.ts:244-250`) with 294 reader sites under `src/features`. The
surface docblock at `surface.ts:5` says "the run scope carries no human subject"; that
prose predates the field and is false at this tree. If it were true, D1 would be
unimplementable on two of its five lanes — so it is the premise to re-check first.

**The cascades are NOT in scope and need no bypass.** `pruneThreadsForDeletedResources`,
`pruneThreadsForResourceAndComposites`, the retention purger and `deleteSubjectComments`
(`commentsService.ts:265-300,330,348`) iterate `comments.listForTenantIndexed` directly
and call `validate` zero times — they are row-keyed lifecycle sweeps, already gated by the
owning deletion. Routing them through a resolver to satisfy a bypass rule would turn two
bounded tenant scans into N lookups. `PREAUTHORIZED_CALLER` (`host/subjectAccess.ts:97`)
is therefore used at exactly ONE site:

**Org-admin moderation keeps working.** Without this, D1 silently revokes the one lane
whose purpose is moderation: an admin who is not a member of a bound project could no
longer delete a comment on it. The admin path (`routes.ts:70-79`, which already resolved
org authority at its own door) moderates with `PREAUTHORIZED_CALLER` — visibility is not
widened, because the admin receives only the delete, never the thread.

**One performance consequence, stated:** `priority_idea.validate`
(`commentsService.ts:107-114`) recomputes `listRankedIdeas`. Today that cost is paid on
create only; D1 moves it onto every thread read, every `openwop:comments.list` turn and
every surface `list`. The resolver point-looks-up the card instead of ranking.

Witnesses born red, both directions — a deny-only fix would pass the first half alone:
1. **Too open.** Bind a KB collection to subject A (the ADR 0608 D4 stamp); as org member
   B holding `workspace:read` but not bound — GET the thread, PATCH a comment, DELETE a
   comment, call the agent tool, call the surface read. All five refuse; `listThread` is
   never reached.
2. **Too closed.** The BOUND member A reads and writes the same thread through all five
   lanes and succeeds — including the surface lane on a run whose `actingUserId` is A,
   whose comment lands with `authorId = agent:<runId>`.
3. **Controls.** A plain (unbound) collection stays readable by any org member through all
   six lanes; a run WITH an `actingUserId` who is NOT bound is refused on a bound target
   and permitted on an unbound one. Do NOT write a no-acting-user leg — `surface.ts:97`
   refuses that unconditionally today and continues to, so such a witness is born green on
   one half and unreachable on the other.
4. **No oracle.** Member B PATCHes a NON-author comment on a bound corpus and gets **404**,
   byte-identical to the answer for a ghost `commentId`. Sabotage: run the author guard
   first ⇒ 403 ⇒ red.
5. **Moderation.** An org admin who is not bound deletes a comment on a bound corpus ⇒ 204,
   and receives no thread body.

### D2 — a thread cannot invite a note onto a target that is gone (`CMNT-UX-19`)

D1 makes the dead-target read a 404. The panel maps it to the existing
`linkedResourceMissing` state instead of the empty-state composer, and that hedge stops
being gated on `isPickable` — the four picker-less types are exactly the ones the
notification emitter deep-links, so today they get no hedge at all. The composer is not
rendered for a target that does not resolve.

### D3 — the delete/reply race, and a stated consequence that is false (`CMNT-16`)

`deleteComment` (`commentsService.ts:315-322`) removes a parent while a reply is in
flight, minting an orphan. The reply write re-checks the parent inside its own write
window and refuses (`parent_deleted`, typed). Separately, the erasure trade-off's
recorded consequence — "they still render via `listThread`" (`:344-347`) — is falsified
by `CommentsPanel.tsx:182,275`, where an orphan renders NOWHERE; the note is corrected
to say the row is retained but unreachable, which is the actual behaviour.

### D4 — an erasure write barrier (`CMNT-17`)

`deleteSubjectComments` (`:348-357`) is a single walk with no barrier, so a create
racing a DSAR survives it — the ADR 0657 `CONS-25` class, narrower. Same cure, same
shape: the subject's erasure is recorded first and `createComment` refuses an author
whose subject was erased, with a post-write re-check. The existing idempotence test is
sequential (`subject-erasure-parity.test.ts:78-82`) and cannot see this; the witness
interleaves.

### D5 — bounds (`CMNT-18`)

A per-target comment cap; the thread read paginated (cursor, the repo's existing shape);
`resourceId` length-bounded at the door (composite resolvers validate only
`split('#')[0]`, so the tail is unbounded today); and the comment body is
length-validated **at the door**, throwing a typed `validation_error` over 4000
(`commentsService.ts:190,242`) — a truncated comment is a changed comment, the
`embedded-param-tokens-fabricate` family. The shared `cleanString`
(`host/boundedStrings.ts:14-17`) truncates BY DESIGN and is used across 55 files; it is
**unchanged**, and its signature is grep-pinned so this fix cannot drift into it.

### D6 — a test that asserts the opposite of its own name (`CMNT-19`)

`comments-route.test.ts:105` is named for the author guard and asserts the owner editing
their OWN body; its comment defers to a service test that does not exist, so
`commentsService.ts:238-241` has zero behavioural coverage — which is how the prior pass
counted it as covered. The test is renamed to what it does and a real one is added: a
NON-author's edit is refused. (`tests-that-pin-defects` family: the assertion was fine,
the name and the coverage claim were not.)

### D7 — the UX rows (`CMNT-UX-16`, `-17`, `-18`, `-20`, `-21`, `-22`)

`-16`: `ui/Button.tsx:75` emits a real `disabled`, so every write blurs the focused
control to `<body>`, and **Retry unmounts itself** (`:266`→`load()`→`SkeletonRows`) —
`CMNT-UX-3` was closed on its list-hold half while its headline never landed. Busy
without disabling, and the retry keeps its node (the ADR 0657 `CONS-UX-29` shape).
`-18`: `CommentsHttpError` is delete-only; `asJson` throws a bare `Error`, so post and
update show raw server prose with backticks and the word `MUST` — every lane maps typed.
`-17`: comment notification title/message are backend English (`notifications.ts:55-56`)
in both inboxes while their action link IS localized — the strings move to the ×4 bundle.
`-20`: a `workspace:read` member gets a live composer, Resolve and Delete and learns by
403 — the controls gate on the same access the route requires.
`-21`: unbounded `listThread`, O(n²) `repliesOf`, a full re-render per keystroke — the
pagination in D5 plus a keyed reply index. `-22`: two independent announcements can
coincide in the panel; one live region, and the panel joins `noticeSweepTranche`.

### D8 — one toggle, six features' resources (`CMWF-3`)

The single `comments` toggle gates threads on resources owned by six other features, and
the `sharing` precedent's `owningFeatureEnabled` guard is absent — so a darkened feature's
resource title still leaks through the comment notification. `emitCommentNotification`
consults the owning feature's toggle and, when it is off, **returns without emitting** —
the same early return the self-activity case already takes (`notifications.ts:46`).

*Correction to this decision's own first draft:* it said "suppress the title, not the
notification", and cited `sharing` as the precedent for that. Both halves were wrong.
`sharing`'s `owningFeatureEnabled` (`sharing/sharingService.ts:584,727,929`) 404s at mint
and suppresses the whole card lookup on the list — it never ships a title-less row. And
title-suppression alone yields *"A new comment was added on "."* carrying a live
`actionUrl` into a darkened feature, which is worse than silence.

### D9 — the two resolvers that ignore their org (`CMWF-4`) — REWRITTEN after review

> **The first draft of this decision was unimplementable for both types it named, and
> would have 404'd every existing thread on them.** It said "the resolver derives [org]
> from the writer's ownership". `ChatSessionRecord` has no `orgId` and no owner at all
> (`types.ts:315-330` — "all sessions for a tenant are visible to that tenant's
> principal"); `CanvasRecordView.ownerSubject` is OPTIONAL (`canvasSurface.ts:69,256`) and
> `resolveSubjectOrg` dispatches only on `'project'`/`'board'` kinds, never `kind:'user'`
> (`subjectOrgScope.ts:46`). Adding an org predicate would resolve `null` for every
> pre-existing canvas and chat thread, with no migration. Open Question 5 sensed this while
> the Decision asserted the opposite — the same "a rejected alternative no Decision
> retired" shape as the last two iterations, inverted.

- **`chat_message`:** tenant IS the partition — a chat session is tenant-private by
  construction. The `_orgId` parameter is documented as deliberately unused and pinned by a
  test. No org predicate.
- **`canvas_document`:** org is not derivable. The right gate is the one D1 already builds:
  when a canvas carries an `ownerSubject`, resolve the thread through
  `subjectReadAllowed(tenantId, ownerSubject, caller)` — the SAME seam as `kb_collection`'s
  `boundSubject` — and fall through to tenant scope when it is absent. Additive: an
  owner-less canvas keeps today's behaviour exactly.

This makes `canvas_document` a sixth lane of D1's one predicate, so **`CMWF-4` moves from
P6 into P1**.

### D10 — agent-authored comments are outside DSAR by construction (`CMWF-5`)

`deleteSubjectComments` matches `authorId === subjectKey`, and an agent-authored row's
`authorId` is `agent:${runId}` — so a comment made at a user's direction is unreachable by
their erasure. With D1 the acting subject is already in hand: the row also stamps
`onBehalfOf`, and the eraser matches either field. Trade-off stated: this widens erasure to
rows whose *text* an agent wrote, which is the honest reading — the comment exists because
that person directed a run.

**Gate reachability, measured so nobody moves a baseline on a guess:**
`subject-erasure-coverage.test.ts` enumerates `src/host/**` namespaces only and
`comments:thread` is declared under `src/features` (`commentsService.ts:138`) ⇒ **no
baseline move**. `onBehalfOf` is an opaque principal id exactly like `authorId` ⇒ **no
`declarePiiFields` change** (`:30`). The idempotence test
(`subject-erasure-parity.test.ts:78-82`) writes raw rows and survives a two-field match.
What it CANNOT see is `:57-70`'s "another author's reply survives" under an `onBehalfOf`
stamp — that leg is added.

### D11 — the prompt names two of six types (`CMWF-6`)

The reviewer agent's prompt and the tool description enumerate 2 of 6 `ResourceType`s while
the tool's enum is correct, so the model is told less than the tool accepts. The prose is
generated from `RESOURCE_TYPES` or pinned to it by a parity test — the repo-wide rule that
schema text reaching a model is generated from its SSoT or test-pinned to it.

### D12 — zero host events, therefore zero chains (`CMWF-8`)

Comments emit no host event, so no binding can exist and no chain can be triggered by a
comment (`hostEventDispatcher.ts:243-246`) — the mechanical reason this feature has zero
chain consumers. `host.comments.comment.{created,resolved}` (ids only, ADR 0208 shape) are emitted from
`createComment` / `updateComment`, which take an optional `origin` that the **surface lane
supplies from `BundleScope`** (`workflowId`, `chainId`, `runId`).

**The `origin` is load-bearing, not decoration.** The ADR 0617 D1a self-trigger guard and
the chain-lineage guard are driven entirely by `event.origin.{workflowId,chainId}`
(`hostEventDispatcher.ts:230-260`), and `createComment` has no `BundleScope` — only
`surface.ts:128` does. Without threading it, a chain bound to
`host.comments.comment.created` whose node calls `comments.post` LOOPS — and that recipe
("a review comment opens a task") is this decision's own stated motivation.

Both types are added to `frontend/react/src/settings/hostEventCatalog.ts`
`KNOWN_HOST_EVENT_TYPES` in the same change: `host-event-catalog-parity.test.ts:150,160`
is shrink-only and explicitly refuses a baseline row for a NEW emitter. No RFC — `host.*`
is host-extension fanout to webhooks and bindings, not the OpenWOP run wire. No
double-emit: this is orthogonal to `emitCommentNotification`.

### D13 — recorded, not fixed here

`CMWF-7` (the served-set ledger over-reports discharge by 2 — `a2a.send-and-stream`,
`http.graphql-mutation`; both generators green because no test compares them) is
cross-cutting infrastructure, not this feature: it is recorded in the workflows assessment
and left open deliberately. `CMWF-9` (a fork moves `updatedAt`, the retention age field),
`CMWF-10` (the cascade obligation is unregistered) and `CMWF-11` (ADR 0021 doc rot: a
stale open question already closed) are fixed opportunistically in P6 if they stay cheap;
`CMNT-20`/`CMNT-21` likewise.

### `/architect` review record (2026-09-11, before code)

Five Blockers and seven SHOULD/NITs, all folded above. The Blockers, because the pattern is
now three iterations old and worth naming: (1) a **control witness that was already true
and whose second half was unreachable** — `surface.ts:95-108` already refuses every
no-acting-user run, so the leg would have been born green; (2) `PREAUTHORIZED_CALLER`
prescribed at four cascade sites **that never call the gate at all**, where a literal
implementer would have turned two bounded scans into N lookups; (3) **D9 unimplementable
for both types it named**, and as written a 404 for every existing canvas and chat thread;
(4) D12 emitting from a site that **cannot carry `origin`**, leaving the ADR 0617
self-trigger guard dead against this decision's own example recipe; (5) D1 **never naming
`updateComment`**, whose 403 preserves the exact existence oracle D1 claims to close, plus
an ordering rule impossible for the by-id lanes.

What survived attack: the author≠caller separation itself. Only `surface.ts` has a genuine
split — `routes.ts` and `agentTools.ts:106` already set author = acting user — so the
change is additive on four of the six lanes.

## Alternatives weighed

- **Gate only the HTTP read.** Rejected: the agent tool is the lane that hands the thread
  to a MODEL, and the surface lane writes it into a run's variable bag. Three of the five
  doors are not HTTP. A per-lane fix is how this defect was born.
- **Keep `authorId` as the caller and just add it to the reads.** Rejected — it is the
  bug. It would close `CMNT-15` and *cement* `CMWF-2`: every agent-authored comment would
  keep being refused on subject-bound corpora, and a later session would read the
  now-consistent code as intentional.
- **Make `listThread` filter invisible rows instead of refusing.** Rejected: a filtered
  read is an existence oracle by row count, and there is nothing to filter — the whole
  thread belongs to one target.
- **Deny every subject-bound target outright.** Rejected: it would break the bound
  corpus's OWN members, who are exactly who the threads are for.
- **A `registerCommentable` registry.** Rejected as out of scope and unneeded — see the
  premises above; `TARGETS` is already total, and a registry would make the
  missing-resolver empty reachable where today it is structurally impossible.

## Open questions

1. D4's barrier: refuse the create, or accept and let the next sweep take it? (Leaning:
   refuse — ADR 0657 D10's precedent, and a comment authored by an erased subject is the
   row the DSAR exists to prevent.)
2. D5's per-target cap value, and whether pagination is a breaking change for the panel's
   current all-at-once render.
3. D10: does `onBehalfOf` belong on the row, or should the eraser resolve run → initiator
   at erase time? (Leaning: on the row — the run may be gone, and ADR 0341's precedent is
   that erasure reads what was stamped, never re-resolves.)
4. **ANSWERED by the review, recorded rather than deleted:** org is NOT derivable for
   `canvas_document` or `chat_message`. D9 above is the rewritten decision; this question
   was the only part of the first draft that had it right.
5. Replay asymmetry to pin: `inMemorySurfaces.ts:243-249` says `actingUserId` is
   "re-stamped on `:fork`", ambiguous between *copied verbatim* and *re-resolved*. D1
   asserts the former and pins it. Stated consequence: `feature.comments.nodes.post` is
   classified side-effecting on both legs, so a fork is served the recorded outcome and
   never re-resolves visibility; `…nodes.list` is NOT classified, so a fork by a different
   principal re-resolves and may legitimately return a different thread.

## Phased plan

| Phase | Scope | Closes |
|---|---|---|
| P1 | D1 — the predicate + all six lanes (incl. `canvas_document`'s `ownerSubject`) + the born-red both-direction witnesses | `CMNT-15`, `CMWF-1`, `CMWF-2`, `CMWF-4` |
| P2 | D2 + D6 | `CMNT-UX-19`, `CMNT-19` |
| P3 | D3 + D4 | `CMNT-16`, `CMNT-17` |
| P4 | D5 | `CMNT-18` |
| P5 | D7 | `CMNT-UX-16/-17/-18/-20/-21/-22` |
| P6 | D8 + D10 + D11 + D12 | `CMWF-3`, `-5`, `-6`, `-8` |
| — | recorded, not fixed | `CMWF-7`, `-9`, `-10`, `-11`, `CMNT-20`, `-21` |

## Implementation record (2026-09-11)

| Decision | Landed in | Witness (born red, sabotage-proven) |
|---|---|---|
| D1 author≠caller; `resolveCommentTarget` as THE predicate; required `SubjectCaller` on all four service lanes | `commentsService.ts` (`resolveCommentTarget`, `listThread`, `getComment`, `updateComment`, `deleteComment`, `createComment`), `routes.ts`, `agentTools.ts`, `surface.ts` | `kb-subject-gate-doors.test.ts` "comments READ" (too-open) + "agent-authored" (too-closed). Sabotage A: drop the by-id gate ⇒ red. Sabotage B: restore `{subject: authorId}` ⇒ red. |
| D1 by-id ordering (gate before the author/admin guard; no 403-vs-404 oracle) | `commentsService.ts` `getComment` | same suite — a ghost `commentId` and an invisible one answer identically |
| D1 fail-closed before the resolver | `commentsService.ts` `listThread` | `comments-bounded-reads.test.ts` — this assertion CAUGHT the regression where an unscoped read reached another feature's store with an empty tenant |
| D1 org-admin moderation | `routes.ts` (`PREAUTHORIZED_CALLER` at the one door that already resolved org authority) | `kb-subject-gate-doors.test.ts` — unbound admin deletes, receives no thread |
| D9 `canvas_document` gates on `ownerSubject`; `chat_message` stays tenant-partitioned | `commentsService.ts` `TARGETS` | existing canvas/chat suites (regression guard: owner-less canvas unchanged) |
| D10 `onBehalfOf` on the row; eraser matches either field | `commentsService.ts` | `kb-subject-gate-doors.test.ts` — the initiator's DSAR reaches the agent-authored row |
| D6 the mis-named author-guard test | `comments-route.test.ts` | renamed + a REAL non-author witness; sabotage: no-op the guard ⇒ red |
| D2 + D7 (frontend) | `CommentsPanel.tsx`, `commentsClient.ts`, `CommentsPage.tsx`, i18n ×4, `client/{accessClient,useEffectiveAccess}.ts`, `styles/global.css` | `commentsPanelGoneAndAccess.test.tsx` (29 cases) + 7 sabotage probes, each caught |

**Contract change worth knowing:** `listThread` now returns `Comment[] | null`, where `null`
means the target is absent OR invisible — uniformly. Three existing assertions became
*stronger* as a result: a deleted resource, another tenant's resource, and an unscoped read
now assert `toBeNull()` rather than an empty list, which proves the TARGET died rather than
merely that the rows did.

**Not shipped, stated:** P3 (`CMNT-16` orphan-reply race and the falsified erasure note),
P4 (`CMNT-18` caps and pagination), P5's remaining `CMNT-UX-21` pagination half, D8
(`CMWF-3` owning-feature toggle), D11 (`CMWF-6` prompt↔SSoT parity), D12 (`CMWF-8` host
events + `origin` threading + catalog parity), `CMNT-17` erasure write barrier, and the
D13 recorded-only rows (`CMWF-7`, `-9`, `-10`, `-11`, `CMNT-20`, `-21`).

**Lessons:** the `/architect` pass found FIVE Blockers in the decision text for the third
iteration running — including a control witness that was already true and whose second half
was unreachable, and a decision (D9) that was unimplementable for both types it named. A
migration premise of mine was also wrong in a useful way: "every fixture creates a real
resource" held at CREATE time but not at ASSERT time, which is how the cascade tests
surfaced the stronger contract.
