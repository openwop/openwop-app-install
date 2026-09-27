# Service desk (D8) — chat-first port review

**Scope:** unit D8 — backend `backend/typescript/src/features/service-desk`,
frontend `frontend/react/src/features/service-desk`, packs
`feature.service-desk.{nodes,agents}`. ADR 0422 (implemented P1–P5, 2026-07-19),
toggle `service-desk` (OFF, tenant) + sub-toggle `service-desk.widget`.

**Headline:** This feature was **built chat-first from the start** and mostly
already rides the engine — a real named Support Agent drives the ONE chat with
ACTION tools whose writes route through the assistant approval owner; tickets
are kernel-backed system entities; intake/SLA/notifications ride existing
owners. The port work is **not a rebuild** but **two honesty/parity holes**: (1)
the agent tools enforce a **weaker authorization predicate than their routes**
(cross-org ticket read/act inside a shared tenant), and (2) the "reply reaches
the customer" claim is **painted** — no channel-delivery binding ships, and no
subject-erasure covers the customer PII these tickets hold.

---

## Contract scouting (file:line evidence)

**Owners instantiated (the RIDES grep):**
- **Content kernel** — `ticketStore = makeKernelAdapter<Ticket>({ typeName:
  'servicedesk.ticket', … })` (`tickets.ts:59-70`); minted as a `neverPublic`
  system type (`tickets.ts:39-41`), writes refused by the generic entities API
  (`assertNotSystemWrite`, per the header `tickets.ts:6-8`). Real instantiation,
  not a shadow store.
- **Assistant approval queue (HITL owner)** — `draft-reply` calls
  `enqueueActionWithApproval(tenantId, { kind: 'servicedesk.reply', … })`
  (`agentTools.ts:80-89`); the human decision executes the outbound append in
  `actionExecution.ts:122-149`. Rides the ADR 0308 owner; new `servicedesk.reply`
  kind is in the assistant union + governance policy list (ADR P3 record).
- **Feature agent-tool seam** — 4 tools via `registerFeatureAgentTool`
  (`agentTools.ts:26-118`), pack-allowlisted (`feature.service-desk.agents`
  `toolAllowlist`), never silently added to the default baseline.
- **Notifications owner** — `getNotificationEmitter().emit(...)` on SLA breach
  (`sla.ts:66-75`).
- **Existing inbound seams** — `registerInboundObserver('whatsapp-*', …)` +
  `registerSubmissionSink({ id:'service-desk-ticket', … })` + `resolveIdentity`
  contact attach (`intake.ts:107-145`). No new webhook machinery.
- **Host events** — every mutation emits `host.servicedesk.ticket.*` ids-only
  (`tickets.ts:72-80`), so operators bind automation via the existing
  event→workflow seam.

**Workflows / nodes / agents DECLARED vs IGNITED:**
- The node pack declares **only two READ nodes** (`list-tickets`, `get-ticket`
  over `ctx.features['service-desk']`, `surface.ts:12-24`;
  `packs/feature.service-desk.nodes/pack.json`). Writes are deliberately kept
  off the node surface. **No feature-owned WorkflowDefinition is declared** — so
  there is no orphaned-workflow theater here (a clean absence, not a fake).
- The Support Agent is a **real igniter of app effects**: its `draft-reply` and
  `set-status` tools mutate durable state through owners. Ignition of the ONE
  chat is via the existing `?agent=<id>` deep-link machinery
  (`chat/ChatSidebar.tsx:175-181`, `chat/tabDeck/TabSession.tsx:142`) — though
  **service-desk never emits that deep-link** (see Blocker B3).

**Agent tool allowlist vs what the tools can do:** the persona is NOT toothless
— `draft-reply` (action → approval) and `set-status` (direct CAS mutation,
`tickets.ts:181-196`) are genuine action tools, `list/get` are reads. Correct
read-before-write is enforced in the prompt
(`packs/feature.service-desk.agents/prompts/support-agent.md`).

**Executor/chassis constraint that bounds the port:** the conversation
primitive `ConversationParticipant.subjectRef` admits `user:`/`agent:` **only**
(ADR 0422 Context) — a customer/visitor **cannot** be a conversation
participant. This is why the thread lives ON the ticket (`ext.ticket`,
`ticketTypes.ts:36-51`) and the widget is a separate public lane, not the chat.
That decision is correct and load-bearing; do not try to "move the thread into
the conversation primitive."

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Ticket storage (`servicedesk.ticket` kernel system entity, CAS/idempotent, neverPublic) | `makeKernelAdapter` (`tickets.ts:59-70`) | **RIDES** | Leave. Correctly instantiates the kernel owner. |
| Support Agent triage in the ONE chat (read thread, set status, draft reply) | `registerFeatureAgentTool` ×4 + pack persona (`agentTools.ts`, agents pack) | **RIDES** (with CRITICAL authz-parity blocker B1) | Keep the mechanism; fix the predicate so tools share the routes' org-scope gate. |
| Draft reply → human approval → outbound append | `enqueueActionWithApproval` kind `servicedesk.reply` (`agentTools.ts:80-89` → `actionExecution.ts:122-143`) | **RIDES** | Leave the gate; it is the model-answer pattern. |
| Set ticket status (agent tool + member route) | CAS `setStatus` (`tickets.ts:181-196`), `agentTools.ts:94-118`, `routes.ts:96-104` | **ADAPTER** | Leave; fold status change into the shared org-scope predicate (B1). |
| Omnichannel intake (WhatsApp observer, forms sink, contact attach) | `intake.ts:107-145` | **RIDES** | Leave. Rides the ADR 0394/0330/cdp owners; find-or-create idempotent. |
| SLA clocks → host event + notification | timer-row sweep (`sla.ts:54-91`) | **ADAPTER** | Leave. Bounded timer rows (not a ticket scan); CAS fire-once; rides notifications owner. |
| Member queue + ticket-detail read | `/support` page (`SupportPage.tsx`), list/get routes (`routes.ts:43-58`) | **PAGE-LEGIT** | Keep as a projection page. Add the `?agent=` deep-link to the Support Agent (B3). |
| Member direct reply composer (outbound/internal) + status select | `SupportPage.tsx:60-74,132-141` → `POST …/messages` (`routes.ts:79-94`) | **PAGE-LEGIT** (defensible direct-human surface) | Keep — a human directly acting is not "model output reaching durable state," and both paths converge on `appendMessage` (one owner, no true parallel). Watch for drift. |
| Public widget ticketing lane (HMAC visitor sessions, redaction, double-toggle fail-closed) | `widgetRoutes.ts` | **PAGE-LEGIT** / ADAPTER | Keep. Security posture is solid; FE embed is the chat-widget feature's concern (deferred honestly in ADR P5). |
| Intake config + public-key mint | `intake.ts:45-54`, `widgetRoutes.ts:34-49`, `routes.ts:26-41` | **ADAPTER** | Keep. Admin config over a durable row. |
| Node pack reads (`list-tickets`, `get-ticket`) | `surface.ts` + nodes pack | **RIDES** | Leave. Reads only; no parallel-engine logic in nodes. |
| **"Reply is delivered to the customer via the workspace automation binding"** | claim in `agentTools.ts:65` + `actionExecution.ts:124-128`; **no binding ships** | **THEATER** (painted delivery) | Stop over-claiming OR ship a default reply-approved→channel-send binding. See B2. |

**Counts:** RIDES = 5, ADAPTER = 4, PARALLEL = 0, THEATER = 1, PAGE-LEGIT = 2.

---

## Blockers (from scouting) — each with the honest alternative

### B1 — CRITICAL: agent tools enforce a WEAKER predicate than their routes (cross-org read/act inside a tenant)
The routes gate every ticket path through `authorizeOrgScope → requireOrgScope`,
which calls `resolveEffectiveAccess(tenantId, { subject, orgId })` and requires
the `workspace:read`/`workspace:write` scope **for that specific org**
(`featureRoute.ts:204-207`, `requireOrgScope` body). The agent tools gate on
**only** `enabled()` = feature toggle + a truthy `scope.actingUserId`
(`agentTools.ts:19-22,42,55,77,109`) — **no `resolveEffectiveAccess`, no org
membership check**:
- `list-tickets` takes `orgId` as free input and returns that org's queue
  (`agentTools.ts:41-45` → `listTickets(tenantId, orgId)`, `tickets.ts:217-221`).
- `get-ticket` is **tenant-only** — `getTicket(scope.tenantId, ticketId)`
  (`agentTools.ts:54-58`, `tickets.ts:213-215`) has no org arg at all; the route
  version re-checks `ticket.orgId === orgId` (`routes.ts:55`), the tool does not.
- `draft-reply` and `set-status` likewise act on any ticketId in the tenant
  (`agentTools.ts:78,111`).

**Impact:** in a shared-SSO/multi-org tenant (the exact scenario
`requireTenantScope`/`requireOrgScope` were built for — see their vuln-scan
docblocks, `featureRoute.ts:88-110`), a member of org A can ask the Support Agent
to list, read the full customer thread of, draft replies against, and change the
status of **org B's** tickets — customer PII (`neverPublic`) they cannot reach
through the route. This is precisely the ADR 0458-B1 authority-parity defect.

**Honest alternative:** the KickTodo pattern is the reference fix — extract ONE
subject-based predicate (`hasServiceDeskOrgAuthority(tenantId, orgId, subject,
scope)` over `resolveEffectiveAccess`/`resolveSubjectScopesUnion`) that BOTH
`authorizeOrgScope` (route) and each tool `run()` call, exactly as
`hasKicktodoManageAuthority` is shared by route + `openwop:kicktodo.replan`
(`featureRoute.ts:88-93,229-260`). For `get-ticket`, resolve the ticket's
`orgId` first, then check membership. Read tools fail EMPTY, action tools fail
typed. This is compliance-seam-first work — do it BEFORE any other port change.

### B2 — HIGH: the reply-delivery claim is painted (no shipped binding)
`draft-reply`'s description promises "channel delivery fires via the workspace
automation binding" (`agentTools.ts:65`) and `actionExecution.ts:124-128`
comments that delivery "composes via the operator's event→workflow binding
(openwop-app.servicedesk.ticket-reply-approved → … the whatsapp send node)." On
approval the code appends the OUTBOUND message to the thread and emits
`openwop-app.servicedesk.ticket-reply-approved` (`actionExecution.ts:134-141`) — but a
repo-wide grep finds **no shipped binding, seed, or template** that consumes
that event to actually send to the customer. So by default an approved reply is
recorded on the ticket and **never reaches the customer**. The agent will (per
its prompt) tell the human "the draft is waiting" — honest — but the ADR/tool
copy implies eventual delivery that does not happen out of the box.

**Honest alternative (pick one):**
(a) Ship a **default reply-approved → channel-send binding** for the WhatsApp
channel (the intake channel already exists) so the loop closes for the common
case; or (b) **downgrade the copy** — tool description + ADR say plainly
"delivery requires an operator-configured event→workflow binding (not shipped by
default)" and surface that in the intake-config UI as a deferred-visible state.
Either closes the honesty loop; do not leave "delivery fires" asserted with no
igniter.

### B3 — MEDIUM: the governed agent lane is undiscoverable from its own page
The `/support` page (`SupportPage.tsx`) never deep-links to the Support Agent —
there is no `navigate('/?agent=feature.service-desk.agents.support')` anywhere in
the feature. The chat-first lane (triage, draft-with-approval) exists but is
reachable only if the user already knows to open the ONE chat and scope the
agent. **Honest alternative:** add a "Ask the Support Agent" action on the queue
header / ticket detail that deep-links the main chat scoped to the agent (the
agents-page precedent, CLAUDE.md "No second chat system") — additive, no new
chat surface.

### B4 — MEDIUM (lifecycle): customer-PII tickets have NO subject-erasure / retention coverage
None of the feature's durable stores registers a `registerSubjectEraser` or
retention purger (grep of the ~40-entry eraser boot list excludes service-desk
entirely; contrast `contactsService.ts:481`, which documents CRM as
*deliberately* retention-only). Yet these rows hold customer PII: ticket threads
with customer-authored bodies + `contact:<id>` / `wa:<from>` author refs
(`ticketTypes.ts:25-51`, `tickets.ts:141`), `contactId` scalars
(`tickets.ts:33`), SLA timer rows (`sla.ts:26-31`), intake config, and public
**visitor** threads keyed `widget:<visitorId>` (`widgetRoutes.ts:117-134`). A
DSAR/erasure for a subject leaves their support history intact. **Honest
alternative:** register a `servicedesk` subject eraser keyed on the same subject
forms CRM uses (`contact:<id>`, and the `wa:`/visitor refs), covering
`ticketStore` (via the kernel), `slaTimers`, and `publicIntakeKeys`; OR make an
explicit, documented retention-only decision in the ADR the way CRM did — but
the current silence is neither.

---

## Demolition list (with regression pins)

This feature has **little to demolish** — it was built chat-first. The only
demolition-adjacent item:

- **The painted delivery claim** (B2): once B2 lands, delete the "channel
  delivery fires via the workspace automation binding" phrasing from
  `agentTools.ts:65` if option (b) is chosen. **Regression pin:** a test asserts
  the tool description contains no delivery promise the code does not fulfil (or,
  under option (a), asserts a default reply-approved binding exists and sends).
- **No bespoke "talk to AI" surface exists to demolish** — the feature correctly
  reuses the ONE chat via the agent pack. **Regression pin (guard, not
  demolition):** a test asserts service-desk ships no second chat panel /
  `EmbeddedChatPanel` clone and no bespoke composer that calls an LLM behind a
  button.
- **Member reply composer is NOT a demolition target** — it is a human directly
  acting through the same `appendMessage` owner as the agent lane
  (`routes.ts:86`, `actionExecution.ts:134`); keep it, pin that both paths go
  through `appendMessage` (no third write path may be added).

---

## New-code inventory (small — this is a hardening pass, not a rebuild)

1. **One shared org-authority predicate** `hasServiceDeskOrgAuthority(tenantId,
   orgId, subject, scope)` in `featureRoute.ts` (or the feature), called by
   `authorizeOrgScope` for these routes AND by all four tool `run()` bodies
   (B1). `get-ticket` gains an org-resolve-then-check step. (~40 lines + wiring.)
2. **One `registerSubjectEraser`** for the service-desk stores, or a documented
   retention-only ADR note (B4). (~30 lines.)
3. **Either** a default `reply-approved → channel-send` binding (a thin seam +
   seed) **or** copy correction + a deferred-visible intake-config note (B2).
4. **One deep-link action** from `/support` → `/?agent=…support` (B3). (~10
   lines, FE.)
5. **Regression pins** listed above.

No new workflow, no new node beyond what exists, no new chat surface.

---

## Phased plan (compliance seams first; never demolish before the replacement works)

- **Phase 1 — authority parity (B1, CRITICAL).** Extract the shared predicate;
  route + all four tools call it; `get-ticket` resolves org before authorizing.
  Add a test that a non-member of org B is denied by the *tool* on org-B
  tickets. Close with `/code-review` (authz focus) + fixes applied.
- **Phase 2 — lifecycle/erasure (B4).** Register the subject eraser (or land the
  documented retention-only decision). Add an erasure test over a ticket +
  visitor thread. Close with `/grade-data` + fixes.
- **Phase 3 — delivery honesty (B2).** Ship the default binding OR correct the
  copy + add the deferred-visible note; add the regression pin. Close with
  `/code-review` + `/grade-ai-exchange` (the tool-description↔behavior honesty
  check) + fixes.
- **Phase 4 — discoverability (B3).** Deep-link the Support Agent from
  `/support`. Close with `/ux-review` + fixes.

Each phase is independently shippable; Phase 1 is the only one that gates a
real security hole and should land first.

---

## Deferred honestly

- **Email intake** — ADR 0422 OQ-3 (no inbound-mail path exists; provider +
  trigger decision recorded). Not a regression; genuinely blocked on a provider
  decision.
- **CSAT via forms** — ADR OQ-4 follow-on. Deferred.
- **Widget front-end embed** — ADR P5 explicitly defers the visitor-facing UI to
  the chat-widget feature; the public routes here ARE its API. Honest.
- **Channel delivery binding** — currently deferred *invisibly* (B2). Acceptable
  ONLY once made deferred-*visibly* per Phase 3; today it reads as shipped and is
  the one true honesty defect in the feature.

---

SLUG: d8-service-desk
