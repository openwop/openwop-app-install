# ADR 0879 — Channels round 2: who may post, where agents and workflows may post, and what leaves with a person

Status: implemented (2026-10-12, branch `feat/fl2-40-channels` — merged #4748 as `519a2d6d2` — D0–D9 plus the grade-code/grade-ux fixes). Accepted after the pre-code `/architect` pass recorded under Decision.

Extends ADR 0126 (team channels), ADR 0154 (rail integration + agent members), ADR 0192
(identity parity), ADR 0195 (message affordances) and ADR 0202 (agent-native channels).
Channels has no toggle (graduated always-on, ADR 0134); nothing here adds one. Feature
loop round 2, row 40. Host extension only — no wire change (verdict below).

Companion analysis: [`docs/research/channels-competitive-2026-10.md`](../research/channels-competitive-2026-10.md)
(Slack, Microsoft Teams, Discord, Mattermost, cited from vendor docs, plus a code-grounded
gap table).

## Context

Round 1 graded the channel workflows A− and never graded UX or code. Re-measured on
`origin/main` @ `2d0b4bdd4`, the feature has a sound read model (404-masked private rooms,
member-only mention stamping, no raw HTML) and no write model: nothing asks the workspace
ROLE, and two run lanes write into any conversation id they are handed.

### The security findings (each proved RED first)

`backend/typescript/test/adr0879-channels-security.test.ts`, run against `2d0b4bdd4`
before any fix: **8/8 failed, each for its stated reason.**

| # | Finding | Measured |
|---|---|---|
| S1 | A workspace **Viewer** creates channels, posts, reacts and starts paid catch-up runs. | `POST /channels` → 201 for a viewer. `features/channels/**` contains no role check. |
| S2 | The channel **owner rewrites another member's message**; the victim's attribution stays. | `PUT …/chat/sessions/:id/messages/:mid` by the owner → 200 (`chatSessions.ts:845-851`). |
| S3 | `POST …/members` adds **any string** as a member, including another workspace's user. | 200 with `userId:'anyone-at-all'` (`channelService.ts:395`). |
| S4 | **Removing a person from the workspace leaves them in every channel.** | Roster still lists them after `DELETE …/orgs/:ws/members/:id`. No `onMemberAuthorityLost` hook in channels. |
| S5 | A live **stream keeps delivering** after its holder is removed from a private channel. | Access checked once at open (`routes.ts:188`). Frames carry ids only. |
| S6 | **DSAR erasure leaves the subject's posts** — words and author id. | No eraser touches `chat_messages`; `eraseSubjectConversations` rewrites metas only (`conversationStore.ts:588`). |
| S7 | The **agent-runner `conversationId` lane appends into any conversation id** — a private channel the agent is not in, an archived channel, another tenant's session. | `agentRunnerNode.ts:293-300` appends unconditionally. Reachable from any workflow an Editor authors, and from `POST /v1/runs` of `openwop-app.channel.turn`. |
| S8 | **`ctx.chat.sendMessage`** appends into any conversation id, any role, with no actor. | `chatSurface.ts:107`. |

Clean by reading (no change): stored XSS (markdown has no raw HTML; attachment URLs are
scheme-allowlisted, `frontend/react/src/chat/mediaSrc.ts:26`), SSRF (there is no link
unfurl), mentions to non-members (`stampMentions` and `notifyChannelActivity` iterate
participants only), cross-tenant HTTP (every route resolves the meta under `tenantOf(req)`).

**Not fixed here, filed (CH2WF-4):** a private channel's turn and catch-up runs are listed to
every tenant member, because run reads are tenant-scoped (`host/runAccess.ts`). See the
implementation record below for the exact repro and what was measured (the first draft of this
paragraph overstated it as "`configurable.task` is readable"). Same class as `DSHCD-9` (row 28).

### Competitive frame

All four incumbents split "may read" from "may post", offer an announcement/read-only
channel, let a moderator **delete** but never **edit** another person's message (Discord
rules it out explicitly), remove an offboarded person from every channel, and let a bot read
or post only where it is a member. Their DSAR postures diverge: Slack keeps a deleted
person's messages under `@deactivateduser`, Mattermost can delete them.

## Decision

> **Pre-code `/architect` pass (2026-10-12) — 3 CRITICAL, 6 HIGH, 5 MEDIUM, all folded in
> below.** The draft's D4/D6 matched no stored ref (C1), D7 left the no-human bypass open
> and checked "can see" where it needed "may post" (C2, C3), D1 missed six channel write
> doors (H3), and D10 was already on `main` (`5c72bce4c`, M5). The decisions below are the
> corrected text; the finding that drove each change is named inline.

### D0 — One subject matcher for channel refs (C1)

Channel rows are written with `userRef(req.userId ?? principalId)`, so a person's
participant ref and post `author_subject` are `user:user:<hash>`, `user:oidc:<sub>` or
`user:bearer:<p>`, while member rows and erasure keys are the unprefixed subject. Every
removal and erasure in this ADR matches with ONE helper, `channelRefMatches(ref, forms)`:
`ref ∈ forms ∪ { userRef(f) : f ∈ forms }` where `forms = subjectKeyForms(subject).forms`.
Never an alias principal⇄user (principals are not issuer-qualified). The existing
`eraseSubjectConversations` participant match has the same blind spot and is fixed with it.

### D1 — Read and post are different authorities (S1)

Every channel CONTENT write requires `workspace:write` in the active workspace, through
`callerHoldsTenantScope` (`features/featureRoute.ts`, ADR 0775 D1 — credential by
provenance, a person by both spellings; env keys resolve to tenant-owner scopes, so the
API-key route tests keep passing). Gated: create, post, edit, react, catch-up (it starts a
run). Not gated: read, browse, join a public channel, leave, mute, read markers.

The authority is computed from the request ONCE (`channelAuthorityOf(req)` →
`{ canWrite, isAdmin }`) and passed INTO the service, so `assertChannelManage` itself
enforces it — including for the scheduled-agent-chats routes that call it directly (H4).
Managing needs owner-or-admin AND `canWrite`.

The generic `chat/sessions` doors are closed for channels (H3): `PATCH` (rename) routes
through the channel manage gate and `renameChannel` (today ANY caller who can see a public
channel renames its rail title); `DELETE`, `PUT …/conversation-run`, `PUT …/focus` and
`POST …/branch` refuse a channel (archive is the exit; a branch would copy other people's
posts into a conversation the caller owns); edit and react need `canWrite`; voice refuses
to bind a channel as its transcript target.

### D2 — Nobody edits another person's words (S2, M1)

> **Team-lead decision 2026-10-12:** a moderated delete leaves a NAMED tombstone — "Removed by
> <name>" (the roster name of `meta.deletedBy`, else "a moderator") — never a silent vanish. The
> author's own delete stays "Message deleted"; a DSAR-erased post too.

In a channel, content is editable by its **author only**, compared against both
`callerSubject(req)` and `userRef(actingUserOf(req))` (channel rows are stamped the second
way, so a bearer poster could not edit their own post). The owner and D3 admins may
**delete** (tombstone). Groups keep their ADR 0102 rule.

### D3 — A workspace admin is the manager of last resort

`host:members:manage` in the workspace (admin/owner, or the personal-workspace owner) passes
every channel manage check and the message-delete check, for any channel the admin can see.
It never reveals a private channel the admin is not in.

### D4 — Membership follows the workspace (S3, S4, M2, M3, H5)

- `addChannelMember` and create's `memberUserIds` require a workspace-root member row keyed
  by that exact id (`isWorkspaceMember(userId, tenant)`). No principal lookup, so an
  unbound OIDC member is refused rather than aliased (lockout, the safe direction). A
  personal workspace (`isPersonalTenantId`) admits only its owner.
- An `onMemberAuthorityLost('channels.membership', …)` hook (the push precedent) runs on a
  ROOT `removed`: it drops every matching participant (D0) from every channel in the
  tenant, and **relinquishes ownership** of channels the person owned (`ownerUserId` is
  cleared, so a re-invite does not restore private rooms or manage rights; D3 admins manage
  the room afterwards). As in the push precedent, the hook is hygiene and the per-request
  membership check is the guard (D5).

### D5 — The live streams re-check (S5, H2)

Before each message frame AND on each 15 s heartbeat, the stream re-runs the channel access
predicate AND `callerHoldsTenantScope(req, tenant, 'workspace:read')` (current workspace
membership, every spelling). On refusal it writes nothing and closes. The presence stream
gets the same re-check on its heartbeat.

### D6 — Erasure reaches a person's posts (S6, H6)

A new storage verb `redactChatMessagesByAuthor(tenantId, authorRefs, replacementAuthor)`
does ONE tenant-scoped write per adapter: every `chat_messages` row of a session in that
tenant whose `author_subject` is in `authorRefs` gets the ADR 0195 tombstone content,
`meta = {"deletedAt":…, "erased":true}`, `author_subject = ERASED_USER_REF`; the touched
sessions' `updatedAt` is bumped so the search index (watermarked on
`messageCount:updatedAt`) re-indexes. All conversation types, not only channels (a `person`
DM and a branched copy carry the same words). `authorRefs` is D0's set. Registered as
`eraseSubjectChatPosts` in `hostSubjectErasers.ts` + the manifest. Legal hold is already
asserted up front by `eraseSubject`. Stated leftovers: `meta.deletedBy` refs on OTHER rows
the subject moderated, notification excerpts (the notifications eraser's scope), and run
`configurable.task` (CH2WF-4).

### D7 — Agents and workflows post only where a human may (S7, S8, C2, C3, H1, M4)

> **Ratchet (team-lead decision 2026-10-12):** the gate sits at the shared seam, and
> `test/adr0879-chat-append-ratchet.test.ts` pins every call site that persists or publishes a
> chat message, file by file, with the gate that authorizes it. A new writer fails the test until
> its gate is named (sabotage-witnessed with a probe file).

One host predicate, `host/runConversationWrite.ts` `authorizeRunConversationWrite`, called
by the agent-runner append and `ctx.chat.sendMessage` on the RESOLVED conversation id
(whatever source — node config wins over `configurable`, so the check is on the value that
is about to be written):

1. The conversation must exist **in the run's tenant**. `sendMessage` may still create a
   new session in its own tenant when neither a session nor a meta exists by that id.
2. `human = actingUserId ?? orgScopeSubject`. For channel turns `orgScopeSubject` is the
   POSTER, read here as a poster-authority subject (it still grants nothing else).
3. **Channel target:** refused when archived; refused with no human (M4: an approval-
   dispatched heartbeat reply into a channel stays in the run/approval card); the human must
   hold channel POST authority — `workspace:write` in the run's tenant (req-less
   `assertTenantScope`, `personalTenant` honoured), channel access, and D8 posting policy
   (an agent member's reply to a manager's post is allowed). An agent append also requires
   the agent to be an agent member (`agentStorageId` on both sides).
4. **Other conversations:** with a human, `isVisibleToAsync(meta, tenant, human)` (H1 —
   project chats are subject-governed); with no human, an OWNED conversation accepts an
   agent append only when that agent is its participant (`agentStorageId`), and never a
   `sendMessage`; an unowned legacy session is unchanged.
5. **The no-human doors are given a human (C2):** a scheduled chat's job carries
   `orgScopeSubject = <creator>` (reserved job metadata the scheduler route strips from
   clients, forwarded by the daemon as the run's `orgScopeSubject`), so a user-chosen
   `workflowId` is checked against its creator; the org-scoped scheduled-chat route refuses
   a channel `conversationId` (channel posts go through the owner-gated channel lane).

> **CORRECTED 2026-10-12 (grade-code `CH2CD-1/2/3`) — three legs of this decision were
> wrong as first shipped, each in the direction of silently dropping a legitimate reply or
> admitting an authorless one.** (1) The run lane had no personal tenant, so a channel reply
> in a personal or anon workspace (no member rows) failed the role leg the HTTP lane passes
> through `isOwnPersonalWorkspace`: `startWorkflowRun` now takes `personalTenant` (reserved
> run-metadata key), passed by the channel post route and both scheduled-chat create routes.
> (2) Rule 4's "no human" case dropped approved heartbeat replies and every pre-0879
> scheduled chat: the approval dispatch now stamps the APPROVER as `orgScopeSubject` (an ADR
> 0832 D3 role), and a boot backfill stamps each legacy schedule's creator inside the job CAS.
> (3) Rule 3 let a `sendMessage` with a person behind it post into a channel; that row has no
> author and a pack-chosen role, so it escaped the author-only edit rule, erasure, mentions and
> notifications. A channel now takes only an AGENT MEMBER's reply (`channel_needs_agent`).

**A behaviour REMOVAL, and its migration (team-lead question, 2026-10-12).** Rule 5's last
clause removes something that worked: an ORG schedule could target a channel. Why: the org lane
checks only that its creator can SEE the conversation, and every member sees a public channel, so
it let anyone schedule an agent into any public room past the channel's owner gate and its
announcement policy (architect C3). The channel's own schedule lane (`POST …/channels/:id/
scheduled-chats`, owner-or-admin, agent must be a member) is where channel posts are scheduled.
**Existing schedules are not deleted or silently dropped:** (a) the boot backfill gives every
pre-0879 schedule its creator as the run's person, so one whose creator may still post there and
whose agent is a channel member KEEPS POSTING; (b) one that may not now FAILS VISIBLY — the
agent-runner returns the typed failure `conversation_write_refused` (never success-with-nothing),
the schedule list carries it as `lastError`, and both the Scheduled chats page and the channel's
schedule panel show "Last run could not post here…" to the owner (witness:
`scheduled-chat-firing.test.ts` "surfaces the last run's failure…"). The owner re-creates it from
the channel, or deletes it.

> **CORRECTED 2026-10-12 (team-lead decision): a refusal is a TYPED FAILURE
> (`conversation_write_refused`), not "answered but did not post".** The draft's silent-success
> shape is exactly the success-with-nothing this repo's non-negotiables forbid, and it is what would
> have made a migrated schedule disappear without a word.

The agent-runner logs `run_conversation_write_refused` and fails the node with that code. `sendMessage`
throws a typed `forbidden` (the node fails honestly).

### D8 — Announcement channels

`channel.postingPolicy: 'everyone' | 'managers'` (absent ⇒ `everyone`). Under `managers`
only the owner and D3 admins post; agent members still reply to a manager's post. Owner-set
via `PATCH /channels/:id { postingPolicy }`. The composer shows a read-only notice.

### D9 — The channel-turn chain leaves the gallery

`core.openwop.workflows.channel-turn` gains `"internal": true` (RFC 0135, presentational),
patch-bumped to 1.0.2. D7 is the authority; this only stops advertising the door.

### D10 — WITHDRAWN (M5): pagination ties are already fixed on `main`

The draft proposed a per-conversation monotonic clock for the CS-CH-3 flake. `5c72bce4c`
(2026-10-06) already makes `created_at` per-session monotonic inside both storage adapters
(`storage/chatMessageOrder.ts`, Postgres under an advisory lock), covering every append
path and both the paged and legacy reads. A per-instance clock in `channelService` would be
weaker and redundant. Measured on this branch: the test passed 6/6 with six concurrent
copies. The flake record predates that fix.

## Alternatives weighed

- **Gate S7 by forbidding `conversationId` on user-authored workflows.** Rejected: scheduled
  chats and KickBot legitimately bind it; the question is authority over the target, not
  the parameter.
- **Viewer may post (Slack guests can).** Rejected: this app's Viewer role is read-only by
  definition, and the comments feature already requires `workspace:write` to post. A guest
  tier is a different feature.
- **DSAR: keep posts, relabel the author (Slack).** Rejected for this app: the words are the
  subject's personal data, and every other eraser here removes content.
- **Close streams via a membership-change bus event.** Rejected for now: a per-frame
  re-check is simpler, cross-instance by construction, and needs no new event.

## Phased plan

| Phase | Scope |
|---|---|
| P1 | D0, D1, D2, D3 (service authority + `chatSessions.ts` channel doors + voice bind) |
| P2 | D4, D5 |
| P3 | D6 (storage verb ×2 adapters + eraser + manifest) |
| P4 | D7 (host predicate + both lanes + scheduled-chat human), D9 |
| P5 | D8 (service + route + composer notice, 4 locales) |

## RFC verdict

Host extension only. Every route is `/v1/host/openwop-app/*`; the predicate and eraser are
in-process; the chain flag is RFC 0135 (Accepted) and presentational. RFC 0110 presence
frames are untouched. No capability advertisement changes.

## Open questions

- OQ-1: run-read visibility for conversation-bound runs (CH2WF-4) — platform-wide, filed.
- OQ-2: pins and an `@channel` confirm on rooms of ≥6 members — table stakes, filed as
  follow-ups (no safety gap).

## Implementation record

| Phase | Decision | Commit | Witness |
|---|---|---|---|
| P1 | D0 matcher, D1 role gate + generic doors, D2 author-only edit, D3 admin | #4748 (`519a2d6d2`) | `adr0879-channels-security.test.ts` S1, S2, D3, H3 |
| P2 | D4 member-only adds + offboarding hook, D5 stream re-check | #4748 (`519a2d6d2`) | S3, S4, S5, "a departing owner…", "a PUBLIC channel stream closes…" |
| P3 | D6 `redactChatMessagesByAuthor` + `eraseSubjectChatPosts` | #4748 (`519a2d6d2`) | S6 (sqlite lane; Postgres SQL unexercised — `CH2CD-6`) |
| P4 | D7 run-lane gate, D9 internal chain | #4748 (`519a2d6d2`) | S7, S8, the four "every leg" cases (role leg sabotage-witnessed RED) |
| P5 | D8 announcement channels + UI | #4748 (`519a2d6d2`) | D8 case; FE `channelWriteState` tests |

**Filed, not fixed — `CH2WF-4` (named, tracked, residue pinned by
`test/adr0879-ch2wf4-run-read-residue.test.ts`).** Run reads are tenant-scoped
(`host/runAccess.ts` `loadByScopeAndTenant`), so a private channel's turns are visible to every
workspace member. **Exact repro:** (1) the owner creates PRIVATE channel `#x` with an agent member
and posts `@agent <secret>`; (2) a workspace Viewer who is not in `#x` calls `GET /runs?workflowId=
openwop-app.channel.turn` with `OpenWOP-Version: 2` → the turn is listed (existence, timing,
status); (3) `GET /runs/<id>`, `…/events/poll`, `…/debug-bundle` → 200 to that Viewer. **Measured:**
on a TERMINAL run the post text is not in any of the three. **Not measured** (no live provider in
the test env): a SUCCESSFUL turn's node output (the agent's reply, which is the private channel's
content) and a RUNNING turn's live `variables` (which hold `task`); the catch-up run's transcript
the same way. The draft of this ADR said `configurable` was readable outright — that overstated
it, and the pin records what was measured. Same class as `DSHCD-9` (row 28); needs a platform
run-read decision for conversation-bound runs, not a channels patch.
Also filed: `CH2CD-4` single-spelling run lane (lockout direction); `CH2CD-6` Postgres
lane witness; `CH2CD-7` relinquish without CAS (hygiene; the guard is per-request); `CH2CD-8`
per-frame cost; `CH2UX-10/11/12` polish; pins and an `@channel` confirm (OQ-2).
