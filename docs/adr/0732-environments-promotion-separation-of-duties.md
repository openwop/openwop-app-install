# ADR 0732 — A promotion approval the proposer can sign is not an approval

Status: implemented

## Context

`EnvironmentSettings.requireApprovalForPromotion` (`environmentsService.ts:86`,
default OFF) is the operator's declaration that a config promotion to a protected
environment must be **reviewed** before the pointer moves. When ON, a promote
queues a `kind:'environment-promotion'` approval into the shared reviews inbox and
the move applies only after a member with `host:members:manage` approves it.

That gate does not deliver a review.

- **No proposer is recorded.** `createEnvironmentPromotionApproval`
  (`approvalService.ts:1850-1871`) persists `envPromotion { toEnv, fromEnv,
  snapshotHash }` and a free-text `proposal` string. The promote path **already
  has** the proposer — `queueEnvironmentPromotionApproval` takes `actor`
  (`environmentsService.ts:532`) — and **drops it** at the call site (`:553`).
- **The decider is never compared to the proposer.** `decideEnvironmentPromotion`
  (`promotionApproval.ts:54-59`) checks only that the decider holds
  `host:members:manage`. So one admin can propose a prod promotion and approve it.
  The gate is on, and it gates nothing the proposer cannot clear alone.

This is the "approval gates that do not gate" family (ADR 0582): the control
exists, is advertised, and the effect routes around it.

### Measured

- `PendingApproval` (`approvalService.ts:230-240`) carries **no** proposer field —
  four-eyes is not merely unenforced here, it is currently **unexpressible**.
- A fresh workspace has **exactly one member**: `createWorkspace` mints a single
  `roles:['owner']` member (`accessControlService.ts:1029-1036`). **A
  single-admin tenant is therefore the DEFAULT starting state, not an edge case.**
  A strict distinct-approver rule with no exit would brick promotion for every new
  workspace that turns the gate on — a gate with no exit, which is its own defect
  (the ADR 0731 lesson, applied before shipping rather than after).
- A house precedent exists: `applyProfileDecision`
  (`kicktodo-community/communityService.ts:236-241`) refuses `decidedBy ===
  creatorSubject` with a `warn` log and a typed `SeparationOfDutiesError`.
- **CORRECTED DURING IMPLEMENTATION — "a one-admin workspace" is narrower than
  the first draft said.** `createWorkspace` mints a founder `owner` member, and
  `deleteMember` **refuses to remove the last owner**. So a workspace always
  retains an owner, and the true sole-approver case is *the owner, alone* — adding
  any second admin already yields two eligible approvers. The first draft of the
  witness added an admin to a fresh workspace and called it "one admin"; it was
  two, and the exit leg failed for a reason unrelated to the code. The measurement
  stands (a new workspace has exactly one eligible approver) but the construction
  of that state is not "create a workspace and add an admin".

## Decision

**D1 — Record the proposer.** `queueEnvironmentPromotionApproval` passes its
existing `actor` through; the approval persists `envPromotion.requestedBy`.

**D2 — Refuse self-approval** at `decideEnvironmentPromotion`, as a typed
`forbidden` refusal plus a governance `warn`, mirroring the kicktodo precedent.

**D3 — The exit: enforce only when a distinct eligible approver EXISTS.** Four
eyes are meaningful only when four eyes exist. When the proposer is the ONLY
member of the tenant holding `host:members:manage`, the decision is allowed and
the approval records that it was self-approved for want of a second approver.
Availability is preserved for the default single-admin workspace, and the fact is
recorded rather than hidden.

**D4 — No second setting.** `requireApprovalForPromotion` already expresses the
operator's intent. Adding `requireDistinctApprover` would ship an
approval gate that is ON-but-toothless by default — exactly the shape this ADR
removes. Separation of duties is a property of the gate, not a second opt-in.

**D5 — Legacy pending approvals are allowed, once, loudly.** Rows minted before
D1 have no `requestedBy`. An absent proposer cannot be compared, so those
decisions proceed and log `environment_promotion_proposer_unknown`. This is a
bounded, stated fail-open for in-flight rows only: refusing them would strand
promotions an operator queued under the old contract. New rows always carry the
proposer.

**D6 — No cross-feature import.** `SeparationOfDutiesError` is defined inside
`features/kicktodo-community` and consumed by `features/kicktodo-creator`.
Importing it from `features/environments` would create a feature→feature edge the
ADR 0446 dependency gate forbids. Environments throws its own `OpenwopError`
carrying a `reason:'separation-of-duties'` detail, mirroring the *pattern* without
the coupling. If a third lane needs it, the type is promoted to the host then —
not speculatively now.

## Alternatives weighed

1. **Strict four-eyes, no exit.** Rejected by the measurement above: it bricks the
   default single-admin workspace.
2. **A `requireDistinctApprover` setting, default OFF.** Rejected by D4 — it
   preserves the toothless gate as the default and asks operators to discover the
   hole.
3. **Compare against the ledger's `actor` instead of a recorded proposer.**
   Rejected: the ledger records the *applied* move, which does not exist until
   after approval. There is no proposer to read at decide time without D1.
4. **Enforce at the route instead of the service.** Rejected: the decide path is
   reachable from the approvals surface as well, so the invariant belongs at the
   one decision function, not at one of its callers.

## Consequences

- With the gate ON and ≥2 eligible approvers, a proposer can no longer approve
  their own promotion: typed 403, governance warn, approval left pending.
- With exactly one eligible approver, behaviour is unchanged except that the
  approval now records the proposer and the self-approval.
- The reviews inbox can show "proposed by" for environment promotions for the
  first time.

## Implementation record

| Phase | Change | Test |
|---|---|---|
| D1 | `envPromotion.requestedBy` persisted; `actor` threaded at `environmentsService.ts:553` | born-red: proposer recorded |
| D2/D3 | `decideEnvironmentPromotion` refuses self-approval when a distinct eligible approver exists | born-red: 2-admin refuses, 1-admin allows |
| D5 | legacy row (no `requestedBy`) decides and warns | leg |
| guard | `ENVC-6` — every admin door refuses a non-admin member | per-door leg over 8 doors |

**Scope correction found by that guard:** `POST /preview` requires
`workspace:read`, not `host:members:manage` (`routes.ts:185`). It is a read door by
design and does **not** belong in the admin set — the first draft of the per-door
leg mis-filed it and failed with a 400 (body validation) instead of a 403, which is
what surfaced the misclassification. The leg now asserts preview is reachable by a
viewer, which doubles as the non-vacuity control for the eight 403s.
