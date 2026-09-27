# ADR 0478 — HITL completion: the approval SLA/escalation ladder, email approval delivery, and reasoning-at-the-gate

Status: implemented (P5a+P5b+P5c + review fold-in, 2026-07-24 — one PR)
Date: 2026-07-23
Lane: cross-cutting seam (approvals/notifications) — NO new feature package,
NO new toggle for the ladder/reasoning (inert until configured); email
delivery is env-gated like every transport (SMTP config = the switch).
RFC verdict: **host work only, no new RFC.** The ladder is a host-ext timer
collection over the EXISTING approval store; email delivery is a sibling at
the notification-emitter chokepoint (the Teams precedent) whose decide links
ride the ALREADY-NORMATIVE RFC 0093 signed-token resolve endpoint; `reasoning`
is an additive field on host-ext stores + the reviews projection. Nothing on
the OpenWOP wire changes.

## Why this exists

Phase 5 of `docs/WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md` (D7): our
HITL substrate is A−-grade (quorum, delegation, proposals) but incomplete at
the edges the 2026 field productized: deadlines that DO something (today
"timeout-reject" exists for exactly ONE approval kind — composed-workflow
TTL), approvals that reach people where they are (Teams link-out is the only
external lane; no email, no guest decide), and agent-initiated gates that
show the agent's reasoning (Camunda/ServiceNow 2026 pattern).

## Boundaries audit (seam exploration 2026-07-23, file:line verified)

- **Deadline reality:** only `composed-workflow` approvals carry `expiresAt`
  (`approvalService.ts:152,163`), swept by `sweepExpiredWorkflowProposals`
  (`workflowComposeTool.ts:574-610`) off the retention daemon. Generic
  pending approvals sit forever. `resolveApproval` CAS finality
  (`approvalService.ts:1918`) is the settle seam.
- **The exact ladder template exists:** `features/service-desk/sla.ts`
  (ADR 0422 P4) — timer row, `armSlaTimer`/`settleSlaTimer`, CAS-fired
  exactly-once sweep, own 60s `setInterval(.unref)`. Clone, don't invent.
- **Escalation notify + auto-delegate both exist:**
  `escalationNotify.ts:29-74` (ADR 0493 addressed pings) and
  `approvalDelegations.activeDelegations` (`:146-157`) with vote identity
  consumed at ONE resolution authority (`approverResolution.ts`).
- **Signed-token decide fully exists (RFC 0093):** mint at
  `suspendManager.ts:46-85` (opaque 256-bit token, TTL-capped), resolve at
  `POST /v1/interrupts/:token` (`routes/interrupts.ts:261`, timingSafeEqual,
  410 on expiry). The resolve endpoint is TOKEN-auth — a guest approver needs
  no session by construction.
- **The delivery chokepoint:** `notifications/emitter.ts:100` — Teams
  (`teamsApprovalDelivery.ts`) is the productized sibling shape: deliver on
  the notification insert, per-recipient opt-in pref, fail-soft. Teams is
  LINK-OUT only (no in-channel decide). Email transport exists but is
  node/feature-scoped (`host/smtpSend.ts` + `host/emailAdapter.ts`, SSRF-
  guarded) — NOT yet a notification sender.
- **Reasoning:** `ReviewRequest.requestedBy {kind:'agent'|…}` and `summary`
  (from `PendingApproval.proposal`) exist; there is NO agent-reasoning field
  anywhere (`decisionNote` is the REVIEWER's note).
- **Builder multiplayer (the Phase-5 sibling item):** the WS+Yjs collab
  server SHIPS (`index.ts:805`, `collab/collabServer.ts`) and the id-keyed
  workflow binding shape shipped (ADR 0364 P1). P2-3 remain — see the
  sequencing decision below.

## Decision

### 1. The approval SLA/escalation ladder — `host/approvalSla.ts`
The `service-desk/sla.ts` pattern over approvals. A per-tenant POLICY row
(`workflow:approval-sla`, one per tenant, operator-set via
`PUT /v1/host/openwop-app/approvals/sla-policy`):
`{ remindAfterMs?, escalateAfterMs?, expireAfterMs?, enabled }` — every rung
optional; disabled = today's behavior exactly. A TIMER row per pending
approval (`approval:sla-timer`, key `${tenantId}:${approvalId}`), armed at
`createApproval`, settled at `resolveApproval` (both hooks in
approvalService — the ONE create/resolve owner). A 60s sweep walks live
timers and CAS-fires each rung EXACTLY ONCE:
- **Rung 1 — remind:** re-emit the addressed approval notification
  (`emitEscalationNotifications` shape; falls back to broadcast) with
  "awaiting your review since …" copy.
- **Rung 2 — escalate:** re-address to the approvers' ACTIVE DELEGATES
  (`activeDelegations().byPrincipal`) and notify them; when no delegation
  exists, notify tenant admins (the access-control owner role). Delegation
  semantics unchanged — the decide authority was already theirs (ADR 0198);
  the rung only NOTIFIES, it never widens who may decide.
- **Rung 3 — expire (opt-in):** `resolveApproval(status:'rejected',
  note:'sla_expired')` — the fail-closed deadline, off by default.
Every rung emits a governance audit row. The timer row records
`firedRungs: string[]` (CAS via the settle-chain discipline — the ADR 0477
HIGH-1 lesson).

### 2. Email approval delivery — `host/emailApprovalDelivery.ts`
A `deliverEmailApprovalCard` sibling at the emitter chokepoint
(`emitter.ts:~100`), mirroring Teams: fires on the SAME deliverable
notification types, per-recipient opt-in (an `email-approval-delivery` pref
row holding the recipient's address — **v1 correction (ux-review B2):** the
address is FREE-ENTERED, prefilled with the signed-in account's email, with
explicit responsibility copy; a confirm-this-address verification loop is a
RECORDED FOLLOW-ON before this lane is considered hardened — the original
"verified address" phrasing overclaimed), transport via the EXISTING `smtpSend` (env-
configured host SMTP; unset ⇒ the lane is silently absent, like Teams
without a connection). Content rules:
- **Interrupt-backed gates** (approval/clarification interrupts carrying an
  RFC 0093 token): the email carries APPROVE and REJECT links to a tiny
  host-ext confirm page (`GET /v1/host/openwop-app/interrupt-action?token=…
  &action=…`) that renders a one-click confirm form POSTing to the EXISTING
  `POST /v1/interrupts/:token` — decide-by-email, guest-capable (token-auth,
  no session), 410 after expiry, single-use by the interrupt's own finality.
  A GET must never mutate (mail scanners prefetch links) — the confirm page
  is the CSRF/prefetch fence; the POST does the work.
- **Approval-store reviews** (composed-workflow etc.): LINK-OUT to
  `/inbox?approval=…` (the Teams rule — quorum/RBAC decides live in-app).
- No secrets, no payload bodies in the email — title + summary + links (the
  Teams card discipline).
Slack interactive delivery is a RECORDED FOLLOW-ON (a new inbound trust
boundary — signature-verified callbacks — that deserves its own ADR).

### 3. Reasoning-at-the-gate — additive `reasoning` field
`PendingApproval.reasoning?: string` (sanitized, 2000-char cap) + the same on
interrupt `data` payloads; populated by the agent lanes that HAVE reasoning
(the ADR 0473 propose tool gains an optional `reasoning` input — the model
states WHY it composed this; the anon-hold/kicktodo lanes may adopt later);
projected as `ReviewRequest.reasoning` beside `summary`; rendered in
`ReviewCard` under a labeled "Agent's reasoning" disclosure (never conflated
with the reviewer's `decisionNote`). Honesty rule: the label attributes it —
"stated by the agent" — a claim, not a fact.

### 4. Builder multiplayer — SEQUENCED, not built here
ADR 0364 P2-3 (the workflow-collab resource seam + live store binding) stay
gated behind their two RECORDED prerequisites: (i) the ADR 0335 pg
connection-budget reconciliation (poolMax×maxScale vs the ~22-connection
tier — unresolved), and (ii) a two-client browser canary. Building the P3
live binding without those is shipping a multiplayer surface that can
exhaust the production pool — the exact class of gate the architect scope
rule calls real. The assessment's Collaboration axis keeps its honest C−
with the gates named; this ADR's program completes D7 (HITL), not D12.

## Review fold-in (P5, adversarial code + ux rounds — 2026-07-24)

Code round (3 HIGH — one proven end-to-end — + 2 MED) and ux round
(2 BLOCKING + 2 HIGH + 6 MED/LOW) — all applied:

- **code H1 (proven)** — the confirm page's `action:'approve'` fell through
  `recordQuorumVote`'s unknown-action `return null` into the SINGLE-RESUME
  path: one emailed click resolved an N-approver gate. Fixed at the
  STRUCTURAL seam: `recordQuorumVote` maps the `approve` synonym to the
  tally's `accept` verb and FAILS CLOSED (400) on any unknown verb on a
  quorum gate — no caller can silently bypass quorum again. Regression test:
  a 2-approver gate takes two emailed votes.
- **code H2** — the SLA-policy WRITE was member-open while rung-3 is a
  tenant-wide auto-reject (a mass-reject primitive a non-approver could
  never wield through the decide surface — privilege escalation). The write
  now requires `host:members:manage` (or superadmin); reads stay
  member-level. (Test env note: demo mode's documented owner bypass grants
  the memberless principal this scope — fail-closed outside demo.)
- **code H3** — rung-3 raw-rejected kinds whose decline runs FEATURE side
  effects (page transitions, merges, draft archival) — the row flipped while
  feature state wedged. `kindHasRejectSideEffects` (exported from the ONE
  dispatch table) now guards the rung: side-effectful kinds get a LOUD
  "needs a human decision" notification instead of a forced reject.
- **code M1** — the expire notification is gated on the CAS `changed` result
  (a human deciding seconds before the sweep no longer produces a false
  "was auto-rejected" announcement). **code M2** — ladder rows are cleaned
  for tenants whose policy was disabled.
- **ux B1** — expired/decided/invalid email links now render HUMAN pages
  (410 "link expired" / 409 "already decided" / 404), never the JSON error
  envelope; viewport + lang metas added (phone-first surface).
- **ux B2** — the §2 "verified address" claim was corrected in place (the
  address is free-entered, prefilled with the signed-in account's email,
  with explicit responsibility copy); the confirm-address verification loop
  is a RECORDED FOLLOW-ON before this lane is considered hardened.
- **ux H1/H2/M1/M4/M5/M6** — email Save button; SLA load-failure suppresses
  the form (retry) instead of offering to overwrite the real policy with
  defaults; inline styles → classes; "0" rung honesty; stale "Saved."
  cleared on edit; the reasoning disclosure uses the AI-colour bar (the
  house agent-authored marker).

## Matrix
| # | Dimension | Decision |
|---|---|---|
| 1-7 | package/toggle/packs/envelopes/agents/public | none new; the confirm page is host-ext + token-auth (public by token possession, like the resolve endpoint it fronts) |
| 8 | RBAC | ladder policy = tenant-admin write; rungs never widen decide authority (notify-only; rung-3 uses the service resolver); email decide = the RFC 0093 token's existing authority |
| 9 | replay/fork | untouched — approvals/interrupts are not run-event surfaces; rung fires are audit-rowed |
| 10 | frontend | SLA policy panel (approvals admin), ReviewCard reasoning disclosure, email-delivery opt-in on /account; i18n ×4 |

## Phased plan
| Phase | Scope | Gate |
|---|---|---|
| P5a ✅ | SLA policy + timer stores + arm/settle hooks + the 3-rung sweep (exactly-once CAS) + audit rows + `reasoning` field/projection/propose-input + tests (rung firing order + exactly-once; settle-on-decide disarms; rung-2 delegation addressing; rung-3 opt-in expiry; reasoning round-trip; policy RBAC) | backend vitest |
| P5b ✅ | email delivery sibling (pref row + chokepoint hook + smtpSend transport + the token confirm page fronting POST /v1/interrupts/:token) + tests (opt-in gating; interrupt emails carry token links, review emails link-out; GET never mutates; expired token = honest 410 copy) | backend vitest |
| P5c ✅ | FE: SLA policy panel + ReviewCard reasoning disclosure + /account email opt-in + i18n ×4 | FE gates + `/ux-review` |

## Alternatives weighed
1. **Ladder rungs inside the retention daemon** — rejected: hold-hygiene
   cadence (slow, gated) vs an SLA that must fire within a minute of breach;
   the sla.ts pattern owns its own 60s interval.
2. **Decide directly from the email GET link** — rejected: mail scanners
   prefetch GETs; a mutating GET would let a corporate link-scanner approve
   production actions. The confirm-page POST is the fence.
3. **Building ADR 0364 P3 in this phase** — rejected on the two recorded
   gates (§4); sequencing, not scope-cutting.

## Open questions
1. OQ1 — per-approval-kind SLA overrides? v1: one tenant policy; kinds can
   follow once real usage shows divergence.
2. OQ2 — should rung-3 expire default ON for agent-initiated approvals? v1:
   OFF universally (an expiry that rejects work is an operator decision).

## Correction note — grade-trio fold-in (2026-07-24)

1. **Voter identity binding (grade-code H1 — the finding six review rounds
   missed).** The RFC 0093 token is SHARED across every emailed approver, and
   the quorum `voter` was client-chosen (constrained only to `approverRefs`
   membership) — so ONE emailed recipient could cast EVERY listed approver's
   vote and satisfy an N-approver gate alone. Every emailed link now carries
   an HMAC over `(token, voter)` keyed by the session secret
   (`host/interruptVoterBinding.ts`, the `runStreamToken` SEC-1 pattern); the
   confirm page refuses an unbound voter claim outright (404 posture), and
   `assertTokenQuorumVote` requires a valid binding for any explicit-list
   quorum vote on the capability-token lane. Open quorum gates (the
   `openwop-interrupt-quorum` conformance contract) and the authenticated
   in-app lane are unchanged. The original quorum regression test enshrined
   the exploit (both votes posted with bare client-chosen voters) — it now
   asserts the forgery is refused and quorum needs two DISTINCT bound
   identities.
2. **Decide-capable email requires live membership (grade-data M9).** The
   opt-in pref row outlives membership (offboarding runs no pref cascade), so
   a former member kept receiving decide-capable token links on long-lived
   gates. When the tenant has member rows at all, token emails now re-check
   membership at send time and degrade to the link-out email (the inbox
   enforces auth) for non-members; memberless tenants (demo/anon/solo) keep
   pref-set-time authentication as the gate. A member-removal pref cascade is
   the recorded follow-on.
3. **SLA rungs are at-least-once, not at-most-once (grade-code M6).** A rung
   whose fire THREW after the CAS win was permanently recorded as fired. The
   sweep now CASes the rung back out on a failed fire so the next pass
   retries (a duplicate reminder beats a silently missed expire).
4. **Recorded acceptance — guest-surface language (grade-ux #7).** The
   confirm page and the approval email body are English-only in v1: the guest
   approver's locale is unknown (no session), and `Accept-Language`
   negotiation for the page + a recipient-pref locale for the mail are the
   recorded follow-on. The ADR's "i18n ×4" claim covers the in-app surfaces.
5. **DSAR (grade-data H1, ADR 0473-adjacent).** `reasoning` (this ADR's §3) is
   agent prose composed FROM the acting user's conversation, but the
   composed-workflow redactor was structurally dead (empty `idFields` never
   match, so `textFields` never fired) and the row recorded no acting-user id
   at all. Proposals now stamp `composedWorkflow.proposedByUserId`; the
   redactor matches it and redacts `proposal` + `reasoning` (regression-tested).
   Legacy rows without the stamp remain out of reach — KNOWN RESIDUAL;
   teardown is the backstop.
