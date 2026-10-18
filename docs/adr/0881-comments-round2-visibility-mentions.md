# ADR 0881 — Comments round 2: a thread is as private as its target, notifications re-check the reader, and @mentions

Status: implemented (2026-10-13, branch `feat/fl2-41-comments` — D1–D10 plus the grade-ux/grade-code fixes; phase table at the end). Accepted after the pre-code `/architect` pass recorded under Decision. Feature loop round 2, row 41.

Extends ADR 0021 (comments), ADR 0643 R3 (subject-bound KB targets), ADR 0659 (the
author ≠ caller split, `onBehalfOf`), ADR 0820 §8.1 (owning-feature entitlement for
`priority_idea`). Keeps the `comments` toggle id. No new feature package, no new
toggle. Host extension only — no wire change (verdict below).

## Context

Round 1 closed comments at A− / A− / A− (ADR 0659). Re-measured on `origin/main` @
`64182ad12`. The design ADR 0659 left is right: every lane (HTTP route, the
`openwop:comments.*` chat tools, the `ctx.features.comments` workflow surface) resolves
the commentable target through ONE predicate, `resolveCommentTarget`, and the caller is
passed separately from the author. That design also means one wrong resolver is wrong on
every lane at once, and three were.

### Security findings (each proved RED first)

`backend/typescript/test/comments-round2-security.test.ts`, run against `64182ad12`
before any fix: **3/3 failed, each for its stated reason.**

| # | Finding | Measured |
|---|---|---|
| S1 | `chat_message` resolves by **tenant only** (`commentsService.ts:95-102`). A conversation is owner/participant-private (`host/conversationVisibility.ts` `isVisibleToAsync`), so any workspace member reads and writes the comment threads on another person's private chat or private channel. | The conversation itself 404s for the second member (control); `GET …/comments?resourceType=chat_message` answered **200 with the owner's comment body**, and a POST into it answered 201. |
| S2 | The **owning feature's entitlement** is not consulted for the two types whose owner HAS a toggle (the open `CMWF-3`). Only `priority_idea` got ADR 0820's check. | With `creative-briefs` OFF, a brief thread answered **200** on read and accepted a write. Same shape for `document-editor` (`canvas_document`). |
| S3 | A notification is addressed to the resource owner / parent author **without asking whether that person can still see the resource**. | A member removed from the org received *"A new reply was posted on “Layoff plan Q4”"* — a private title, through the inbox. |

Probed and **not** a defect (recorded so the next pass does not re-hunt them):

- **Cross-tenant / cross-org by id** — `getComment` checks tenant + org before the gate;
  `parentId` must be on the same thread (`commentsService.ts` `createComment`).
- **Editing / deleting other people's comments** — body edit is author-only; delete is
  author or org admin, with the foreign-reply 409; resolve is member-level by design
  (Docs/Notion/Linear all let any commenter resolve).
- **Viewer writes** — HTTP `workspace:write`; chat tool `resolveActionOrgScope`
  (`workspace:write`); workflow surface `assertOrgScope(…, 'workspace:write')`.
- **Stored XSS** — the body renders as a React text node (`CommentsPanel.tsx`), no HTML
  path anywhere; no attachments exist.
- **Realtime** — there is no comments subscription, so nothing to subscribe to.
- **DSAR** — authored + `onBehalfOf` rows erased; notification residue is erased by
  `host/notificationSubjectErasure.ts`; retention purger present.
- **Removed member's own access** — `requireOrgScope` refuses them at the door.

### Competitive gaps

From `docs/steward/UX_UPGRADE-comments.md` (Notion, Google Docs, Confluence) plus
Figma and Linear, which all ship the same contract:

| Capability | Docs | Notion | Figma | Linear | Ours |
|---|---|---|---|---|---|
| @mention a person, who is notified | yes (offers to share if they lack access) | yes | yes | yes | **no** |
| Everyone in the thread hears about replies | yes | yes | yes | yes (subscribers) | parent author only |
| "Resolved by X" | yes | yes | yes | n/a | **no** |
| Edit own comment, "(edited)" | yes | yes | yes | yes | API only, **no UI, no marker** |
| Only offer actions you can take | yes | yes | yes | yes | delete offered on every row (403s) |
| Automation on new comment | Apps Script | API/webhooks | webhooks | webhooks | **none** (`CMWF-8`) |

## Decision

> **Pre-code `/architect` pass (2026-10-13) — 1 CRITICAL, 4 HIGH, 6 MEDIUM, all folded
> in below; each correction is marked inline.** The CRITICAL: the first draft's S2 was
> FALSE — it claimed `cms` and `kb` threads ignored their owner's toggle, but both are
> ALWAYS-ON (no toggle, ADR 0027), the probe's `setToggle('cms','off')` silently did
> nothing, and D2 as drafted (`Boolean(resolveOne('cms')?.enabled)`) would have 404'd
> every CMS and KB thread on every lane, because `resolveOne` answers `null` for an id
> with no toggle. The probe now witnesses `creative-briefs`, and asserts the toggle
> exists.

### D1 — `chat_message` follows the conversation's visibility (closes S1)

The resolver keeps today's existence check (`getChatSession` — *correction H3: the
visibility predicate answers `true` for a `null` meta, so dropping it would make any
made-up `sessionId#x` commentable*) and then answers `null` unless
`isVisibleToAsync(meta, tenantId, principal)` — the SAME predicate the chat sessions
routes use, not a copy. `PREAUTHORIZED_CALLER` passes (admin moderation). A
caller with no subject is refused on an owned conversation (the predicate already does
that). A legacy unowned session keeps its tenant visibility (unchanged, the predicate's
own back-compat rule). The session title stays the thread title.

Identity (*correction H4 — the draft's "for cookie sessions these are the same value"
was FALSE*): a conversation's `ownerUserId` is stamped as `req.userId ?? principalId`
(`routes/chatSessions.ts` `actingUserOf`), and for an unbound OIDC session — the normal
SPA path whenever `/oidc/bind` failed — `req.userId` is unset, so the owner is
`oidc:<sub>` while the canonical user is `user:<hash>`. So the predicate is asked with
the DOOR's spelling: comments gets a feature-local `CommentCaller` (extends
`SubjectCaller`, never widening the shared type) whose `principal` is
`req.userId ?? req.principal?.principalId` on HTTP and `scope.actingUserId` on the chat
tool and workflow lanes (already that spelling). `subject` stays the canonical user for
every other resolver.

Archived channels (*correction M5*): the predicate keeps an archived channel readable,
and the chat routes refuse writes into one. A comment thread is a write, so
`createComment` refuses a new comment on an archived channel's message (409
`conflict`); reading, resolving and deleting stay allowed.

### D2 — every resolver declares its owning feature, checked in ONE place (closes S2, `CMWF-3`)

`CommentTarget` gains `featureId: string | null`: `creative_brief → 'creative-briefs'`,
`canvas_document → 'document-editor'`, `priority_idea → 'priority-matrix'`, and
`null` for `cms_page`, `kb_collection` (both ALWAYS-ON, no toggle — *correction C1*)
and `chat_message` (core chat). `null` means always on — the sharing registry's
precedent (`sharingService.ts` `toggleId: null`). `resolveCommentTarget` checks a
non-null owner with `resolveOne(featureId, toggleSubject)` (toggle + plan, ADR 0819 — an
authenticated lane, so the paywall applies) BEFORE the resolver runs, fail-closed on a
resolver error, answering the same uniform `null`. The toggle subject on HTTP is
`toggleSubjectOf(req)` (*correction M1*: it carries the principal id the cohorts key on
and the listed operator's `planExempt`); on the tool and workflow lanes it is
`{ tenantId, userId: actingUserId }`, `resolveFeatureAccess`'s shape. A drift test pins
every non-null `featureId` to a registered toggle default, so a typo cannot 404 a whole
type.
`priority_idea`'s private check moves into this one place. Because `TARGETS` is a
`Record<ResourceType, …>`, a seventh type cannot compile without declaring its owner.

### D3 — a notification goes only to someone who can still read it (closes S3)

One function, `deliverableRecipients`, filters every candidate before an emit:

1. not the actor (and not the actor's `onBehalfOf` human);
2. a human principal: an `agent:<runId>` author is replaced by the row's `onBehalfOf`
   (ADR 0659 D10), or dropped when there is none (`CM2WF-6` — those were addressed to
   nobody);
3. is a member of the comment's org — `listMembers(tenantId, orgId)` matched on
   `member.subject`, the key member rows are written under (*correction M2*:
   `resolveEffectiveAccess` is NOT the test, because in demo mode it grants owner to an
   unknown subject in a single-principal tenant);
4. `resolveCommentTarget(…, { subject: recipient })` is non-null — the recipient can see
   the target (D1/D2 included, so a private conversation or a paywalled feature never
   notifies).

Failures are dropped silently by design (an unreachable recipient is not an error of
the writer's), logged at debug with a count, never with ids. Cost (*correction M3*):
the org member list is read ONCE per comment and the target is resolved once per
distinct recipient; the fan-out is capped (D4), so a reply costs at most ~70 resolver
reads. Verified: human-created resources' `createdBy` is the member-row key
(`cms/routes.ts` `createdBy: user.userId`), so owner notifications do not regress; the
ids D3 drops (a workflow page's `createdBy = runId`) already reached nobody.

### D4 — thread participants hear replies; one notification per person

Recipients for a new comment:

- **root comment** → the resource owner (`comment.added`), as today;
- **reply** → the root's author and every earlier replier (`comment.reply`) — the
  Docs/Notion/Figma "everyone in the thread" rule — capped at 50 distinct people;
- **mentions** (D5) → `comment.mention`.

A person on several lists gets ONE notification, highest precedence wins: mention >
reply > added. All pass D3.

### D5 — @mentions, member-only and visibility-checked

`POST …/comments` accepts `mentions?: string[]` (org member subjects, ≤ 20). The body is
free text and is not parsed: the client picks people from the org directory and sends
their subjects, so there is no `@name` → person guess on the server.

- An id that is not a member of the comment's org (`listMembers` + `member.subject`) → **400** `validation_error`
  (`field: 'mentions'`), nothing written. The channels S3 lesson: never accept any
  string as a person.
- A member who **cannot see the target** (D3.3–4) is not stored and not notified; the
  201 response returns their subjects in `unnotifiedMentions`, so the author is told
  ("Dana can't open this page, so they weren't notified") rather than silently dropped.
  This tells the author that a colleague lacks access to a resource the author can see —
  Docs does exactly this, and the author already sees the directory.
- `PATCH` with a new `body` may carry `mentions`; only subjects not already on the row
  are notified (edits never re-notify).
- Stored as `mentions: string[]` on the row and returned by every read.
- **HTTP lane only.** The chat tool and the workflow node do not accept mentions: an
  agent that can page people by name is a spam lane with no human in it. Recorded as
  OQ-2.

### D6 — resolution and edit metadata

`resolvedBy` + `resolvedAt` are stamped on an open → resolved transition and cleared on
reopen; `editedAt` on a body change. When someone other than the root author resolves a
thread, the root author gets `comment.resolved` (through D3). A re-resolve of an already
resolved comment is a no-op: no stamp change, no notification, no event.

*Correction H1 — "only on a transition" is NOT sufficient for replay, and the draft's
matrix claims were false.* `resolve` is deliberately unclassified today
(`executor/sideEffects.ts`, pinned by `comments-node-replay.test.ts`: "revisit if
`resolve` ever gains a notification or a `resolvedBy` audit row"). D6 adds both, and if
the comment was reopened between the source run and a `:fork`, the re-run makes a real
transition again. So `feature.comments.nodes.resolve` becomes a side-effect on BOTH legs
(pack `role:"side-effect"` + the `sideEffects.ts` pattern, floor regenerated, the pin
test flipped), served from the recorded outcome on `:fork`, and the node pack is bumped
(1.1.1 → 1.2.0, `requiredPacks` with it). An agent resolution stamps
`resolvedBy = agent:<runId>` AND `resolvedOnBehalfOf = actingUserId` (*correction M4*,
mirroring ADR 0659 D10) so erasure reaches it.

### D7 — the thread read says what the caller may do

`GET …/comments` returns `{ comments, viewer: { userId, canWrite, canModerate } }`
(`canModerate` = org admin/owner, the delete rule's own predicate). The panel offers
Edit only on the viewer's own comments, Delete only on own or when `canModerate`, and
nothing that 403s. *Correction M6:* a non-moderator's own root that carries other
people's replies answers 409; the panel computes that from the thread it already holds
and offers Resolve instead of Delete there. The precedent is ADR 0842's `viewer:{canWrite,canConfigure}`.

### D8 — comments emit host events (closes `CMWF-8`)

`host.comments.comment.created` and `host.comments.comment.resolved`, ids only
(`orgId`, `resourceType`, `resourceId`, `commentId`, `parentId?`), awaited and
never-throwing like every other emitter, added to the RFC 0236 list
(`host/hostEventTypes.ts`). From the workflow surface they carry `origin: { runId }`
(ADR 0617 self-trigger guard). **Not emitted for a RESTRICTED target** (*correction H2 —
the draft excluded only `chat_message`, but the same rationale covers every target
whose visibility is narrower than the org*): the resolver reports `restricted: true`
for a `chat_message`, a subject-bound KB collection, a `canvas_document` with an
`ownerSubject`, and a priority idea on a project-bound list. The webhook fan-out is
tenant-wide and a binding's run acts for nobody, so the existence of activity on a
restricted target is itself the leak. A chain can now be bound to "a comment was added
to a CMS page".

Caveat stated, not fixed: a binding-started run has no `actingUserId`, so its
`ctx.features.comments.list/post` refuse with the named-exit 403 (`surface.ts`). A bound
chain can react to the ids (route, notify, open a card) but cannot read or reply to the
thread. That is the correct posture for a run that acts for nobody; see OQ-4.

### D9 — model-facing prose generated from the SSoT (closes `CMWF-6`)

The `comments.list` / `comments.post` descriptions enumerate `RESOURCE_TYPES` at build
time; `prompts/comments-reviewer.md` lists all six; a test pins every type to the prompt
and both descriptions. The agent pack is bumped with its prompt.

### D10 — erasure reaches the new person-shaped fields

`deleteSubjectComments` also strips the subject from other rows' `mentions` and clears a
`resolvedBy` / `resolvedOnBehalfOf` naming them. Same eraser id, so the eraser manifest
is unchanged. Free text that names a person stays the author's speech (the
same rule ADR 0879 applied to channels).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extends `features/comments/` only. Core edits: `host/hostEventTypes.ts` (one list entry family, required by RFC 0236's emission gate). No core→feature import. |
| 2 | Toggle | `comments` unchanged (off, `tenant`). D2 adds the owning feature's toggle as a SECOND gate per target; it never widens. |
| 3 | Workflow surface | `ctx.features.comments.{list,post,resolve}` unchanged in shape; inherits D1/D2/D3 through the shared predicate; `resolve` stamps `resolvedBy = agent:<runId>`. |
| 4 | Node pack | `feature.comments.nodes` 1.1.1 → 1.2.0: `resolve` reclassified side-effect (D6 / correction H1). |
| 5 | AI chat / envelopes | No envelope. Tools inherit D1/D2. D9 fixes their prose. |
| 6 | Agent pack | `vendor.openwop-app.comments.agents` prompt fix (version bump). |
| 7 | Public surface | None. |
| 8 | RBAC | D1–D3, D5 (member-only mentions), D7. Read `workspace:read`, write `workspace:write`, unchanged. |
| 9 | Replay / fork | `post` and now `resolve` are side-effects, served from the recorded outcome on `:fork` (correction H1). `assertEffectAllowed` throws `ReplayEffectError` on a replay that would re-emit; the classification is what keeps the guard from being reached. |
| 10 | Frontend | `CommentsPanel`: mention picker + chips, edit-own inline, "(edited)", "Resolved by", capability-gated actions, the `unnotifiedMentions` notice. Notification types `comment.mention` / `comment.resolved` in the presentation maps, 4 locales. |

## Alternatives weighed

- **Parse `@Name` out of the body on the server.** Rejected: display names are not
  unique, and a guess that pages the wrong person is worse than no mention. The client
  already holds the directory; it sends ids.
- **Refuse the whole comment when a mentioned person can't see the target.** Rejected:
  it blocks the author for a fact about someone else. Docs posts and offers to share;
  we post and say who wasn't told.
- **Emit host events for `chat_message` with the session id redacted.** Rejected: a
  thread with no resource is useless to a binding, and the existence of activity in a
  private chat is itself the leak.
- **Check the owning toggle with `resolveToggle` (no plan).** Rejected: comments is an
  authenticated lane; ADR 0819 makes `resolveOne` the default and `resolveToggle` the
  ratcheted opt-out for public/money lanes.

## Phased plan

| Phase | Scope |
|---|---|
| P1 | D1, D2, D3 + `CM2WF-6` (security). The RED file goes green. |
| P2 | D4, D5, D6, D7, D10 (service + routes + tests). |
| P3 | D8 host events + D9 prose parity. |
| P4 | Frontend: D5 picker, D6/D7 affordances, notification presentation. |

## RFC verdict

Host extension only. Routes are under `/v1/host/openwop-app/*`. The host-event types are
host-extension types in the `openwop-app` namespace; RFC 0236 makes the advertised list
the emission gate, and adding to it is this host's decision (`hostEvents` is still behind
`OPENWOP_HOST_EVENTS_V2`). No envelope, capability, or run-event change.

## Open questions

- **OQ-1** Bearer-lane identity for `chat_message` (D1): the canonical user and the
  conversation's stamped owner can differ on a personal-tenant API-key lane, and the
  check fails closed there. Passing the door's principal through `SubjectCaller` would
  widen a shared type the subject seam deliberately keeps narrow. Leave closed; revisit
  if an API-key client needs message threads.
- **OQ-2** Agent mentions (D5): should an agent be able to mention the human it acts for
  (and only them)? Deferred; no lane accepts mentions but HTTP.
- **OQ-4** A comment-triggered chain cannot read the thread (D8 caveat). Running it as
  the comment's author would hand a binding the author's visibility; deferred.
- **CMWF-4** (org-blind `chat_message` / `canvas_document` validators) stays open: D1
  gates `chat_message` on the conversation, which is tenant-partitioned, not org-.
- **OQ-3** Thread subscription controls (mute a thread, follow without commenting) —
  Linear's subscriber model. Deferred; D4's participant rule covers the default.

## Implementation record

| Phase | Commit (branch `feat/fl2-41-comments`) | Witness |
|---|---|---|
| P1 S1/S2/S3 + `CM2WF-6` | `fix(comments): threads follow their target's visibility…` | `test/comments-round2-security.test.ts` — 3/3 RED on `64182ad12`, green after; each fix sabotaged in turn and its own case went red |
| P2 D4–D7, D10 | same commit | `test/comments-adr0881.test.ts` (D4, D5, D6/D7, D10) |
| P3 D8, D9, H1 | same commit | D8 + D9 cases; `comments-node-replay.test.ts` flipped (resolve classified on both legs); floor + served set regenerated |
| P4 frontend | `feat(comments): mentions picker, edit-own…` | `commentsPanelAdr0881.test.tsx` |
| grade fixes | `fix(comments): grade-ux + grade-code round-2 fixes` | CM2UX-1/2/3/4/5/8/11, CM2CD-1 (partial)/4/5/6/7/8 |

Filed, not fixed (reasons in `CODEBASE-ASSESSMENT.md` / `UX-ASSESSMENT.md`): `CM2CD-1` residue
(per-recipient target reads; no ORG-level point membership read exists), `CM2CD-2`
(recipient identity spellings — fails closed, OQ-1), `CM2CD-3` (no CAS on the comment row,
carried `CMNT-10`), `CM2UX-6/7/9/10`.
