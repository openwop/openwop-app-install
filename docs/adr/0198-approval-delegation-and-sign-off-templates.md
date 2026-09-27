# ADR 0198 — Approval Delegation (out-of-office coverage) + the Sign-off Templates

**Status:** implemented (Phase A + Phase B of the approvals-depth program)
**Date:** 2026-07-03
**Depends on:** ADR 0070 (quorum review policies), ADR 0075 (approver routing, the single-resolver law §D1), ADR 0190 (the template-catalog program whose Microsoft-canon research motivated this)

## Why this exists

The Microsoft/enterprise canon research (2026-07-03, verified) found the
enterprise automation canon is approval-centric — and that this host already
implements most of it: quorum N-of-M (ADR 0070), group/role approver routing
(ADR 0075 / Accepted RFC 0104), and sequential chains (DAG composition). The
verified genuine gaps were **delegation / out-of-office coverage** (aspirational
prose only, zero implementation) and a marquee **Request Sign-off** template
(Power Automate's #1 template, ~3.35M instantiations, had no equivalent card).

## Decision

1. **One concept: `ApprovalDelegation` — OOO is a delegation with a time
   window** (`host/approvalDelegations.ts`): `{ fromSubject, toSubject,
   startsAt, endsAt, reason?, revokedAt? }`, durable via `hostExtPersistence`
   with tenant-prefixed keys (tenant-slice reads, never a cross-tenant scan).
   One hop only — delegations never chain.
2. **The delegation join lives in exactly one place** — `approverResolution`
   (the ADR 0075 §D1 single authority): active delegates of ref-resolved
   principals are added to the eligible set (the principal stays eligible — no
   lockout), with an org-membership fail-closed check when an org is in scope.
   Window + revocation are evaluated live at every resolution, so a
   decide-after-expiry fails closed. Notification fan-out inherits delegates
   automatically because it resolves through the same function.
3. **The anti-double-vote identity rule** (`consumeVoteIdentity`): every vote
   consumes exactly ONE identity — the voter themselves when directly eligible
   or on an open gate; otherwise the single principal their delegation covers
   (explicit `actedFor` required, 400, when they cover several; forbidden when
   they name a principal they don't cover). The quorum ledger dedups on the
   CONSUMED identity (`reviewerRef` = the principal, new `actedBy` = who
   clicked), so a principal + delegate pair can never count twice — proven
   end-to-end in `test/approval-delegations.test.ts`. Applied on BOTH decision
   paths (runtime interrupts + pre-execution approvals) **without unifying
   their intentionally-divergent open-gate semantics** (the
   `openwop-interrupt-quorum` conformance contract depends on the divergence).
   An override is the principal's own authority and never rides a delegation.
4. **Routes** `/v1/host/openwop-app/approval-delegations` (host-ext,
   non-normative): self-service (you delegate YOUR approvals; both parties see
   the record; owner-or-superadmin revokes; superadmin may create for others
   and list all). Windows capped at one year.
5. **UI**: a compact delegation section at the foot of the inbox
   (`notifications/DelegationSection.tsx`) — list + create + revoke, 4-locale.
6. **`core.openwop.workflows.approvals` chain pack** (ADR 0190 conventions):
   `approvals.request-sign-off` (the marquee — an OPEN gate any team member
   signs off, zero-config) and `approvals.two-stage-sign-off` (**sequential
   chains are DAG composition, not a new primitive** — two gates in series,
   per-stage approver params).

## Wire honesty (the no-RFC reasoning)

RFC 0104's normative claims are: routing fields surfaced UNCHANGED on the
`InterruptPayload` (untouched), and notifications SHOULD go to "the union of
resolved subjects" — delegation is host-side *resolution*: the union becomes
union ∪ active delegates, consistent with the SHOULD. Eligibility enforcement
is host policy; delegation records are host-ext. With no delegation records
active, behavior is bit-identical, so the `openwop-interrupt-quorum`
conformance scenario is unaffected. **Additive, host-only; no RFC.**

## Alternatives weighed

- *Delegate replaces principal:* rejected — lockout risk if the delegate is
  unavailable; Microsoft OOO semantics keep both able to act.
- *Count a delegate's vote as their own:* rejected — a principal+delegate pair
  would satisfy a 2-of-N gate with one human's authority chain (the integrity
  hole the identity rule closes).
- *A `sequentialApprovers` gate config:* rejected — ordered chains already
  compose as gates in series; a second sequencing mechanism would drift
  against the DAG.
- *Delegation UI on the profile page:* rejected — coverage is configured where
  approvers act (the inbox), matching every enterprise tool.

## Phase B (implemented) — Teams adaptive-card approval delivery

Deliver a user's action-needed notifications to their Microsoft Teams chat as
an adaptive card with a "Review in OpenWOP" deep link. **Delivery only — no
decision surface**: there is no Teams bot, no callback endpoint, no
actionable-messages registration (deciding stays in-app; a card that could
resolve a gate would open a whole new inbound trust boundary — deferred).

- **Seam**: a best-effort delivery leg at the notification emitter chokepoint
  (`notifications/emitter.ts`), parallel to webPush — so it catches EVERY
  action-needed source (runtime interrupts AND pre-execution approvals)
  through the one place records are inserted, and a delivery failure can never
  break the insert (the webPush isolation contract).
- **Credential posture**: sent via the RECIPIENT's OWN `microsoft365`
  connection through `brokeredFetch` (the sole credential authority,
  `apiHosts`-pinned to microsoft.com, keyed per (tenant, provider,
  actingUser=recipient)). No cross-user credential use is possible; a missing
  connection fails closed. The notification id is the broker correlation id
  (`notification:<id>`) — the `runId` slot is correlation-only, not
  load-bearing for a delivery that has no run.
- **Addressed only**: `recipientUserId` notifications (ADR 0050) —
  a broadcast/open-gate approval never sprays personal chats. Only
  `openwop-app.workflow.approval-needed` / `workflow.input_needed` types deliver.
- **Pref**: per-user `TeamsApprovalDelivery { connectionId, chatId }`
  (`host/teamsApprovalDelivery.ts`, tenant-prefixed durable keys); self-service
  routes `/v1/host/openwop-app/approval-delivery/teams` (GET/PUT/DELETE, signed-
  in caller manages own). Deploy-gated (ADR 0033): no pref ⇒ silent no-op; the
  UI section hides entirely without a `microsoft365` connection (honest, not a
  dead form).
- **No RFC**: the adaptive card is Microsoft's wire format on Microsoft's API;
  no OpenWOP wire field, capability, or event changes. Host-ext, non-normative.

### Phase B alternatives weighed

- *Teams bot + Action.Execute card that resolves the gate from Teams:*
  deferred — a decision surface needs an authenticated inbound callback
  (a new trust boundary, bot registration, replay/idempotency on the resolve).
  v1 keeps the single in-app decision path; the card is a doorbell, not a door.
- *A tenant "service" connection sending all cards:* rejected — sending via
  the recipient's own connection keeps the broker's per-user credential
  isolation and means a card only ever reaches a chat that user authorized.
- *Join at the approval-creation sites instead of the emitter:* rejected —
  the emitter is the single chokepoint; joining upstream would miss sources
  and duplicate the delivery decision.
