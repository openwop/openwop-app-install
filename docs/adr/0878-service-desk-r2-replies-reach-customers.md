# ADR 0878 — Service desk round 2: replies that reach the customer, and the security floor

Status: implemented (2026-10-12) — #4736 (`f62fa318f`, D1–D10) and #4739 (`59b2a4c62`, the OQ-1 Option B support-reply lane). Accepted after the pre-code `/architect` pass.

Extends ADR 0422 (service desk). Toggle ids unchanged (`service-desk`,
`service-desk.widget`). Feature loop round 2, row 39. Host extension only — no wire
change (verdict below).

## Context

Row 39 graded the service desk as a unit for the first time. It was graded "clean across
every Blocker-producing lane" on 2026-08-13 (`UX_UPGRADE-service-desk.md` round 2). Re-measured
on `origin/main` @ `6b30fb3a9`, that verdict does not hold.

### The product finding: a reply never reaches anyone (SD2WF-1)

ADR 0422 §4 promised "on approval the send rides the channel's existing outbound", and
P3 recorded that delivery "composes via the operator's event→workflow binding". Measured:

- The ticket stores **no channel address**. The WhatsApp `connectionId` and sender number
  are hashed into `ticketId` (`tickets.ts:109`) and survive only as an `author` string
  when no CRM contact resolved (`intake.ts:98`). A contact-resolved ticket has no number
  at all. The `ticket-reply-approved` payload is `{ ticketId, actionId }`
  (`actionExecution.ts:308`). So no binding can be written that knows where to send.
- No chain exists for it. `git grep 'feature\.service-desk\.nodes\.'` outside the pack
  hits only the steward manifest.
- The member route's "Reply to customer" (`routes.ts:96-110`) appends an `outbound`
  message and emits only `message-appended`. A human's reply never reaches the event.
- The widget lane (`widgetRoutes.ts`) has no frontend anywhere in the tree
  (`git grep public-service-desk` → the route file and one reclass test).

So every outbound reply on every channel is stored and shown in the thread as sent. The
agent believes it answered the customer.

### The security findings (each proved RED first)

`test/adr0878-service-desk-security.test.ts`, run against `6b30fb3a9` before any fix: 8/8
failed, each for the stated reason (the S6 eligibility half was isolated and also failed:
`promise resolved "undefined" instead of rejecting`).

| Id | Finding | Evidence |
|---|---|---|
| SD2-S1 | `ctx.features['service-desk'].getTicket` takes no `orgId`, so the ADR 0832 org floor (`featureSurfaces.ts:182`) never fires. A run acting for an org-A member reads an org-B ticket and thread by id. | `surface.ts:20` |
| SD2-S2 | The intake config is TENANT-wide (it routes every WhatsApp and widget ticket) but `PUT /orgs/:orgId/intake-config` needs `host:members:manage` in ONE org. An admin of org B re-points the tenant's inbound support into org B, and every PUT also re-mints the published widget key (`routes.ts:56-62`), breaking every embed. The PUT also silently drops `slaHoursByPriority` (no route ever set it). | RED: 200, expected 403 |
| SD2-S3 | The widget visitor HMAC key is `process.env.OPENWOP_SESSION_SECRET ?? ''` (`widgetRoutes.ts:57`). Unset, anyone mints a valid token. The token is also not tenant-bound. The house resolver `readSessionSecret()` fails closed in production. | RED |
| SD2-S4 | DSAR leaves the requester's words in `subject`: WhatsApp and widget subjects are the first 80 chars of the first message (`intake.ts:90`, `widgetRoutes.ts:136`). A form requester with no CRM contact is unreachable: the body holds `email: …` verbatim and the author is the bare `visitor`. | RED (two cases) |
| SD2-S5 | Assignment accepts any string (`routes.ts:135`). | RED: 200, expected 422 |
| SD2-S6 | An agent-drafted reply is an `assistant-action` approval. `APPROVAL_AUDIENCE['assistant-action'] = null` (tenant-wide) and the eligibility check is the tenant-UNION `workspace:write` (`writeAuthority.ts:58`). So an editor of org A reads org B's draft and subject in `/approvals`, `/reviews`, `GET /assistant/pending-actions` and the create-time notification, and can approve or edit it. Worse, PATCH lets the payload change, so an org-A draft can be re-pointed at an org-B `ticketId` and approved; the executor reads `payload.ticketId` with no org check. | RED (view + decide) |
| SD2-S7 | WhatsApp intake reads no toggle (`intake.ts:74`). With Service desk OFF it keeps filing tickets, arming SLA clocks and sending breach notifications. | RED |

Probed and clean: stored XSS (every body is React text; the widget returns JSON; there
are no attachments); inbound signature (`registerInboundObserver` fires only after the
ADR 0394 verification, `inboundWebhooks.ts:323`); ticket-id guessing on the public lane
(the thread is derived from the token, never from a caller id); open relay (there is no
email egress today, and D3 delivers only to the address captured at intake); the chat tools
(org-scoped since D8); the member routes (`workspace:write`, org-checked); paywall on the
member routes, tools and surface (`resolveOne`), with the visitor lane on `resolveToggle`
by design (ADR 0820 §8.2).

### Competitive baseline

`UX_UPGRADE-service-desk.md` (Zendesk, Front, Intercom, Help Scout). The table stakes this
desk misses, in order of user harm: (1) a reply is delivered, and the thread says whether
it was; (2) the queue has views — mine, unassigned, overdue; (3) assignment to a teammate
with a notification; (4) priority is editable; (5) an SLA breach escalates to someone.
Email intake (every competitor's first channel) is NOT in this ADR; see D10.

## Decision

> **Revised after the pre-code `/architect` pass (2026-10-12).** The first draft of this
> section had 3 Blockers and 8 Highs in it; each is folded in below and listed in
> § "Pre-code review". The three Blockers: D6 missed the assistant route's own decide
> lane (it calls `decideActionViaApproval` and never reaches eligibility); D3 would
> have DELIVERED whatever message already held a caller-supplied `messageId`, which
> includes an internal note; and SD2-S3 had no decision at all.

### D1 — The surface asks what the door asks (SD2-S1)

`getTicket` resolves the ticket, then applies the run's org floor to `ticket.orgId` with
`assertRunScopeOrg(scope, orgId, 'workspace:read')` when the run has a person (the actor,
else the causing member). This is the predicate `featureSurfaces.orgFloor` uses. A
`not_found` or `forbidden_scope` refusal returns `{ ticket: null }`, the same as an unknown
id, so there is no existence oracle. Any other error is rethrown, as `runOrgScopeFilter`
does. A system run with no person stays tenant-trusted, as on every surface. Neither the
surface nor the chat tool returns `requester` (D3); they expose only `replyChannel.kind`.

### D2 — The intake config is tenant-scoped, and so is its authority (SD2-S2)

"May route the whole tenant's inbound support" is a WORKSPACE-level authority. It
resolves the way the host already resolves workspace authority:

- **A personal workspace** (`user:`/`anon:`): the implicit owner. `assertOrgScope` gets
  `personalTenant`; today the route passes none.
- **A tenant with a workspace-root org** (`orgId === tenantId`, ADR 0815 D1b; every `ws:`
  shared workspace): `host:members:manage` on the ROOT membership. A sub-org admin is not
  a workspace admin.
- **A multi-principal tenant without a root org** (SSO host-global, legacy `org:`):
  `host:members:manage` in EVERY org of the tenant. This can lock a tenant out when two
  admins each created an org; the exit is an operator or superadmin. Recorded as a
  residual, not hidden.

The first PUT mints the widget key when none exists. Later PUTs never re-mint it:
`POST …/intake-config/rotate-key` is the explicit rotation, under the same authority. The
PUT validates and persists `slaHoursByPriority` (integers 0–720 per priority; absent keeps
the stored table). GET (`workspace:read`) returns `{ configured, here }`. The config itself
(including the public key and the SLA table) is returned only when `here`, i.e. intake files
into the caller's org. Another org's page can then say "intake is configured for a
different organization" without learning which one.

Alternative rejected: tenant-union `host:members:manage` (`requireTenantScope`). An admin
of ANY org holds it, which is exactly the hole.

### D3 — Replies are delivered, and the thread says what happened (SD2WF-1)

- **Where to send is captured at intake and never caller-supplied.** This closes open relay
  by construction.
  - `replyChannel` is routing only and carries no PII: `{ kind: 'whatsapp', connectionId }`,
    `{ kind: 'widget' }`, or absent (form, manual).
  - `requester?: { phone?, email? }` is PII. The phone is `normalizeWaNumber(from)`, never
    Twilio's raw `whatsapp:+E164`; the email is lower-cased. It is erased under D4 and
    projected out of every surface except the member HTTP read.
- **ONE function delivers.** `deliverOutbound({ tenantId, ticketId, messageId, actor })`
  runs ONLY for a message that this call freshly appended with `direction:'outbound'`.
  `appendMessage` now returns `{ ticket, appended }`.
  - The member route mints the id: `out:<uuid>`, or `client:<subject>:<key>` when the client
    sends an idempotency key. A caller-supplied id can no longer name another message.
  - An approved draft is `reply:<actionId>`.
- **Delivery state lives in its OWN collection**, `service-desk:delivery`, keyed
  `tenant:ticket:messageId`. It is not stored in the 500-message ticket blob, whose
  whole-row CAS gives up after 6 attempts on a busy thread. State machine, every transition
  a CAS on the row:
  - `pending`, then exactly one of:
    - `sent` (+ `providerRef`)
    - `failed` (+ a typed `code` and the host-written message; never the provider's echo)
    - `visible` (widget, while `service-desk.widget` is on)
    - `not_sent` (no reply channel, or the widget toggle is off)
  - A `pending` row older than 10 minutes reads as `unknown`.
  - `POST …/tickets/:id/messages/:messageId/retry` (`workspace:write`) re-claims only
    `failed` or `unknown`, and only for an `outbound` message.
- **WhatsApp sends through the governed path, with a per-message idempotency key.**
  - The path is `sendWhatsApp` (toggle, number binding, consent, the 24h window, the
    dispatch ledger).
  - `WaSendArgs` gains an optional `idempotencyKey`, here the `messageId`. It replaces the
    CONTENT term in `idemKeyFor`, so two identical "Thanks, done!" replies on one day are two
    sends, while a retry of the same message is still one. Every other caller's key is unchanged.
  - The send is authorized as the replier, or the approver for a draft: `actingUserId`, plus
    `orgId = ticket.orgId` for the Connection credential, plus a synthetic
    `runId: servicedesk:<ticketId>`.
- **Delivery requires the feature to be on** (`resolveOne`, as the replier). An approval
  decided after the desk was turned off records `not_sent`, code `feature_disabled`.
- **The `ticket-reply-approved` event stays** for automation. Its docblock stops claiming to
  be the delivery path. No operator can have bound a WhatsApp send to it: the payload never
  carried an address. So the new in-service delivery cannot double-send through an existing
  binding.

### D4 — DSAR reaches the requester however they arrived (SD2-S4)

- **Matching.** The requester is erased when the subject's key forms contain
  `requester.phone` or `requester.email`. Both sides are normalized: E.164 for phones, lower
  case for emails. A ticket's `contactId` still matches as before. The legacy first-contact
  match also normalizes, since `wa:whatsapp:+1…` authors never matched a phone-keyed DSAR
  for Twilio.
- **What erasing the requester redacts.**
  - The inbound bodies.
  - `requester`.
  - The SUBJECT, when the customer's words wrote it: `WhatsApp: [erased]` /
    `Widget: [erased]`. A form title or a member-typed subject is kept.
  - Every `servicedesk.reply` pending action on that ticket: its `draft` and `reason` (which
    quotes the subject), plus its approval's `proposal`.
- **Staff leg.** `assigneeMemberId` joins `createdBy` and authored messages when the erased
  subject is staff.
- **Concurrency.** The eraser is a CAS mutate loop. A delivery or append that lands between
  its read and its write is never reverted.

### D5 — An assignee is someone who can work the ticket (SD2-S5)

`assign` takes `assigneeMemberId` as an org MEMBER ROW's `subject`, the spelling
notifications address and the member store keys. It requires
`orgScopeGranted(tenant, subject, ticket.orgId, 'workspace:write')`; otherwise a typed 422
`invalid_assignee`. `{ assignToSelf: true }` picks the caller's member row in that org by
matching any of `callerSubjectSpellings(req)`. The "Mine" view matches the same set. The
assignee is notified (`recipientUserId` = the member subject) unless they assigned
themselves.

### D6 — An org's support reply is that org's business (SD2-S6)

**The org comes from the ticket, never the payload.** For `servicedesk.reply`, the
authoritative org is `getTicket(payload.ticketId).orgId`, read at decide time and at
execution. This covers rows from before this change, which carry no `orgId`. The
tool-written `payload.orgId` is ignored.

**The approval row carries the org for audience.** `enqueueActionWithApproval` stamps
`orgId` (the ticket's) on the action and its approval. `APPROVAL_AUDIENCE['assistant-action']`
becomes the variant `{ orgScopeWhenOrg: 'workspace:write' }`, which both functions handle
BEFORE the `null` branch:
- `mayViewApproval`: no `orgId` means tenant-wide, exactly as today.
- `approvalRecipients`: no `orgId` returns `addressed:false`, exactly today's `null` answer,
  so existing assistant actions keep today's addressing. With an `orgId`, both are org-scoped.
- `approval-audience-owner.test.ts` is updated in the same PR.

**The decide check lives in `decideActionViaApproval`**, the one function every lane
reaches: `/approvals/:id/claim`, `/reviews`, and the assistant route, which never reached
eligibility. It requires the decider to hold `workspace:write` in the ticket's org. A reject
is refused too (`forbidden_scope`), because rejecting another org's reply is also a decision
about it. The operator and personal-owner exits stay. The decider is checked under every
spelling the request carries.

**Every remaining lane is closed.**
- Viewer-facing `listPendingActions` callers (the route, and the surface when the run has a
  person) drop `servicedesk.reply` actions the viewer cannot write in the ticket's org.
- The PATCH edit refuses them (uniform 404) and refuses any `payload` change on this kind.
- The executor refuses unless the ticket still exists, and appends only to
  `payload.ticketId` in the org the decide check verified.
- The create-time notification for an org-bearing action is addressed to `approvalRecipients`
  (the org's `workspace:write` holders). If that list is empty, the notification goes to
  nobody and is logged; it never falls back to a broadcast.

Residual (Low, filed): the briefing and health COUNTS still include other orgs' pending
actions. They are counts only, with no content.

### D7 — The agent workspace (UX table stakes)

`/support` gains:
- **Views:** All open · Mine · Unassigned · Overdue.
- **Assignment:** an assignee column and picker (org members holding write) plus "Assign to me".
- **Priority:** editable. `POST …/priority` re-derives the SLA due time from the stored
  table and re-arms the timer.
- **Ticket detail:** an overdue chip and the requester's channel identity.
- **Delivery:** a badge on every outbound message, with Retry on `failed`/`unknown`.
- **An honest composer.** On a ticket with no reply channel, the mode reads "Record a reply
  (not sent — no reply channel)".
- **Intake notice:** says when intake is configured for a different organization, instead
  of offering to take it.

### D8 — Escalation is addressed, and a chain can drive it (SD2WF-4)

- **The breach notification.** The sweep's own notification goes to the assignee, else the
  ticket org's `workspace:write` holders, and names the ticket subject. It is never a
  tenant broadcast.
- **The chain pack.** `examples/workflow-chain-packs/service-desk`
  (`core.openwop.workflows.service-desk`) ships `service-desk.sla-escalation`:
  - `core.trigger.event` (the breach event, templated per ADR 0683) →
  - `feature.service-desk.nodes.get-ticket` (reads `ticketId` from `event`, the commerce
    ADR 0875 D11 pattern; fails TYPED `ticket_unavailable` on null, never summarizing
    nothing) →
  - `core.ai.chatCompletion` (a two-line escalation summary grounded in the thread) →
  - the new `feature.service-desk.nodes.notify-team` (surface `notifyTicketTeam`). It
    addresses the assignee, else the org's write holders, and requires `workspace:read` in
    the ticket's org under the floor (`methodScopes`).
- **Why not the generic `notify` node.** It can address only `tenant`, `self` or `role:`. An
  event run has no actor, so it would fall back to a tenant broadcast: the leak D6 exists
  to close.

### D9 — Toggle discipline on the background lanes (SD2-S7)

- **WhatsApp intake** reads `resolveToggle('service-desk', { tenantId })` plus
  `ownerPublicRuntimeLapsed`, exactly as the widget does. The sender is not a member, so this
  is the ADR 0819 visitor opt-out. `intake.ts`'s row in `feature-toggle-access-ratchet` goes
  from 1 to 2, with the reason.
- **The SLA sweep** is an operator lane and uses `resolveOne` (tenant), memoized per tenant
  per pass. A timer that comes due while the feature is off is SETTLED SILENTLY (marked
  fired, not alerted, counted in the log). It is neither re-listed every minute nor burst
  on re-enable.

### D10 — Out of scope, filed

- **`SD2-F1`, email intake and delivery** (ADR 0422 OQ-3). It needs an inbound-MX decision.
- **`SD2-F2`, the widget's embeddable frontend.** The API exists.
- **`SD2-F3..F6`, competitive gaps:** macros/canned replies, CSAT (OQ-4), ticket merge, tags.

## Alternatives weighed

- **Deliver via a chain bound to `ticket-reply-approved`** (ADR 0422's own plan).
  Rejected for the default path. It needs per-tenant operator setup to work at all, which
  is how it shipped broken for three months. It also doubles the member-reply path, and a
  run cannot record the per-message delivery state the agent needs to see. The event stays
  for automation.
- **A new approval KIND `servicedesk-reply`** instead of `orgScopeWhenOrg` on
  `assistant-action`. Cleaner audience, but it forks the assistant action machinery (the
  decision core, approve-what-you-see, the card projector, the edit lane), the duplication
  ADR 0862 just collapsed. Rejected.
- **Store the phone only on the CRM contact.** Not every sender resolves a contact, and a
  merge or contact edit would silently re-route replies. The ticket owns where its
  conversation lives.

## Pre-code review (`/architect`, adversarial, 2026-10-12)

3 Blocker · 8 High · 9 Medium · 6 Low against the first draft. All Blockers and Highs are
folded into the Decision above.

**Blockers**
1. D6 missed a decide lane: the assistant route never reaches eligibility. Moved into
   `decideActionViaApproval`.
2. D3 would have delivered whatever message already held a caller-supplied id, including an
   internal note. Now ids are server-minted and only freshly appended outbound messages are
   delivered.
3. SD2-S3 had no decision. Added as D3a below.

**Highs**
- D1's prose and its probe disagreed. Resolved to `{ ticket: null }`.
- A `pending` delivery could stay stuck and was capped by the ticket CAS. Delivery now has its
  own collection and an `unknown` exit.
- The WhatsApp content dedupe would swallow an identical reply. Fixed with a per-message
  `idempotencyKey`.
- The "every org" rule locked out shared workspaces. Replaced with the root-membership rule.
- Twilio `From` is `whatsapp:+E164`, so phone matching never worked. Both sides are now
  normalized.
- The customer's words survived in action and approval text. Those are now erased.
- `requester` reached model context and run history. It is now projected out.
- The chain's generic `notify` could only broadcast. Replaced with an addressed node.

**Mediums**
- Legacy rows carry no `orgId`. The org is now derived from the ticket.
- The eraser used a blind `put`. It is now a CAS loop.
- The ratchet row and the lapse check were added for intake.
- The sweep re-listing and burst on re-enable are handled by silent settling.
- Assignee and decider identity spellings are matched across all spellings.
- The send's credential context is specified.
- D1 rethrows non-authz errors.
- Delivery is toggle-gated.
- Reviewer #14 (a contact-keyed DSAR never fans out to email or phone) is partly closed. A
  ticket now matches on every requester form it holds. A DSAR keyed ONLY by a `contactId`
  still cannot reach a ticket filed before that contact existed. This is filed as `SD2-F7`:
  it needs a reverse map in `resolveCrmSubjectKeys`.

**Lows**
- Citations corrected.
- The widget reads `not_sent` while its sub-toggle is off.
- The first PUT mints a key, and GET returns the config only to its own org.
- Briefing and health counts are filed as `SD2-F8`.
- The `assigned` event's assignee id is kept: it is an ids-only staff ref, the documented
  event contract.
- The audience ratchet edit is called out in D6.

### D3a — The widget visitor token (SD2-S3)

- **Key.** The HMAC key is a labelled sub-key of the house session secret:
  `HMAC(readSessionSecret(), 'service-desk-visitor/v2')`. It fails closed in production, uses
  the stable dev fallback elsewhere, and is key-separated from session cookies.
- **Binding.** The token signs `sd-visitor|<tenantId>|<visitorId>`, so it is bound to one
  tenant.
- **Refusal.** When the secret cannot be resolved (`readSessionSecret` throws in production),
  the public lane answers a uniform 404, never a 500.
- **Accepted cost.** Every pre-existing token is invalidated. That is safe today: the lane has
  no frontend. `GET …/thread` also accepts the token in `x-visitor-token`, so a client can
  keep it out of URLs and access logs.

## RFC verdict

Host extension only. Every route is under `/v1/host/openwop-app/*`. Event names are
host-owned (`openwop-app.*`, `host.*`). The chain pack uses existing node ids and RFC 0013
shapes. No capability is advertised.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1, D2, D3a, D4, D5, D9 (service + routes) | `adr0878-service-desk-security.test.ts` S1–S5, S7 |
| P2 | D6 (approval audience, eligibility, list/edit/execute) | S6 + an execution-refusal case |
| P3 | D3 delivery (`replyChannel`, `requester`, `deliverOutbound`, retry) | `adr0878-service-desk-delivery.test.ts` |
| P4 | D7 frontend | vitest + `npm run build` |
| P5 | D8 chain pack + `get-ticket` `event` input | real-loader witness |

## Open questions

- OQ-1 — **RESOLVED 2026-10-12: Option B, decided by the user** (via the orchestrator). See
  § "OQ-1 resolution" below. The original question is kept: WhatsApp consent for support replies.
  `sendWhatsApp` requires a `marketing-whatsapp` opt-in for every send, so most real
  replies will fail `consent_denied`. Option B is a narrow in-window `service-reply` lane
  (session only, the ticket's own sender, refused on explicit opt-out). Until decided, D3
  ships Option A: strict, and the failure is honest.
- OQ-2: should a `failed` delivery re-open the ticket or alert the assignee? v1 shows the
  badge only.

## Implementation record (2026-10-12, branch `feat/fl2-39-service-desk`)

| Phase | Commit | Witness |
|---|---|---|
| P1–P3 security floor + delivery | `40811b835` | `adr0878-service-desk-security.test.ts` (SD2-S1..S7, all RED on `6b30fb3a9` first) |
| P3/P5 chain + delivery witnesses + ratchet rows | `0fc598ccc` | `adr0878-service-desk-delivery.test.ts`, `adr0878-service-desk-chain.test.ts` (real loader + executor) |
| P4 agent workspace (D7) | `58041c81f` | `frontend/react/src/features/service-desk/__tests__/ticketWorkspace.test.tsx` |
| Grade follow-ups | `077daf32f` | the `grade-code follow-ups` + `grade-ux follow-ups` blocks in the files above |

**Sabotage witnesses (run on `077daf32f`, restored with `git checkout`):** disabling the
decide-core org check reds SD2-S6 (the assistant route's reject lane); removing the
surface's org floor reds SD2-S1; dropping the executor's delivery→status mapping reds the
approved-draft delivery case.

### Correction (post-implementation grades)

`/grade-code` found three Highs in this ADR's first implementation, all mine:

- **SD2CD-1.** The executor stamped `sent` whatever delivery did. That was the exact
  dishonesty D3 exists to remove, moved one layer down.
- **SD2CD-2.** Member authors were written `user:${userId}` where `userId` is already
  `user:<hash>`, so a staff DSAR never matched them. This predates the ADR; D4's staff leg
  claimed a property the data could not have.
- **SD2CD-3.** Approvals created before rows carried `orgId` stayed tenant-wide.

All three are fixed in `077daf32f`. SD2CD-3 is fixed by a host-side org resolver
(`registerApprovalOrgResolver`) rather than a migration. That holds even for a row written
by a peer on old code.

### Filed follow-ups

| Id | What | Why not here |
|---|---|---|
| `SD2-F1` | Email intake + delivery (ADR 0422 OQ-3) | Needs an inbound-MX decision |
| `SD2-F2` | The widget's embeddable frontend | The API exists; the embed is the chat-widget feature's concern |
| `SD2-F3..F6` | Macros/canned replies, CSAT (OQ-4), merge, tags | Competitive gaps; each is its own decision |
| `SD2-F7` | A DSAR keyed ONLY by a `contactId` cannot reach a ticket filed before that contact existed | Needs a reverse map in `resolveCrmSubjectKeys` |
| `SD2-F8` | Briefing and health COUNTS include other orgs' pending actions | Counts only, no content |
| `SD2-F9` (SD2CD-7 residue) | The approval notification quotes the drafted reply; notification bodies are not text-erased | The notification eraser matches people refs. A text eraser is cross-cutting |
| `SD2-F10` (SD2CD-8) | The escalation chain's run history holds the thread and an AI summary | Run-history erasure is cross-cutting (the engine retention lane) |
| `SD2-F11` (SD2CD-16/17/19) | Demo-mode assignee check, the WhatsApp dedupe ledger's one-day window, the N+1 member scan | Low |
| `SD2-F12` (SD2UX-15/16/17) | Narrow-screen table stacking, tinted internal notes, a humane kind label on the approval card | Low |
| OQ-1 | WhatsApp support-reply consent (Option B) | Decision pending with the orchestrator; Option A (strict, honest failure) shipped |

## OQ-1 resolution — the support-reply lane (Option B, user decision 2026-10-12)

Shipped as a SEPARATE follow-up PR, after the main PR merged with Option A (strict).

`sendTicketReplyWhatsApp` (`features/whatsapp/whatsappService.ts`) is the one place the
strict explicit-opt-in rule is relaxed. It relaxes it only for an ABSENT opt-in. Each
constraint the decision named is pinned by a refuse-side test in
`test/adr0878-wa-service-reply.test.ts`:

| Constraint | How | Refuse-side witness |
|---|---|---|
| Service-desk ticket replies only, to the ticket's own captured sender, on the same connection | ONE caller: `delivery.ts` passes `ticket.requester.phone` + `ticket.replyChannel.connectionId`. A ratchet pins the caller set, and pins that no pack, surface or tool names the function | `exactly one caller (ratchet)`; `REFUSES on another connection` |
| A free-form session message, never a template | The signature has no `templateId`, and a smuggled one is refused at runtime | `REFUSES a template` |
| Only within 24h of the customer's LAST inbound, from a server-recorded timestamp | The same window-ledger gate as the strict lane. The ledger is written by the VERIFIED inbound observer (`recordInboundMessage`), keyed by connection + number | `REFUSES outside the 24h window` (never wrote in; wrote in 25h ago) |
| Refused on an explicit opt-out (STOP) or an erasure tombstone | `marketing.whatsapp === false`, or a full `marketing: false` with no channel answer → `opted_out`; a tombstone → `subject_erased`. Checked before the window | `REFUSES on an explicit STOP…`; `REFUSES an erased customer` |
| Every other send stays strict | `sendWhatsApp` delegates to the same code with `lane: 'strict'`, unchanged | the PERMITS case asserts the strict lane still refuses the same customer |
| Outside the window the thread says so | The `outside_window` code renders as "Not delivered: outside WhatsApp's 24-hour reply window", with no Retry (a retry cannot reopen the window) | `ticketWorkspace.test.tsx` OQ-1 case |

## Prod exposure (user-approved read-only check, 2026-10-12, rev 00944)

**Every finding was LATENT.** Service desk has never been used in prod:

- 0 `entity:type` rows named `servicedesk.ticket`, out of 18 types.
- 0 `entity:record` rows carrying `ext.ticket`, out of 190 records.
- 0 `assistant:pending-action` rows of kind `servicedesk.reply`.
- 0 `hostext:service-desk:*` rows of any kind: no intake config, no widget key, no SLA timers.
- 0 Support-bundle entitlements.

The `service-desk` and `service-desk.widget` toggles are stored `beta` with no cohort (on
for all, subject to the paywall). `OPENWOP_SESSION_SECRET` is set in prod, so SD2-S3's
empty-key forgery is a white-label-install exposure only. Its tenant-binding half applied
everywhere.

