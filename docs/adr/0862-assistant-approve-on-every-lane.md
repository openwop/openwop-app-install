# ADR 0862 — Assistant: approve what you see, on every lane

Status: implemented (2026-10-08 — D1–D7 on the delivery branch; see the implementation record and corrections. Deploy-window and generic CLI defaults recorded below.)
Date: 2026-10-07
Feature: Assistant capability + Chief of Staff (`assistant`, always-on substrate; FEATURES.md
"Current features") · feature loop round 2, row 36
Extends: ADR 0662 (approve what you see), ADR 0023 §12 T4/T6, ADR 0473 (the hash-pinned
review precedent), ADR 0836 D2 (decide and write on the same row)
RFC verdict: **host extension, no RFC.** Every route touched is under
`/v1/host/openwop-app/*`. No run-event, capability or envelope changes.

## Context

ADR 0662 is `implemented` and its headline reads: "the human-in-the-loop promise is now
mechanically true". Round 2 re-measured it on `origin/main` @ `0476f4746`
(`WORKFLOWS-ASSESSMENT.md` § "Assistant capability + Chief of Staff — round 2 re-grade").
**It is true only on a route that nothing calls.**

| Lane | Carries the hash? | Who uses it |
|---|---|---|
| `POST /assistant/pending-actions/:id/approve` | **required** (`features/assistant/routes.ts:224-227`) | **no client**: `git grep expectedContentHash -- frontend/` finds nothing |
| `POST /approvals/:id/claim` | no. The body is `{note}` (`frontend/react/src/agents/approvalsClient.ts:219-227`). The server branch passes `{decidedByUserId, note}` (`host/approvalDecision.ts:578-582`). The handler type has no hash field (`host/approvalService.ts:593-598`). | **both SPA inboxes** (`notifications/ApprovalsInbox.tsx:285`, `notifications/NeedsYouInbox.tsx:107`) |
| `POST /reviews/:id/actions/approve` | no. It reads only `expectedDefinitionHash`, and only the composed-workflow kind reads that (`routes/reviews.ts:121-124`). | API / unified reviews |

`decideActionViaApproval` then runs the check only when a hash is present
(`actionApproval.ts:198`). So on every real approval the check is skipped, and the green tests
(`assistant-approve-what-you-see.test.ts`, `assistant-action-approval.test.ts`) witness the
unused route. **This is the "a defect closed on one lane survives on its sibling" shape that
0662 itself names, now inside 0662's own fix.**

There are two further gaps in the same decision.

1. **D1 was delivered server-side and never rendered.** The projector sends the per-kind
   fields (`CARD_FIELDS`: `subject`, the `event` body, the reschedule `patch`, `ticketId`).
   Both SPA cards render only `payload.to` (`destinationOf`, `ApprovalsInbox.tsx:70-74`).
   A human still approves a calendar invite without seeing its time, attendees or location.
   That is the defect 0662 opens with.
2. **The edit lane is unguarded.** 0662 says "`editPendingAction` takes the same guard". It does
   not. `PATCH /pending-actions/:id` (`routes.ts:263-283` → `assistantService.ts:813-834`)
   decides `status === 'pending'` on one read and blind-`put`s a row spread from it.
   - A peer edit between the approver's render and their claim executes bytes the approver never saw.
   - An edit landing after the claim's `decidePendingAction('approved')` writes `status:'pending'`
     back onto a consumed approval. That leaves a ghost no lane can decide.
   - Every other action-row writer spreads a stale read the same way:
     `decidePendingAction`, `setPendingActionApproval`, `setPendingActionExecution` and
     `reopenPendingAction` (`assistantService.ts:846-901`).

Market check (Superhuman, Lindy, Fyxer, Microsoft Viva/Copilot, Google Gemini/Gmail,
Reclaim, Martin):
- **No competitor documents binding an approval to the reviewed version.** That makes this the
  product's lead, and it is not currently delivered.
- **All of them let the user edit and then send in one gesture.** Gap (4) in the scan, "edit
  then approve binds to the edited bytes", is therefore the competitive add this ADR ships.
  It falls out of D1–D3 rather than being bolted on.

## Boundaries audit

- **One decision function.** `decideActionViaApproval` (`actionApproval.ts:167`) is already
  the single path for all three lanes (the 0025 §4 single-loop pin). The fix goes there, not
  per-route. A per-route requirement is exactly what produced this defect.
- **One ctx field shape.** `ApprovalDecisionCtx.expectedDefinitionHash`
  (`approvalDecision.ts:95`) is ADR 0473's field. It means "the composed definition", and the
  composed-workflow handler reads it. Reusing it for a different hash would make one field mean
  two things. A sibling `expectedContentHash` is added, read by both thin routes the same way
  (`expectedHashOf`, `routes/approvals.ts:64`).
- **One canonical hash.** `contentHashOf` (`actionApproval.ts:156`) already exists and is the
  only definition. The SPA echoes the projector's value and never computes its own.
- **One CAS primitive.** `DurableCollection.compareAndSwap` (`hostExtPersistence.ts:774`). The
  CRM `casUpdateContact` retry shape (`features/crm/contactsService.ts:692`) is the in-repo
  precedent to copy.
- **One card renderer.** The two inbox surfaces each inline the assistant card body. D3
  extracts ONE `AssistantActionFields`, driven by the server's projected `payload` keys, so a
  third surface cannot drift. Keeping a SPA copy of `CARD_FIELDS` would be the drift this repo
  keeps paying for. The renderer shows whatever fields the projector sent, under a closed label
  map with a raw-key fallback.
- **No new chat, toggle, store or pack.** The assistant is always on and this extends it.

## Decision

### D1 — the hash is required for an assistant-action APPROVE on every lane

- `decideActionViaApproval(…, 'approved', opts)` **refuses before the CAS** when
  `opts.expectedContentHash` is absent: `400 validation_error`, `{field:'expectedContentHash'}`.
  Nothing is consumed.
- It also refuses **before the CAS** with `409 conflict` (`reason:'content_changed'`, the
  current hash in details) when the row's current hash already differs. That is a cheap early
  exit, and it consumes nothing.
- The **post-CAS** check and the two-sided reopen stay as the definitive guard, the ADR 0473
  F2/F3 placement. They now always run, because the hash is always present.
- `AssistantActionApprovalHandler`'s opts gain `expectedContentHash`.
  `ApprovalDecisionCtx` gains `expectedContentHash`.
- `routes/approvals.ts` (claim + reject) and `routes/reviews.ts` read
  `body.expectedContentHash` into the ctx. Reject ignores it, because refusing a changed action
  is still a refusal (0662).
- The reason string `content_changed` already maps to a localized message in the SPA
  (`approvalErrorInfo`, `approvalsClient.ts:157`; ADR 0845). One new key replaces the
  strategy-specific copy for this kind, so the message describes an action rather than a strategy.

**No compatibility window**, for 0662's reason: host-extension routes, no third-party client.
The SPA and the server change in one PR.

### D2 — every action-row write is a CAS against the row it decided on

- A module-local `casUpdatePendingAction(tenantId, actionId, mutate)`:
  - `mutate(current)` returns the next row or `null` (refuse).
  - The swap is `compareAndSwap(current, next)`, retried a bounded number of times on a lost
    race. On exhaustion it throws `conflict` and never falls back to `put`.
- `editPendingAction` decides `status === 'pending'` **inside** `mutate`, on the row it swaps,
  and **requires `expectedContentHash`**: you edit the version you read. A mismatch is a `409`
  with the current hash. The route returns the **projected card**, including its new
  `contentHash`, so the editor's next approve binds to the bytes they just wrote. **This is the
  edit-then-approve binding.**
- `decidePendingAction`, `setPendingActionApproval`, `setPendingActionExecution` and
  `reopenPendingAction` go through the same helper:
  - Each spreads the row it swaps, never a stale one.
  - `decidePendingAction` keeps its "the approval CAS is the lock" semantics and always applies.
  - `reopenPendingAction` refuses unless the row is `approved` with no `executionRunId`, so it
    cannot reopen something that ran.

### D3 — the card shows what it executes, and sends what it showed

- One shared `AssistantActionFields` (in `notifications/`, lazy with the inbox surfaces)
  renders every field of the projected `payload`:
  - scalars as text;
  - the `event` / `patch` passthrough objects as a labelled list (start, end, attendees,
    location, summary), with a JSON fallback for keys outside the label map.
  - Both cards use it, and `destinationOf` is retired.
- `AssistantActionView` gains `contentHash`.
  - `claimApproval(approvalId, note?, opts?)` sends `expectedContentHash` when the caller passes it.
  - The two assistant cards pass `action.contentHash`.
  - `editAssistantAction` sends it and adopts the returned card.
- After an edit, the card **must re-read** before Approve is enabled. The returned card is
  adopted into local state. An approve with the pre-edit hash would 409, which is correct but a
  bad experience.

### D4 — the board projection cannot mint two cards (`COS2WF-3`)

`projectCommitmentToBoard` creates the card, then CASes `kanbanCardId` onto the commitment row
it read. If it loses the CAS, it deletes the card it just created and returns the winner's card
as `reused`.

### D5 — node handlers honour config (`WF-COS-11`)

`I(ctx)` becomes `{...ctx.config, ...ctx.inputs}`, with inputs winning, as with every other
pack that hit RFC 0013 Path A. All 18 nodes are builder-palette primitives, and today a
config-set `description` is a `validation_error`.

### D6 — the loops run through the real executor (`WF-COS-7`, `PROBE-COS-2`)

A permanent test runs `assistant.loop.morning-briefing` through `startWorkflowRun`, then
`:fork`s it. It asserts **one** notification row, not two (the `compose-briefing`
side-effect classification witnessed end to end rather than by table lookup). A second leg runs
`calendar-ingest` with a stubbed fetch returning a 401 and asserts the run is NOT `success`.

## Alternatives weighed

- **Require the hash per route (status quo plus two routes).** Rejected. That is how the defect
  happened, because the requirement lived at a route and the decision function stayed
  permissive. Requiring it inside the single decision function covers any future lane by
  construction.
- **Reuse `expectedDefinitionHash` for the action hash.** Rejected. One field would mean two
  hashes over two different objects. The composed-workflow handler would also start receiving
  action hashes on a mixed-kind client.
- **Compute the hash in the SPA.** Rejected. A second canonicaliser would drift. The client
  echoes, and the server owns the definition.
- **Undo/cancel window after approve (market gap 1).** Deferred, not dropped. It needs a durable
  delayed dispatch: Cloud Run kills an in-process timer, so it would ride the scheduler as a
  one-shot job with a `cancelled` state. The re-verify against the hash at fire time is its own
  replay question. It gets its own ADR.
- **Sent-mail "waiting on" tracking (gap 2).** Deferred. It needs a new Gmail read scope and a
  fourth ingestion loop, which is a connection-scope decision for the owner.
- **Done / Remind me on briefing items (gap 3).** Deferred. The commitments graph still has no
  readable UI (`AST-UX-4..22`), so the buttons would have no home.
- **Rule-scoped autonomy and retry from the failure receipt (gap 5).** Deferred. These are policy
  design work. `isAutoAllowEligible` is the seam they would extend.


## /architect pass (pre-code, 2026-10-07) — 3 Blockers, 2 Highs in the decision text; all folded in

> **The lane inventory this ADR was built on was itself incomplete.** It's the same mistake it
> diagnoses in 0662, one level up. An independent adversarial read found:
>
> - **B1 — a THIRD SPA approve lane:** the agent drawer (`agents/AgentDrawer.tsx:89`).
>   - It calls `claimApproval(a.approvalId)` for every pending approval on the agent's roster,
>     and assistant actions carry the assistant's `rosterId`.
>   - It renders only the 77-char summary (`:185`), so it is approve-blind today. Under D1 it
>     would be a button that always returns 400.
>   - **Decision:** for `assistant-action` the drawer offers **Review** (a deep link to
>     `/inbox?approval=<id>`) instead of Approve. The drawer is too narrow to render what an
>     approver must see.
> - **B2 — `/reviews` is a LIVE SPA lane, not "API":** `ReviewCard` / `ReviewInboxPanel` /
>   `ConversationReviewsStrip` decide through `decideReview`.
>   - `withAssistantActionView` (`host/reviewProjection.ts:536-585`) projects no hash and no
>     card fields.
>   - `reviewStatusStore.ts:227-233` treats any other 409 as `already-resolved`. A
>     `content_changed` 409 would therefore drop a card the server just reopened.
>   - **Decision:** the review projection gains
>     `assistantAction: {actionId, kind, contentHash, payload}`, using the same projector output.
>     `ReviewCard` renders the shared fields component and echoes `expectedContentHash`.
>     `content_changed` joins the still-pending set.
> - **B3 — the first-party CLI** (`../openwop-cli`, `approvals claim`, `assistant pending edit`)
>   sends neither hash, so "no third-party client" was false.
>   - **Decision:** the CLI gains `--content-hash` through `/update-cli`. It is a separate repo
>     with its own release, so this is an owner decision for sequencing (see open questions).
>     The server message names the fix, so a CLI user is told what to pass.
>     **Correction 2026-10-08 — delivery review:** the dedicated assistant pending approve
>     command already carries the hash. The remaining release sequencing concerns the generic
>     `approvals claim` command; its missing flag fails closed and is follow-up convenience work.
> - **H1 — bounded retry after the approval CAS can lie.** If `decidePendingAction` exhausts its
>   retries after `resolveApproval` consumed the approval, the result is an approved approval
>   with a pending action: the ghost.
>   - **Decision:** on that path an exhausted decide **reopens the approval** before throwing
>     (two-sided, like the hash mismatch).
>   - In practice it cannot exhaust: every competing writer refuses once the status is not
>     `pending`, and erasure is now CAS too.
> - **H2 — a SIXTH writer:** erasure (`features/assistant/erasure.ts:328-342`) blind-puts a spread
>   of a list read. It could wipe `executionRunId` and defeat the new reopen guard.
>   - **Decision:** erasure goes through `casUpdatePendingAction` and redacts the CURRENT row.
>
> **Mediums folded in:**
> - The assistant branch of `approvalDecision.ts:578-582` must pass the hash; it is named in P1.
> - The post-CAS check is hoisted out of the `execDeps` guard (`actionApproval.ts:193`) so
>   "always runs" is true on every host.
> - Every content 409 carries `reason:'content_changed'`. The SPA maps it with the approval's
>   KIND (a new `approvalActionChanged` key), so an action is not described as a strategy.
> - D4: after a lost CAS, re-read. Reuse the winner's card only if `kanbanCardId` is now set;
>   otherwise retry the CAS. A lost CAS can come from an unrelated ingest update, and deleting
>   your card on that path would drop a valid card.
> - D6: the fork point is stated (after `compose-briefing` completed), or the test witnesses nothing.
> - **Deploy order:** backend-first means every inbox approve returns 400 until the SPA lands,
>   and longer for tabs left open. The server's 400 message is written for a human ("This
>   approval card is out of date — reload and review it again"), because an old bundle shows
>   `err.message` verbatim (`decideError`). Rejected alternative: a two-PR, two-deploy flip,
>   which 0662 also rejected. The window is the deploy gap plus stale tabs. **Owner decision 1.**
>
> **Lows recorded:**
> - `assistant-action` approvals carry no quorum policy (`approvalService.ts:533-545`), so the
>   check-on-finalize is sufficient. A test pins "no policy".
> - The renderer is text-only. No field becomes an `href`: `location`, `htmlLink` and
>   conference URIs are untrusted provider content.
> - Passthrough values are shown through `stripSecretsFromPersisted`. The hash covers the raw
>   payload while the card shows the redacted one. That is accepted, because redaction only
>   removes secrets the approver must never see anyway.
> - The `casUpdateContact` citation is the CAS SHAPE, not a retry shape.

## Phased plan

| Phase | Scope | Witness (RED first) |
|---|---|---|
| P1 | D1 server: ctx field, both routes read it, handler type, required-before-CAS + early mismatch | `assistant-approve-every-lane.test.ts`: claim via `/approvals/:id/claim` with no hash → 400, and the approval stays `pending` (today 200); same via `/reviews`; peer edit after render → claim with the old hash → 409, nothing executed |
| P2 | D2 CAS helper + all SIX writers (incl. erasure); exhausted decide reopens the approval; edit requires the hash and returns the card | same file: edit with a stale hash → 409; an interleaved edit after `decidePendingAction` cannot leave `pending`; reopen refuses a row with `executionRunId` |
| P3 | D3 SPA: shared fields renderer on the inbox cards AND `ReviewCard` (review projection gains `assistantAction`), drawer offers Review not Approve, `content_changed` stays pending in the review store, `contentHash` echo on approve and edit, adopt the returned card | `notifications/__tests__/assistantActionCard.test.tsx`: a calendar invite renders start/attendees/location; approve sends `expectedContentHash`; after an edit the approve sends the NEW hash |
| P4 | D4 board CAS | `assistant-board-projection-race.test.ts`: two concurrent projections → one card, and the loser's card deleted |
| P5 | D5 + D6 | `assistant-node-config-merge.test.ts`; `assistant-loops-real-executor.test.ts` |

## Correction to ADR 0662 (same PR)

0662's D2 status line is corrected inline:
- "required on approve" held on one of three lanes until this ADR;
- the "same guard" sentence on `editPendingAction` described code that did not exist;
- D1's card was delivered server-side only.

## Open questions / decisions

- [ ] **Owner decision:** whether the undo window (gap 1) is wanted before sent-mail tracking
  (gap 2). Both are deferred with reasons above.
- [x] Does any non-human caller claim assistant actions? None in this repo:
  `workflowComposeTool.ts:639` claims composed-workflow approvals only, and SLA expiry skips this
  kind (`approvalDecision.ts:457-460`). **But a first-party human client does: the CLI (B3).**
- [x] **Deploy-window default (2026-10-08 delivery):** backend first, then SPA; an older card
  fails closed with 400 and the person must reload and review it again. Record this consequence
  in the release notes. The separate two-deploy flip is not used.
- [x] **Generic CLI default (2026-10-08 delivery):** `openwop approvals claim` refuses assistant
  actions until that generic command carries `--content-hash`; its convenience flag is follow-up
  work in the separate CLI repository. The dedicated `openwop assistant pending approve` command
  already carries the hash. A CLI release is not required in lockstep for this delivery.
- [x] In-flight-card consequence recorded: any approval rendered before the deploy has no `contentHash`
  in the SPA's memory, so its approve returns 400. A reload fixes it. This is a release note, the
  same consequence 0662 accepted for `CARD_FIELDS` changes.
  These defaults also preserve the release decisions recorded on `feat/fl2-36-assistant-land`
  at `dd1ff8d289d67aa0fdcbad508965c362f7ebc3b9`.
- [ ] Owning-workspace live witness: count pending assistant cards before release and verify an
  authenticated approval. This requires its session; anonymous smoke probes do not substantiate
  either result. The original scratchpad count request remains outstanding.


## D7 — a loop refused by its connection stops burning runs (added 2026-10-08, orchestrator scope)

**MEASURED in production (from the orchestrator's read-only prod pull):**
- From 2026-09-08 to 09-29, `assistant.loop.calendar-ingest` failed 824 runs and `drive-ingest`
  failed 409, one every 30 minutes.
- Nearly all of them carried `upstream_unavailable` with "assistant ingest failed upstream (HTTP
  403) — the credential may have expired". There have been none since 09-29.

**What was already fixed, and what was not.** c29aeacd6 (2026-09-28) replaced that message with
Google's machine reason:
- 401 → `connection_reauth_required`;
- 403 → `connection_scope_missing` / `provider_api_disabled` / `connection_forbidden`;
- and an unattended failure now notifies once per workflow and code per 24 h.

The prod messages are the pre-fix text, so the mapping half of the orchestrator's ask is already
true at HEAD. It is more precise than "map 401/403 to reauth": a 403 is a valid token WITHOUT the
scope, and every 403 class lands in the reconnect set either way.

**What was still true:** a refused loop keeps firing every tick, and every tick is a failed run.

**Decision:**
- After `AUTH_PAUSE_AFTER = 3` consecutive SCHEDULED runs refused for a reconnect-class code
  (`notify.ts` `RECONNECT_CODES`, now exported, so there is one list), the loop disables its own
  job. It notifies the person it acts as ONCE, linking to Connections, and records
  `autoPausedCode`/`autoPausedAt`. The panel says why and links the fix.
- A failure for any other reason neither counts nor resets: a flaky upstream is not a dead
  connection.
- A success resets the count.
- A person re-enabling the loop is the "I reconnected" signal, and clears it.
- Manual runs never count.
- Witness: `test/assistant-loop-auth-pause.test.ts`. It goes red when the pause branch is removed.

**Correction 2026-10-08 — delivery review:** schedule metadata is provenance, not proof of a
new cron fire: forks copy it, and Run now uses `trigger: manual`. Health requires a root run
with `trigger: cron`, the matching tenant/workflow job, and the stored terminal status.
The terminal fan-out is repeatable; incrementing after a separate read was not idempotent or
atomic. The existing scheduler `updateJob` accepts a pure computed patch re-applied inside
its CAS. Each observation is recorded in that same job-row CAS, counts derive from its current
row, and only the winning enabled→paused transition emits a notice. Re-enable and successful
resets retain dedupe receipts. A bounded ledger keeps 64 run IDs with a canonical
`(createdAt, runId)` eviction high-water mark; older delayed observations cannot rewrite
current health. This deliberately drops ancient observations outside that window. Witnesses
cover duplicate delivery/reset/re-enable, concurrent failures, both forks, manual runs, and
eviction. This is host-only behavior; no wire, endpoint, or advert changes.

**Correction 2026-10-08 — D3 loading:** approval controls share the fields renderer's loading
boundary, including its translation namespace. Cold/slow chunks cannot expose an enabled
Approve button before provider-sent fields are visible. The regression holds that namespace
pending on all three approval surfaces.

**Correction 2026-10-08 — unified review permission:** withholding the assistant card left
the original review's approve/reject actions visible in `ReviewCard`, even though the reader
could not see the card or obtain its approval hash. Pending assistant reviews now project
`canDecide: false` when the action ID, projector or action is missing, or the card is withheld.
Both list and single-review reads preserve that refusal even when quorum membership grants
eligibility. The card uses the existing workspace-access remedy rather than claiming that
the reader was excluded from a named approver list. The real-projector read-gate regression
checks both read paths, missing-card branches and an eligible quorum; the UI regression
checks hidden decision controls and permission copy. Resolved audit rows are unchanged.

**Alternative rejected:** auto-resume when the connection is re-granted. That needs a
connection-granted event this host does not emit to features. Re-enabling is one click on the
same panel that now names the problem.

## Implementation record (2026-10-08)

Commits are cited by SUBJECT, because a rebase moves shas.

| Decision | Commit subject | Witness (born RED or sabotage-proven) |
|---|---|---|
| D1 + D2 | `fix(assistant): approve-what-you-see on every lane + CAS on every action-row write` | `assistant-approve-every-lane.test.ts`. Five arms were red on `0476f4746`: a claim with no hash returned 200, and a peer edit followed by a claim with the old hash returned 200 and executed the edited bytes. `assistant-approve-post-cas-check.test.ts` opens the window between the early check and the CAS with a partial mock, and goes red when the post-CAS check is removed. Removing the in-CAS edit gate also turns it red. |
| D3 | `feat(assistant): the card shows what it sends and approves exactly that, on every surface` | `notifications/__tests__/assistantActionCard.test.tsx`, `chat/reviews/__tests__/ReviewCard.test.tsx`, `reviewStatusStore.test.ts` (`action_changed` stays pending), `i18n/__tests__/namespaceSplit.test.ts` (the lazy `assistantAction` area) |
| D4 | `fix(assistant): board projection CAS, …` | `assistant-board-projection-race.test.ts`. Two in-flight projections minted 2 cards on the old code. |
| D5 | the same commit, plus `the three envelope-reading nodes keep raw inputs` | `assistant-node-config-merge.test.ts` |
| D6 | the same commit | `assistant-loops-real-executor.test.ts`. Removing both classification legs makes it read 2 emits. |
| grade-ux | `grade-ux Blockers — card deep-link focus, all-day dates, failed-loop honesty, health verdict` | `COS2UX-1..12` in `UX-ASSESSMENT.md` |
| grade-code | `grade-code — foreign-board write refused, card read gate, commitment CAS, erased approve refused pre-CAS` | `COS2C-1..4` in `CODEBASE-ASSESSMENT.md`. The foreign-board test goes red under sabotage. |

**Corrections found while implementing:**

1. **The D6 witness as first written could not fail.** The notification store COALESCES a
   repeated unread notice ("stop re-alerting every tick"), so counting notification ROWS read 1
   even with both side-effect classification legs deleted (measured). The test now counts EMITS
   at the emitter seam and reads 2 under the same sabotage. Any earlier "a fork does not
   re-notify" claim that rests on a row count has the same blind spot.
2. **A reason string.** The assistant refusal reason is `action_changed`, not the strategy gate's
   `content_changed`. A client maps reasons to copy without knowing the kind, and "the strategy
   changed" is the wrong sentence for an email.
3. **Two more server-only deliveries from ADR 0662,** both found by `/grade-ux`:
   - D3's `lastRunStatus` was projected and never rendered. In production the calendar loop
     failed 824 of 1,412 runs in 30 days while the panel read green.
   - The loop's `lastRunErrorCode` is now projected too: the code only, never the message.
4. **`/grade-code` found an older cross-tenant write** inside the D4 function (a
   caller-controlled `boardId`; personal board ids are derivable), and a read leak that D3
   widened: the card projector served drafts to viewers. Both are fixed here. The frozen
   approval `proposal` summary is a stated residual (`COS2C-6`).

**Entry bundle:** the single entry-chunk content change is one extra reason in
`reviewStatusStore`'s still-pending check (+22 B raw, measured by normalising chunk hashes and
diffing the entry). Everything else is lazy: the `assistantAction` module, its namespace, and the
inbox, drawer and review chunks.
