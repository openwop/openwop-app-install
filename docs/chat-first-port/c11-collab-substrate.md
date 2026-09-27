# Collab substrate (comments · sharing · notifications) — chat-first port review

**Unit:** C11. **Scope:** `backend/typescript/src/features/{comments,sharing,notifications}` +
`frontend/react/src/features/{comments,sharing,notifications}`. Sharing graduated off
its toggle to an always-on host seam (ADR 0434); notifications graduated off its toggle to
core infrastructure (ADR 0010 § Correction); only `comments` is still a gated product
feature (`toggleDefault.status: 'off'`).

**Bottom line: this unit is the collaboration *substrate* and already rides the engine.**
There is nothing to "chat-first port" here — none of these capabilities is an
intent-described task faked with a bespoke "talk to AI" surface, no orphaned workflow,
no toothless persona. The one AI capability (content review) already ships as an
ADR 0058 agent-pack + node-pack driven through the ONE chat. The single real defect is a
notification-targeting honesty gap in comments (§Blockers B1): comment notifications
broadcast tenant-wide despite the per-recipient rail existing and being used elsewhere.

---

## Verdict table

| # | Capability | Today | Verdict | Port target / action |
|---|---|---|---|---|
| C1 | Human threaded comments — post / reply / resolve / edit / delete | Reusable `CommentsPanel` embedded in **chat messages** (`chat/MessageComments.tsx:33`), the **document editor** (`document-editor/DocumentToolbarExtras.tsx:91`), and a standalone `CommentsPage` | **PAGE-LEGIT** | Keep. Structural collaboration data anchored to a `(resourceType,resourceId)` — not intent-described. One shared panel, three surfaces. |
| C2 | AI content review → posts review comments | `feature.comments.agents.reviewer` (pack) with action tools `list`+`post`, chat-drivable (ADR 0058) | **RIDES** | Keep. Igniter = the ONE chat (scope to agent) + AgentRegistry dispatch (`index.ts:366`). |
| C3 | Notify on new comment / reply | `emitCommentNotification` → the ONE `getNotificationEmitter()` (`comments/notifications.ts:42`) | **ADAPTER** (honesty gap) | Rides the emitter correctly, but **delivers tenant-wide** instead of to the intended recipient — see **B1**. |
| C4 | Commentable-type resolver registry | `TARGETS` map, one entry per type (`commentsService.ts:66`) | **RIDES** | Keep. The ADR 0013 "one-map-entry" seam; validates target in-org, yields title+owner. |
| C5 | Comment lifecycle — retention / erasure / cascade prune | `registerRetentionPurger` + `registerSubjectEraser` + `onConversationDeleted`/`onCanvasDeleted` prune (`commentsService.ts:304,332`; `feature.ts:26,34`) | **RIDES** | Keep. Tenant-indexed, idempotent, wired to parent-resource deletion. |
| C6 | Mint public share link to a resource | `sharingService.createLink` — the ONE sharing seam, imported by commerce/CRM/canvas (`sharing/feature.ts:12` header) | **RIDES** | Keep. Host seam, org-scoped RBAC, token hashed at rest (ADR 0448). |
| C7 | Manage links — list / revoke / per-frame analytics | `SharingPage` + authed routes (`sharing/routes.ts:31,48,55`) | **PAGE-LEGIT** | Keep. Structural management surface; token shown once at mint. |
| C8 | Public resolve of a shared resource | Unauthenticated `GET …/shared/:token` (`sharing/routes.ts:64`) | **PAGE-LEGIT** | Keep. Read-only projection; unguessable token IS the credential; each resolver re-applies its own feature toggle. |
| C9 | Inbox — read notifications | `/inbox` page, always-on nav, no `featureId` (`notifications/routes.tsx`) | **PAGE-LEGIT** | Keep. Read surface for the "what needs me" portal. |
| C10 | Notification preferences + mute policy | `preferencesRoutes.ts` durable per-(tenant,user) store; `registerNotificationMutePolicy` = the ONE `setNotificationMuteResolver` (`preferencesRoutes.ts:148`) | **PAGE-LEGIT** (rides the single mute owner) | Keep. Settings page; the mute resolver is the single owner the host notifiers consult. |
| C11 | `notify-me` agent deliverable tool | `openwop:notifications.notify-me` over the ONE emitter, self-scope, default-on baseline (`agentTools.ts`; `agentToolAllowlistService.ts:66`) | **RIDES** | Keep. Self-scoped (`recipientUserId = actingUserId`), relative-URL-only, human-turn-gated. |
| C12 | Run-lifecycle emit (failure/interrupt/completion) | Executor emits via `getNotificationEmitter` unconditionally (core, ungated) | **RIDES** | Keep. Core platform behavior, not a product surface. |

**Counts:** R=6 · A=1 · P=0 · T=0 · PL=5.

---

## Blockers (from scouting) — each with the honest alternative

### B1 — Comment notifications broadcast tenant-wide despite a per-recipient rail existing (honesty-loop failure)
`emitCommentNotification` (`comments/notifications.ts:42-57`) computes the intended
`recipient` (resource owner for a top-level comment, parent author for a reply) and then
**puts it only in `metadata.recipientId`** — it passes **no `recipientUserId`**. The code
comment claims this is "carried in `metadata`… for when per-subject targeting lands (open
question)." That targeting **has already landed**: the emitter accepts `recipientUserId`
(`emitter.ts:52`), the inbox SSE filters on it (`routes/notifications.ts:107`), the
mutation guard enforces it (`routes/notifications.ts:262`), Web-Push scopes to it
(`webPush.ts:110`), and both `notify.ts:111` and the `notify-me` tool (`agentTools.ts:79`)
use it. Because comments omits it, a comment notification is a **broadcast** — ADR 0050
delivers it to *every* tenant member (`routes/notifications.ts:94`, "broadcasts reach every
tenant member"). Result: "New comment on X" pings the whole workspace, not the one person
it names.
- **Honest alternative:** pass `recipientUserId: recipient` on the `emit()` call (a
  one-field fix), delete the stale "open question" comment, and drop the redundant
  `metadata.recipientId`. This is a ~2-line change inside the existing owner — no new
  primitive. Recommend filing it as the single fix this review produces.

### B2 (non-blocking) — the comment-reviewer agent uses NODE tools, not `registerFeatureAgentTool` chat-time tools
The reviewer's allowlist is node typeIds (`feature.comments.nodes.list`/`.post`), driven
through `ctx.features.comments` (`comments/surface.ts`), which is tenant-scoped from the
**run scope** and does **not** re-run the routes' `authorizeOrgScope` org-RBAC predicate —
it trusts the run's tenant and stamps `author = agent:<runId>`. This is the sanctioned
ADR 0058 chat-drivability pattern (agent pack + node pack) and is replay-safe (action-node
output recorded), so it is **not** a blocker. But it does **not** satisfy the strict
agency-test "one predicate, route + tool both call it": the node path has no org-scope
check of its own. Acceptable because a comment write is low-stakes and the surface is
tenant-fenced, but note it — if commentable resources ever gain per-org write restrictions,
the node path would bypass them.

---

## Demolition list (with regression pins)

**Nothing to demolish.** No bespoke "talk to AI" panel, no parallel approvals/notification
path, no orphaned workflow, no fake gate exists in this unit. The AI review path is already
chat-driven; comments/sharing/inbox are legitimately page-shaped.

Pins to ADD as guardrails (not demolitions):
- **Pin B1's fix:** a test asserting a comment notification carries `recipientUserId` equal
  to the intended owner/parent-author (and does NOT broadcast) — so the stale-broadcast
  behavior can't return.
- **Pin C2's igniter:** the reviewer agent stays loadable into the AgentRegistry
  (`index.ts:366`) and its allowlist stays `list`+`post` (a write-tool addition would break
  the "posts comments, never edits the resource" invariant its prompt promises).

---

## New-code inventory (small by design)

- **One 2-line fix** in `comments/notifications.ts` (B1: pass `recipientUserId`, remove the
  stale metadata mirror + comment).
- **One regression test** pinning per-recipient comment delivery (B1).
- Optionally, **one test** asserting the reviewer agent's allowlist contains no
  resource-write tool (C2 invariant).

No new tools, nodes, workflows, owners, canvases, or routes. This unit already expresses
its collaboration + notification intelligence through the app's owners.

---

## Phased plan (gated on real gates)

1. **Phase 1 — targeting fix (B1).** Pass `recipientUserId` in `emitCommentNotification`;
   delete the stale open-question comment; add the delivery regression test. Gate:
   `npm run ci` green; the new test fails on the old broadcast code. Close with
   `/code-review` (backend) — no UX surface changes, so `/ux-review` is N/A.
2. **Phase 2 (optional) — invariant pins.** Add the reviewer-allowlist test (C2). Gate:
   `npm run ci` green.

No demolition phase — there is nothing to replace, so nothing to sequence behind a working
replacement.

---

## Deferred honestly

- **B2 (node-path org-RBAC parity):** deferred *visibly*. The reviewer's node tools are
  tenant-fenced but do not re-check org scope; acceptable today because comment writes are
  low-stakes and no commentable resource has per-org write restrictions. Revisit if that
  changes. Not faked, not a blocker.
- **Per-subject notification identity display:** the comments UI renders raw human ids
  (`CommentsPanel.tsx:33` `authorLabel`) because there is no display-name source on this
  surface yet (the ADR's @mentions/identity open question). Honestly deferred — the panel
  shows the opaque id rather than pretending to a resolved name.
- **Cross-tenant comments on a *shared* session** (RFC 0122 share grant): `chat_message`
  comments are intra-tenant in v1 (`commentsService.ts:36`). Stated in the ADR, not faked.
