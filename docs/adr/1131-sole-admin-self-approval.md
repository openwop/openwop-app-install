# ADR 1131 — Sole-admin self-approval on autonomy gates

Status: Accepted (2026-11-16, by the user in the Campaign Studio acceptance session). Proposed 2026-11-15. **Amends ADR 0942 D10.2.** Needed by ADR 1126.

## Context

ADR 0942 D10.2 forbids self-approval on an autonomy gate with **no sole-approver escape**
(`host/autonomyPolicy/selfApproval.ts:1-13`): "if nobody else is eligible the gate waits,
escalates and expires as rejected". The refusal is enforced at two sites:
- `routes/interrupts.ts:1822-1826`, "You requested this step, so someone else has to approve it.",
  with reason `autonomy_self_approval_refused`;
- `host/autonomyPolicy/spendEligibility.ts:71`, the same reason for spend decisions.

Every other approval kind follows ADR 0905 D3 (`host/approvalSelfCheck.ts`): "a sole approver is
never locked out (a one-admin workspace is the default state)".

Many small firms have exactly one admin. For them, brief → kernel → film → approve dead-ends: the
only person who could approve is the person who asked. CasaVoga's first user hit exactly this on
casavoga.com 0.13.0 (filed as Campaign Studio ledger CC-GATE-2). The approval card also showed a
generic "no permission, ask an admin" text instead of the server's reason.

**User decision (2026-11-15):** allow self-approval when the requester is the workspace's **sole
admin**, recording a sole-owner self-approval reason. The two-person rule applies again as soon as a
second admin exists.

## Decision

### D1 — Autonomy gates use the shared ADR 0905 D3 helper

Both refusal sites call `selfApprovalBlockedCore` with an autonomy-specific `otherApproverExists`.
That callback is true when **anyone other than the decider and the run's requesters** could decide
this gate:
- a member listed in the policy's `approverRefs` or `approverGroupRefs`, when the policy names
  approvers; or
- otherwise, another member of the workspace with an admin management scope
  (`host:members:manage`, `host/accessControlService.ts:122`).

If someone else exists, the refusal stands exactly as today. If nobody else exists, the decider may
approve **only when** all of these hold:
1. **A person:** the decider canonicalises to a human user. A delegated key resolves to its issuer,
   and an unresolvable identity is still treated as the requester (fail closed, unchanged). API
   keys and agent identities never get the escape.
2. **An admin:** the decider holds an admin management scope in this workspace.
3. **Not a quorum gate:** the gate is not a quorum gate (ADR 0899). Quorum rules are unchanged.
4. **Not over MCP:** the run does not carry the MCP origin (ADR 0942 D10.3), and the vote does not
   arrive over the MCP lane. D10.3's "never unattended over MCP" floor is untouched.
5. **Not a branch fork:** the run is not a branch fork under `forkPosture:'attended'` (D10.4).

This is a host-rule amendment made by ADR on a user decision. It is **not** a policy or preset
relaxation: D10's statement that no preset or policy can relax its floors stays true, and no
campaign policy field can enable or widen the escape.

The check is evaluated **at decide time** against live membership, not when the gate was raised.
So inviting a second admin restores the two-person rule immediately, even for gates already
waiting.

### D2 — Recorded and visible

A sole-admin self-approval writes these on the approval/vote record and the run event:
- `selfApproval: {reason: 'sole_admin', otherApprovers: 0, checkedAt}`
- an audit row `autonomy.self_approval.sole_admin`.

Workspace settings shows "Approvals in this workspace are self-approved because you are the only
admin. Invite a second admin to require a second person." The approval card and run history show
the recorded reason **in both directions**:
- **Allowed:** "Approved as the only admin".
- **Refused:** "You requested this step, so someone else has to approve it" (D3).

A workspace that gains a second admin returns to the two-person rule. That is expected, not an
error state.

### D3 — The card shows the server's reason

The approval card renders the typed refusal's message and reason for every `forbidden_scope`
refusal, instead of a generic permission text. When the reason is `autonomy_self_approval_refused`,
it adds the next step: "Ask another admin, or an approver named in this campaign's policy." This
closes the UI half of CC-GATE-2 independently of D1.

### D4 — ADR 0942 correction note

ADR 0942 D10.2 gains an inline correction pointing here: the "no sole-approver escape" rule now has
the narrow sole-admin escape defined in D1. The original rationale is kept.

## Phases

| Phase | Scope |
|---|---|
| G0 | D3: the card renders the typed reason (UI only; ships independently) |
| G1 | D1 + D2 at both refusal sites through `selfApprovalBlockedCore`; audit row; settings notice; run-history label |
| G2 | ADR 0942 correction note; regression tests: one admin → allowed and recorded; second admin invited → refused; API key → refused; quorum gate → unchanged |

## Alternatives weighed

- **An admin opt-in "allow self-approval" setting.** Not chosen by the user. It would add a
  configuration step before a one-person firm's first approval.
- **Keep the strict rule; a one-owner firm invites a second approver.** Not chosen: it dead-ends
  the default single-admin workspace.
- **A per-client looser review policy** (what CasaVoga used for its own campaign). It remains
  available and unchanged, but it is a per-client workaround, not a default.

## Security notes

The escape cannot be gained by removing other admins mid-flight without that removal being an
audited membership change. Delegates, API keys and agents never qualify. The decision is always
labelled and audited, so a reviewer can see every self-approved spend. Spend caps and thresholds
(ADR 0942, ADR 0952) still apply in full: self-approval lifts only the second-person requirement,
not any cap.

## RFC verdict

**Host extension, no RFC.** Approval semantics are host policy. The interrupt wire shape is
unchanged; only an additive field is recorded on the host's approval record.

## Open questions

1. Whether a workspace admin can turn the escape off ("always require two people") as a setting.
   That is a cheap follow-on if a regulated adopter needs it.
