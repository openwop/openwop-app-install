# ADR 0075 - HITL approver routing, pre-flight resolvability, and targeted delivery

**Status:** implemented (host approver-routing Phase 2 landed as a focused pass — group/role/audience resolution + pre-flight resolvability + targeted delivery; rides Active RFC 0104. Status line corrected 2026-06-22.)
**Date:** 2026-06-19
**Depends on / composes:** `host/approvalService.ts` + `host/approvalDecision.ts` (ADR 0070 quorum), `routes/interrupts.ts` (resolve-time eligibility), `bootstrap/nodes.ts` (`core.approvalGate`), `host/reviewProjection.ts` (ADR 0068 unified review), `notifications/notify.ts` + `notifications/emitter.ts` + the `recipientUserId` addressed-notification channel (ADR 0050), `host/accessControlService.ts` (ADR 0006 / RFC 0049 — orgs/members/roles/groups/scopes), `host/workflowDefinitionValidation.ts` (called from `routes/runs.ts`), `builder/palette/nodeCatalog.ts`.
**Surface:** host-extension approval routing under `/v1/host/openwop-app/*` (reviews, approvals, notifications, runs). **Non-normative** — no OpenWOP wire change in this ADR.
**RFC gate:** Phase 1 (this ADR) is host-only and needs **no** RFC — it rides the already-specified advisory `approversList` field (`interrupt.md`) and the non-normative host-extension surface. Making group/role/`audience` routing **portable + normative across other hosts**, and adding **step-up auth** + **credential-bound (on-behalf-of) approvals**, DO change the wire/auth contract and are tracked as **RFC 0104** (additive, approver routing) and a separate step-up/credential RFC. Neither is a prerequisite for Phase 1 functioning on `app.openwop.dev`.

## Why this exists

A workflow with a human-in-the-loop (HITL) approval — "the controller must verify this accounting step," "legal + compliance must both sign off" — only works if the *right* human is identified, notified, and can act. Today the runtime *decision* engine is strong (durable quorum, dedup, rejection policies — ADR 0070), but the *routing* around it is not:

- **No pre-flight check.** Run creation (`routes/runs.ts`) validates capability gates and node/edge IDs (`workflowDefinitionValidation.ts`) but never inspects approval nodes for a resolvable approver. A gate whose approver is unconfigured, mistyped, or points at a deleted group **creates fine, runs fine, then suspends forever** and notifies nobody in particular.
- **Broadcast-only notification.** `emitInterruptNotification` (`notifications/notify.ts:44`) never sets `recipientUserId`, so every approval is visible tenant-wide and *nobody is specifically notified* — even though the addressed-notification channel (ADR 0050) already exists and is used for `task.assigned`.
- **No group/role binding.** `accessControlService` models orgs, members, roles, scopes, and groups, but approvals can only name **individual subject refs** (`approverRefs`, ADR 0070); "anyone in finance-approvers" / "whoever holds Controller" cannot be expressed. `approverGroupRefs` was designed and deferred in ADR 0070.
- **No authoring surface.** The builder approval-node inspector exposes only `prompt` (`builder/palette/nodeCatalog.ts:216`).

This ADR closes the routing gap **host-side**, without forking the protocol, by extending the owners the architecture contract names for approvals (approval service + interrupt/approval-gate), credentials (BYOK/Connections), orgs/roles (`accessControl`), and notifications.

## Decision

Deliver approver routing as a **host-extension capability layered on the existing owners**, governed by four load-bearing decisions (each maps to an architecture-review finding).

### D1 — One approver-resolution authority (single source of truth)

Introduce **one** resolver in the approval layer:

```ts
// host/approverResolution.ts (new, owned by the approval surface)
resolveEligibleApprovers(
  policy: ApproverPolicy,
  ctx: { tenantId: string; orgId?: string },
): Promise<{ subjects: string[]; openGate: boolean; unresolved: ApproverRef[] }>
```

All three call sites — **pre-flight** (D4), **notification fan-out** (D3), and **decision-time eligibility** (`routes/interrupts.ts` + `approvalDecision.ts`) — MUST go through it. Three independent answers to "who may approve this gate" is the orgs/`accessControl` duplication the architecture contract forbids; a single resolver guarantees pre-flight, the inbox, the notification recipients, and the 403 boundary always agree.

### D2 — Group/role refs on the shared approval policy (host-extension, both surfaces)

There are two approval surfaces the unified projection (ADR 0068) already merges: the **interrupt approval-gate** (`core.approvalGate` → `interrupt.kind:'approval'`) and the **agent-proposal approval** (`PendingApproval.policy`, ADR 0070). Both carry a policy that already has `approverRefs`. Extend that **one** shared policy shape:

```ts
interface ApproverPolicy {
  approverRefs?: string[];        // explicit subjects (existing, ADR 0070)
  approverGroupRefs?: string[];   // NEW — accessControl groups
  approverRoleRefs?: string[];    // NEW — accessControl roles (built-in or custom)
  requiredApprovals: number;      // existing
  rejectionPolicy?: 'any' | 'majority';
}
```

These refs live in the **host-extension layer** — `PendingApproval.policy` and the host-side review record attached to the interrupt (the ADR 0068 projection), **not** new fields on the OpenWOP `interrupt.data` wire payload. That is precisely what keeps Phase 1 host-only and RFC-free: the wire `approversList` stays advisory and unchanged; the host owns the richer routing. (Portability across non-app hosts is RFC 0104.)

### D3 — Live membership resolution, with a replay/audit snapshot on the decision

Group/role refs are dereferenced to subjects **live, at notification and decision time**, against `accessControl` — **not** frozen at suspend. Rationale: a long-running approval must honor someone who *joins* finance-approvers after the run suspends; freezing membership at suspend (node-execute) is a correctness bug for exactly the regulated case.

Membership is a dynamic external authority (like a provider lookup), so to keep replay/fork deterministic we follow `replay.md` discipline: **the resolved decider and a membership snapshot are recorded on the decision record/event** when the gate is decided. Replay reads that verbatim; it never re-resolves membership at fork time. The advisory interrupt payload is untouched, so historical checkpoints replay unchanged.

### D4 — Open-gate-safe pre-flight resolvability scan

Extend `workflowDefinitionValidation.ts` (invoked from `routes/runs.ts` at run-create) with a scan over **reachable** approval nodes that calls D1's resolver:

- **Reject** (`422 unresolvable_approvers`, citing `nodeId`) only when an approver ref is **present but unresolvable** — a mistyped `user:…`, or a group/role that doesn't exist or belongs to another tenant.
- **Pass** an **empty** policy: an empty approver set is an *intentional open gate* (anyone holding `approvals:respond`), which is spec-conformant (`interrupt.md` — `approversList` advisory; `routes/interrupts.ts:471`). Pre-flight MUST distinguish "open by design" from "named but broken," or it would reject valid conformant workflows.

### Supporting decisions

- **D5 — Tenant/org-scoped resolution (IDOR).** Group/role refs resolve only within the caller's `tenantId`/`orgId`, reusing the predicate `accessControlService` already applies (`:464`). A cross-tenant ref resolves to ∅ and is treated as unresolved (→ D4 reject), never a cross-tenant leak.
- **D6 — Targeted delivery via ADR 0050.** Notification fan-out resolves the approver set (D1) and emits **addressed** notifications (`recipientUserId`) to each eligible subject. An **admin/tenant "all approvals" view** is retained so coverage/oversight isn't lost. Open gates fall back to broadcast (current behavior). Targeted delivery ships **behind the feature toggle** — it's a visibility change (people who today see every approval will stop seeing ones not addressed to them), so it's a migration, not a flip.
- **D7 — Bounded resolution cost.** Add point-lookup helpers (`getMembersWithRole`, `getUsersByGroup`) to `accessControlService`; do **not** run an unbounded `members.list()` cross-tenant scan on the suspend/notify hot path. If an index is deferred, the scan bound is documented and `log`-surfaced.
- **D8 — Authoring surface.** Extend the approval-node inspector (`builder/palette/nodeCatalog.ts`) with approver (subject), group, role, `requiredApprovals`, and `rejectionPolicy` fields, validated against the same resolver before save.
- **D9 — Route-level tests.** Eligibility, targeted delivery, pre-flight reject, the open-gate carve-out, and tenant-scoping are only observable at the HTTP boundary — covered with `createApp` + cookie-jar route tests (the existing pattern), not service-only.

## What is host-only vs. what needs an RFC

| Capability | Lane | Gate |
|---|---|---|
| Pre-flight resolvability (D4), shared resolver (D1), targeted notify (D6), inbox "assigned to me," builder UI (D8) | **Host-only — this ADR** | rides advisory `approversList`; non-normative `/v1/host/*` |
| Group/role approver binding, live-resolved (D2/D3), for `app.openwop.dev` | **Host-only — this ADR** | refs live in host-extension records, off the wire |
| Group/role/`audience` routing **portable + normative across other hosts** | **RFC 0104** (additive) | adds optional fields to interrupt `ApprovalData`; `approversList` stays advisory |
| **Step-up / re-auth** (`acr`/`amr`) at a sensitive gate | **RFC** (auth profile) | new auth contract; touches `auth.md` |
| **Credential-bound / on-behalf-of** approval (approver's HR/finance/security creds) | **RFC** (auth + security) | SECURITY invariant + public conformance test; secret-leakage threat model |

The credential-bound and step-up capabilities are the genuinely regulated-workflow features (non-repudiation, "the controller posts to the ledger with *their own* SSO"). They are out of scope for Phase 1 and require the protocol process; this ADR deliberately does **not** advertise them.

## Implementation plan (phased)

| Phase | Work | Files |
|---|---|---|
| 1.1 | `resolveEligibleApprovers` + `ApproverPolicy` shape; route the 3 call sites through it | `host/approverResolution.ts` (new), `host/approvalDecision.ts`, `routes/interrupts.ts` |
| 1.2 | `accessControl` point-lookups `getMembersWithRole`/`getUsersByGroup` (tenant/org-scoped) | `host/accessControlService.ts` |
| 1.3 | Open-gate-safe pre-flight scan | `host/workflowDefinitionValidation.ts`, `routes/runs.ts` |
| 1.4 | Targeted delivery via `recipientUserId` + admin "all approvals" view; toggle-gated | `notifications/notify.ts`, `routes/notifications.ts`, `notifications/NeedsYouInbox.tsx` |
| 1.5 | Decision-record membership snapshot (replay/audit) | `host/approvalDecision.ts`, decision event/record |
| 1.6 | Builder approval-node inspector fields | `builder/palette/nodeCatalog.ts` + inspector |
| 1.7 | Route-level tests across 1.1–1.6 | `backend/typescript/test/` |

## Open questions / decisions checklist

- [ ] Toggle name + `bucketUnit` for targeted delivery (user-level, since it's per-recipient visibility).
- [ ] Does an open gate (no named approver) broadcast to the whole tenant (today) or only to `approvals:respond` holders? (Proposed: the latter, as the safer default — confirm.)
- [ ] Segregation of duties (initiator ≠ approver): include a `excludeInitiator` policy flag in Phase 1, or defer? (Recommend include — it's host-side and cheap.)
- [ ] Escalation/delegation/OOO reassignment — explicitly deferred to a follow-up ADR (timeout already exists via the approval-gate timeout).
- [ ] Confirm the decision-record snapshot shape satisfies the audit/non-repudiation requirement without an RFC (it's host-extension audit, so it should).

## Implementation status

**Phase 1 — shipped (host-only, no RFC), branch `feat/hitl-approver-routing`:**

| Decision | What landed | Verify |
|---|---|---|
| D1/D5 | `host/approverResolution.ts` — single `resolveEligibleApprovers` authority (expansion + tenant/org scoping + `unresolved` classification) | `test/approver-resolution.test.ts` |
| D2 | `ApprovalPolicy.approverGroupRefs` / `approverRoleRefs` (host-extension) | tsc |
| D7 | `accessControl` `getUsersByGroup` / `getMembersWithRole` (tenant/org-scoped) | resolver tests |
| D1 (eligibility) | `evaluateQuorum` routes through the resolver — group/role approvers enforced on the pre-execution approval surface, open-gate asymmetry preserved | 100 approval/quorum tests |
| D6 | `notify.ts` addresses interrupt HITL notifications to named approvers (`recipientUserId`), open gate → broadcast, fail-safe to broadcast on unmappable approver; core-declared subject→userId resolver seam registered by the users feature | resolver/targeting tests; full suite (2051) |
| D8 | builder approver / `requiredApprovals` / rejection-policy fields on the approval node | FE build |

**Surface coverage note (D6):** investigation found the **interrupt gate** is the only HITL surface that *both* emits a proactive notification *and* carries named approvers — so it is the one targeted. Content-publish is inbox-only (eligibility enforced via the resolver, no emit); agent-proposal / assistant-action / proposals are open or single-approver (broadcast is correct). No other emit site needed targeting for the current capability.

**Phase 2 org-context decision (RESOLVED 2026-06-19 — was the open blocker).** Enforcing group/role approvers on the interrupt path needs the run's org (group/role are per-org in `accessControl`). Decision: **stamp `run.metadata.orgId` at run-create**, sourced fail-closed as (1) an explicit request org, else (2) the tenant's *sole* `accessControl` org when exactly one exists, else (3) unset. Resolution reads `run.metadata.orgId` verbatim (replay-safe). **Fail-closed on ambiguity:** if a reachable approval gate names group/role approvers and no org resolves, run-create **rejects** (`422 unresolvable_approvers`, D4) — the org is never *guessed*, so a group/role ref can never resolve against the wrong org (no cross-org approval leak). This makes the org-stamp and the D4 pre-flight one coherent, security-safe decision.

**Phase 2 implementation order (coherent unit — lands together to avoid authorable-but-unenforced gaps):** (1) builder group/role fields + `approvalGateNode` forwards them into `interrupt.data` (Active RFC 0104 wire shape); (2) run-create org-stamp + D4 pre-flight resolvability; (3) `assertEligibleApprover` expands group/role via the resolver using `run.metadata.orgId`; (4) `notify.ts` expands for targeting; (5) advertise `interrupt.approverRouting:{supported,refKinds,audience}`; (6) tests + the conformance leg. Gate satisfied (RFC 0104 `Active`); the spec session lands `suspend-request.schema.json` in parallel. Security-sensitive (org isolation + fail-closed pre-flight), so it is implemented + verified as a focused pass, not folded into unrelated work.

**Phase 2 — shipped (host-only enforcement, on branch `feat/hitl-approver-routing`):**

| Piece | What landed | Verify |
|---|---|---|
| Pre-flight + fail-closed org-stamp (D4/D3) | `runs.ts` scans group/role gates, stamps `run.metadata.approverOrgId`, rejects unresolvable | pre-flight tests, suite 2056 |
| Wire emission | `approvalGateNode` forwards `approverGroupRefs`/`approverRoleRefs` → `interrupt.data` (RFC 0104 Active shape) | tsc |
| Eligibility enforcement | `assertEligibleApprover` (interrupt) + `evaluateQuorum` (approval) expand group/role via the resolver; **direct refs match RAW, group/role-expanded subjects canonicalized to userId** (the namespace fix) | `isEligibleApprover` tests; suite 2060 |
| Targeted delivery | `notify.ts` resolves group/role + org for `recipientUserId` fan-out | suite |
| Authoring | builder approver-group / approver-role fields | FE build |

**Still pending — legitimately gated on spec-side schema convergence (crosstalk-driven):**
- **Capability advertisement** `interrupt.approverRouting:{supported,refKinds:["group","role"],audience:true}` in `/.well-known/openwop` — held until the vendored `capabilities.schema.json` + `suspend-request.schema.json` land from the spec session (advertising a flag the schema doesn't yet define would be premature). The host *honors* group/role approvers now; advertising follows the schema. Plus the capability-gated conformance leg in `../openwop`.
- `audience`-as-explicit-override (vs. the default = eligible set, which works now) when the RFC's `audience` field lands.

**Deferred to Phase 2 (decision above resolved; schema convergence pending on the spec side):**
- Group/role + `audience` on the **interrupt** path: requires the optional fields on the `kind:"approval"` `InterruptPayload` (`suspend-request.schema.json`) + the `interrupt.approverRouting` capability advertisement. Wire shape agreed with the spec session (structured capability; `audience` defaults to the eligible set). Host promotion (forward refs onto the payload, advertise the capability, wire `audience`-based targeting) lands when the schema is on `origin`.
- **D3** decision-time membership snapshot for **interrupt** replay/fork; **D4** pre-flight resolvability for interrupt-path group/role (needs run-create org context) — both couple to the same wire.

## Consequences

**Positive:** the accounting/finance scenario works end-to-end host-side; one resolver kills drift; the protocol is not forked; targeted delivery + open-gate-safe pre-flight remove the silent-deadlock and notify-everyone failure modes; the design leaves clean seams for the RFC-gated portability/credential/step-up work.

**Negative / risks:** targeted delivery is a visibility migration (mitigated by toggle + admin view, D6); live role/group resolution adds reads on the suspend/notify path (mitigated by D7); the host-extension routing is **not portable** to third-party hosts until RFC 0104 lands (accepted trade-off — `app.openwop.dev` is the only target now).


## § Follow-on — Human Tool Market (innovation strategy, 2026-06-24)

The innovation strategy proposes exposing **humans/teams as typed, callable tools** with
input/output schemas, SLA, authority, and routing (request legal review, brand review,
data-steward approval, exec decision with a structured review packet). This **extends
THIS ADR**: approver routing (group/role/audience) + the interrupt/resume seam already
deliver targeted human decisions; the market adds a typed `HumanCapability` (schema +
SLA + authority) surfaced as an MCP/agent tool whose invocation IS a structured
interrupt resolved by the routed approver. Reuse the approval/interrupt machinery (no
second approval store); honesty: advertise a human tool only when an approver can
actually be routed. Host-extension, no new RFC (rides RFC 0064/0104).
