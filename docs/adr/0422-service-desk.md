# ADR 0422 — Service desk: tickets + omnichannel intake + governed agent resolution

Status: implemented (P1–P5, 2026-07-19)

## Implementation record

| Phase | What landed |
|---|---|
| P1 | `servicedesk.ticket` kernel system entity (neverPublic; thread ON the ticket) via `makeKernelAdapter`; CAS/idempotent service (find-or-create by externalKey, messageId appends, 500-message cap, inbound-reply re-open); member routes; `host.servicedesk.ticket.*` events; toggle + seed ACK. |
| P2 | The `/architect` gate caught + fixed a CRITICAL seam defect first: `registerInboundObserver` was single-slot (would clobber the WhatsApp window ledger) — upgraded to multi-observer. Intake: WhatsApp observer (one continuous thread per sender, MessageSid dedupe), forms sink (after the CRM sink, marker reuse), cdp.resolveIdentity contact attach; explicit per-tenant default-org config (fail QUIET unconfigured). |
| P3 | The governed agent lane: draft-reply → `enqueueActionWithApproval` (new `servicedesk.reply` kind across the assistant union + governance policy list; tainted untrusted); approval executes the idempotent outbound append + emits `reply-approved` — channel delivery via the operator's event→workflow binding (executor decoupled). Tools list/get/set-status; ctx surface; `feature.service-desk.{nodes,agents}` pinned; BI allowlist +ticket. |
| P4 | SLA timer-row collection (bounded sweep, never a ticket scan), armed/settled/re-armed on lifecycle, CAS fire-once breach → host event + notification; `/support` FE (queue + detail + reply composer + intake notice), i18n ×4. |
| P5 | Public widget lane: minted `publicIntakeKey` tenant resolution (re-mint revokes), HMAC visitor sessions (timing-safe verify), double-toggle fail-closed 404s, INTERNAL NOTES REDACTED from every public read, length caps; `service-desk.widget` sub-toggle + ACK. Widget FE embed = the chat-widget feature's embed concern (recorded — these public routes are its API). |

OQ-1 resolved: fixed priority enum v1. OQ-2 resolved: scalar + sweep rows. OQ-3 open (email intake — provider decision + trigger recorded). OQ-4 open (CSAT via forms — follow-on).

Decision source: **docs/steward/GAP-SWEEP-2026-07.md §3 row 4** (customer-support/helpdesk is
table stakes for CRM-bearing platforms — HubSpot Breeze, Agentforce Self-Service —
and the sweep's last zero-coverage hole) and the 2026-07-18 pre-existing-surface
audit, which found **no ticket/case model anywhere** and mapped every seam the
program must extend (below). This ADR is the program plan; each phase gets its
own `/architect` pass at implementation time.

## Context — what exists (the seam map, audited)

- **Inbound**: the ADR 0394 verified-webhook seam (`connections/inboundWebhooks.ts`
  `registerInboundObserver`/`registerInboundGate`) with WhatsApp already
  bidirectional (`whatsappService.extractWaInbound`, 24h session windows); the
  ADR 0330 forms `submissionSinks` capture→fanout registry (CRM sink resolves a
  `contactId` marker); the chat widget (`chat-widget/publicGateway.ts`) —
  deliberately STATELESS single-turn today; email is send-only (bounce webhooks
  exist; no inbound-mail path).
- **Conversation primitive**: `ConversationParticipant.subjectRef` admits
  `user:`/`agent:` ONLY — a conversation cannot hold an external
  customer/visitor. The widget's statelessness is a security posture, not an
  accident.
- **CRM**: `findContactByEmail` + the append-only idempotent `logActivity`
  timeline (`crm/surface.ts:370`), with the forms-sink contact-resolution
  precedent.
- **Ticket-adjacent**: the entities content kernel + `makeKernelAdapter`
  (ADR 0408/0409/0410 — deals/products are kernel-backed system types); the
  task-deck PURE projection pattern (ADR 0133, "a task is a view of a run");
  `assistant/actionApproval.enqueueActionWithApproval` — THE draft-then-human-
  approve queue (PendingAction + host PendingApproval + ActionCard inbox).
- **Routing/SLA/alerts**: org members (assignment targets), run timer-interrupts
  swept by `host/timerSweepDaemon.ts` (SLA clocks), `features/notifications`
  (always-on core), `host/hostEventDispatcher.ts` (ticket events → webhooks +
  `core.trigger.event` workflow bindings).
- **Agent lane**: `registerFeatureAgentTool` (ADR 0308) + the `clarification`
  interrupt kind (Stable on the wire — see `docs/DECISIONS-adr0342-…` DECIDE-3).

## Decision

One new package, `features/service-desk` (toggle `service-desk`, OFF, tenant):

1. **The ticket is a kernel-backed system entity** (`servicedesk.ticket` via
   `makeKernelAdapter`, the ADR 0409/0410 pattern): scalars
   `{ org_id, subject, status (open|pending|waiting_on_customer|solved|closed),
   priority, channel, contact_id?, assignee_member_id?, sla_due_at? }`, full
   thread + metadata in `ext`. **The customer message THREAD lives ON the
   ticket** (an append-only `messages[]` in ext with per-message idempotency
   ids), NOT in the conversation primitive — widening `subjectRef` to external
   participants is a cross-cutting identity change this program does not need
   (alternative weighed below). Internal team discussion about a ticket uses
   normal conversations/channels, linked by ticketId.
2. **Intake adapters extend existing seams — no new webhook machinery**:
   (a) WhatsApp: an inbound observer maps `extractWaInbound` → find-or-create
   ticket (open ticket per sender within the session window); (b) forms: a
   `SubmissionSink` after the CRM sink (reuses its `contactId` marker);
   (c) chat widget: a **Phase-gated upgrade from stateless to ticketed** — a
   visitor message creates/appends to a ticket keyed by a signed widget session
   cookie (the visitor still never becomes a conversation participant; the
   widget renders the ticket thread, not the chat surface); (d) email inbound =
   OUT OF SCOPE v1 (no receive path exists; recorded follow-up — an inbound-MX
   provider integration is its own decision).
3. **Every inbound message attaches to CRM**: resolve contact
   (`findContactByEmail`/phone via CDP identity where enabled), `logActivity`
   on the timeline; ticket events emit through `hostEventDispatcher`
   (`host.servicedesk.ticket.{created,updated,solved}`) so operators bind
   automation workflows without new plumbing.
4. **Agent resolution is governed, never autonomous outbound**: a Service Desk
   agent pack (ADR 0058-style chat-drivability) with ticket tools via
   `registerFeatureAgentTool` (list/get/draft-reply/set-status — the draft
   tool NEVER sends); **drafted replies go through
   `enqueueActionWithApproval`** — the existing approval inbox is the human
   gate; on approval the send rides the channel's existing outbound (WhatsApp
   send surface, email send). Suggested-reply quality rides KB/RAG grounding
   (`ctx.features.kb` — the docs corpus + tenant KB).
5. **Queue + SLA**: the agent-facing queue is a task-deck-style PURE projection
   (no second work-queue store); SLA clocks are per-ticket timer records swept
   by a small daemon interval that emits `sla.breached` host events +
   notifications (composition of existing timer/notification seams — measured
   against the timerSweepDaemon precedent at implementation `/architect` time).
6. **FE**: a service-desk feature package — queue (DataTable + designed states),
   ticket detail (thread + reply composer + approval-aware send), widget thread
   view. Shared `ui/` primitives; no new chat panel (the ONE-chat rule —
   the ticket thread is a domain surface, not an AI chat).

## Alternatives weighed

- **Widen `ConversationParticipant.subjectRef` to `contact:`/`visitor:`** — the
  architecturally deeper move (one thread primitive), rejected for v1: it
  touches the RFC 0048-adjacent identity vocabulary, the ADR 0043 visibility
  predicate, and every participant-scoped read — a cross-cutting program of its
  own. The ticket-owned thread delivers the product without it; if a later
  program needs external participants in conversations proper, that is its own
  ADR (+ probable spec conversation).
- **Tickets as plain DurableCollection rows** (not kernel entities) — rejected:
  the kernel gives queryability (BI metrics over tickets arrive free via
  ADR 0417's allowlist +1), the teardown/fold discipline, and matches the
  0409/0410 direction of travel.
- **A standalone helpdesk app/parallel inbox** — rejected outright (the
  build-on-orchestration rule; the approval inbox + notifications + task
  projection already exist).

## Phased implementation plan

- **P1 — the ticket kernel entity + service**: `servicedesk.ticket` system type
  (kernel adapter), ticket service (create/append/status CAS, idempotent
  message ids), org-scoped routes (reads `workspace:read`, writes
  `workspace:write`, admin ops `host:members:manage`), host events, seed ACK,
  tests (lifecycle, idempotency, tenant isolation, CAS races).
- **P2 — intake**: WhatsApp observer + forms sink + contact attach/logActivity;
  dedup/session-window rules; tests per lane (incl. the fold/duplicate lens).
- **P3 — agent lane**: agent pack + ticket tools (draft never sends) +
  `enqueueActionWithApproval` wiring + approved-send outbound per channel;
  BI metric allowlist +`servicedesk.ticket`.
- **P4 — queue/SLA/FE**: the queue projection + SLA timers/breach events +
  notifications; the FE package (queue, detail, i18n ×4, a11y, dark-mode).
- **P5 — widget ticketing**: the stateless→ticketed widget upgrade behind its
  own sub-toggle (`service-desk.widget`), signed visitor session, rate/abuse
  budgets — its own `/architect` + security pass (the public-surface phase).

## Open questions

- OQ-1: priority model — fixed enum v1 (proposed) vs operator-defined levels.
- OQ-2: does `sla_due_at` live as a scalar (queryable) with the timer as a
  separate sweep record, or timer-only? (Leaning scalar + sweep.)
- OQ-3: inbound email — which MX/provider lane (Postmark inbound? Gmail sync
  extension?) — deferred with a recorded trigger (first operator asking for
  email intake).
- OQ-4: CSAT capture (post-solve form via the existing forms feature) — P4+ or
  follow-on.
