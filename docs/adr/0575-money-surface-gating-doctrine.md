# ADR 0575 — Money-surface gating doctrine: three gate classes (closes CC2-M6)

Status: implemented (2026-08-15) — doctrine block at the operator section, both-directions pinning test (commerce-connect-gate-classes.test.ts), fee-config audit line.

## Problem, re-diagnosed

CC2-M6 recorded: "eight routes ignore the feature toggle its own docblock says
gates them, including a live Stripe refund." The design pass measured the
eight (`commerce-connect/routes.ts`): `GET/POST /approvals*`,
`GET /admin/disputes`, `GET /admin/orders`, `POST /admin/orders/:id/refund`,
`POST /import`, `GET/PUT /fee-config`. **Every one is `requireSuperadmin`-gated
and none is tenant-facing.** The defect is not eight missing gates — it is a
DOCBLOCK that misstates the doctrine, and the absence of a written doctrine
that would stop the next reviewer (or the next well-meaning fix) from adding
`requireFeatureEnabled` to a refund route and thereby trapping money.

## Forces

- **The money-truth rule (CLAUDE.md, ADR 0176/0385):** purchase/payout/refund/
  dispute *events* apply even when the tenant's toggle is OFF. Money that
  moved is a fact the system must keep reconciling regardless of feature
  visibility.
- **Remediation must survive the toggle.** A refund is the remediation of a
  prior charge. If a tenant turns commerce-connect off (or the host disables
  it during an incident), the operator MUST still be able to refund, inspect
  orders/disputes, and adjust fees. Toggle-gating remediation converts a
  feature flag into a money trap.
- **The toggle's actual contract** (FEATURES.md): it governs *tenant-facing
  availability* — what a workspace's users can see and do — not the
  operator's authority over the platform's obligations.

## Decision — the three-class doctrine

Every commerce-connect (and, prospectively, every money-adjacent feature)
route belongs to exactly one class, and each class has ONE gate shape:

1. **Tenant-facing** (seller console, listings browse, checkout, orders,
   payouts, stats): `requireFeatureEnabled` + RBAC/org scope. OFF ⇒ gone
   (404-shaped), never empty. *(All 11 such routes already comply.)*
2. **Money-truth events** (the webhook): applied regardless of toggle; only
   pure account-state events are toggle-gated. *(Already the shipped rule;
   restated here so the doctrine lives in one place.)*
3. **Operator remediation** (refund, disputes, order inspection, fee config,
   listing approvals, the Phase-0 importer): `requireSuperadmin`, and
   **deliberately NOT toggle-gated**. The docblocks say so explicitly, each
   citing this ADR.

## What actually changes

- The lying docblock is rewritten to state class 3 and cite this ADR.
- **A pinning test encodes the doctrine in both directions**
  (`commerce-connect-gate-classes.test.ts`): (a) every tenant-facing route
  404s with the toggle off; (b) the refund/disputes/import/fee-config/approvals
  routes still answer a superadmin **with the toggle off** — so the
  well-meaning future edit that adds `requireFeatureEnabled` to the refund
  route turns the suite red with a message explaining the money trap; (c) every
  class-3 route refuses a non-superadmin 403 (the gate that IS load-bearing).
- `PUT /fee-config` gains an audit-log line (it moves money prospectively;
  the write should be attributable) — the one substantive hardening found.

## Alternatives weighed

- **Add the toggle to all eight** (the naive reading of CC2-M6): rejected —
  traps refunds and dispute handling behind tenant visibility; violates the
  money-truth rule's own rationale.
- **Split a second "operator toggle":** rejected — superadmin IS the operator
  gate; a second flag is a parallel gating system (a Boundaries violation)
  with a fail-open failure mode.

## Test plan / sabotage

The pinning test above is the deliverable; sabotage = adding
`requireFeatureEnabled` to the refund route (fires b), removing it from a
tenant route (fires a), demoting `requireSuperadmin` (fires c).

## RFC verdict

None — host-extension routes and internal doctrine; the wire (webhook
semantics) is unchanged and already conformant.

## Open questions (for David)

None blocking. Optional: whether the doctrine should be lifted into
`ARCHITECTURE.md`'s contract checklist as a named rule (recommended — one
paragraph, cites this ADR).
