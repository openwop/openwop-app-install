# ADR 0280 — Sales Commissions (rep incentive compensation)

**Status:** implemented
**Date:** 2026-07-06
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0008 (CRM deals),
ADR 0272 (Territories — quotas/attainment), ADR 0014 (workflow surface), ADR 0015
(workspace-as-tenant). Reuses the accrual PATTERN of ADR 0177 (`commerce/affiliate`).
**Toggle:** `sales-commissions` (new, default OFF, `bucketUnit: tenant`)
**Surfaces:** authed `/v1/host/openwop-app/commissions/orgs/:orgId/*` (host-ext, non-normative)
**RFC gate:** **Host-extension — NO new wire RFC** (rides Accepted RFC 0049 scopes).

## 1. Context
Concept 5 of the sales-org deep-dive (Xactly Incent / CaptivateIQ / Spiff ICM): pay
reps for closed deals against plans with accelerators tied to **quota attainment**. The
app has quotas + weighted attainment (ADR 0272) but no commission layer. The only
"commission" code is **e-commerce affiliate payout** (`commerce/affiliate.ts`, ADR 0177)
— order-referral, keyed on orders, NOT rep-on-deal comp. We reuse its accrual *pattern*
(`CommissionType 'percentage'|'fixed'`, `accrueCommission`), not its store.

## 2. Boundaries audit
- `commission*` → only `commerce/affiliate.ts` (order-referral). `/v1/host/openwop-app/commissions` is a **free prefix**.
- **Rep = the deal's `owner`** (RFC 0048 subject, `crm/entities/deals.ts:42`) — the same key territory per-rep quota splits already use (ADR 0272). No new people store; reps are accessControl members.
- **Quota attainment context** comes from `computeAttainment` (ADR 0272) — accelerators fire past an attainment threshold. Compose it; do not recompute.
- Won-deal amounts come from CRM `listDeals` (status `won`). No CRM-entity column added.

## 3. Decision
New `src/features/sales-commissions/` package on `DurableCollection`s:
```
CommissionPlan   { planId, tenantId, orgId, name, currency,
                   assignment: { kind:'territory'|'role'|'rep', ref },   // who the plan pays
                   rules: CommissionRule[], effectiveFrom, effectiveTo? }
CommissionRule   { basis:'deal-won', rate, type:'percentage'|'fixed',
                   accelerators?: { attainmentGte: number, rate: number }[],  // rate past quota %
                   cap?: number }
CommissionStatement { statementId, tenantId, orgId, subjectId /*rep*/, period,
                   planId, lines: { dealId, dealAmount, rate, commission }[],
                   total, currency, status:'draft'|'approved'|'paid', updatedAt }
```
Computation (`computeStatement(rep, period)`): sum the rep's won deals in the period ×
the plan rate; apply the accelerator rate for deals booked past the rep's quota-attainment
threshold (from ADR 0272 attainment); cap. Deterministic given the deal + attainment snapshot.

## 4. Evaluation matrix
| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `src/features/sales-commissions/`; appended to `BACKEND_FEATURES`; imports CRM + territories (peer) + accessControl (core). |
| 2 | Toggle + admin | `sales-commissions`, OFF, `tenant`, category Business Tools. Plan CRUD in the feature admin. |
| 3 | Workflow surface | `ctx.features.commissions` — reads (`listStatements`, `computeStatement`) + a governed `approveStatement` write (scope-checked like ADR 0272 A5). |
| 4 | Node pack | `feature.sales-commissions.nodes` — compute-statement, list-statements (read); approve-statement (governed, chain-only). |
| 5 | Envelopes | `commissions.statement` read envelope for chat ("what's my commission this quarter?"). |
| 6 | Agent pack | `feature.sales-commissions.agents` — advisory **Commissions Analyst** (reads statements/plans; proposes plan changes; human approves). |
| 7 | Public surface | None. |
| 8 | RBAC | Read own statement = `workspace:read` + subject-scoped (a rep sees only their statement, mirroring ADR 0272 visibility). Plan admin + approve = new `host:commissions:manage` (admin/owner). Fail-closed. |
| 9 | Replay | Statement compute is deterministic on the deal+attainment snapshot; a period-run stamps `run.metadata`. Approve stamps the approver. |
| 10 | Frontend | `/commissions` — plans admin (rules + accelerators) + statements table (per rep/period) with approve; reuses CRM/territories report widgets. |

## 5. RFC gate — host-extension, NO RFC
Commission is host policy over host-extension CRM/territory data; no new scope vocabulary
(one `host:` management scope, the ADR-0024 precedent), no capability advert, no wire event.

## 6. Phased plan
P1 plan model + rule/accelerator config. P2 statement computation (on-demand + a period
run) composing ADR 0272 attainment. P3 approval + payout **status** (payout itself is
external/demo — see deferrals). P4 `ctx.features.commissions` surface + node/agent packs.
P5 frontend admin + statements. Each phase: `/code-review`; P5 `/ux-review`.

## 7. Alternatives weighed
- **Extend `commerce/affiliate`** — rejected: affiliate is order-referral keyed on orders; rep-on-deal comp is a different domain + different store. Reuse the accrual pattern only.
- **Fold commissions into territories (ADR 0272)** — rejected: comp is a distinct capability with its own lifecycle (plans, statements, approval); it *composes* territories' attainment rather than living in it.

## 8. Open questions
- Clawback on a deal that flips won→lost after payout — v1: recompute on the next period run (a negative line); real-time clawback deferred.
- Multi-plan overlap (a rep under two plans) — v1: one active plan per assignment; revisit.
- Real **payout/payment** — deferred (external; demo-mode status only, faithful to the affiliate precedent).

## 9. Recorded non-ships
Real payment/payout rails; splits across multiple reps on one deal; draw/guarantee plans.

## 10. Implementation (P1–P5)
| Phase | What shipped | Notes |
|---|---|---|
| P1 | CommissionPlan model + rule/accelerator config; full plan CRUD; `host:commissions:manage` scope (reserved, admin/owner); type-predicate row validators | `entities/plan.ts`, `routes.ts`, `accessControlService.ts`; test `commissions-plan.test.ts` |
| P2 | `computeStatement` composing ADR 0272 attainment (accelerators fire past the rep's quota %); subject-scoped statement reads (fail-closed, no existence leak); recompute refuses a paid statement | `entities/statement.ts`; unit (effectiveRate/periodContains) + route tests in `commissions-statement.test.ts` |
| P3 | draft→approved→paid state machine (manage-gated; approve stamps the approver; no draft→paid skip); payout external/demo | `entities/statement.ts`, `routes.ts` |
| P4 | `ctx.features.commissions` surface (A5 governed writes vs run owner; subject-scoped reads); node pack (2 read + 2 governed) + advisory Commissions Analyst agent pack (read-only allowlist) | `surface.ts`, `packs/feature.sales-commissions.{nodes,agents}`; `commissions-surface.test.ts` |
| P5 | Frontend `/commissions` — plans admin (rules + accelerators) + statements table with compute/approve/pay; all `ui/` design-system, all states designed | `frontend/react/src/features/sales-commissions/*`; FEATURES.md row |

**Correction vs plan:** none material. The §4.4-style coverage-resolution (auto-matching which reps a role/territory plan pays) is a P2 **simplification** — compute is explicit per (plan, rep) by an admin; auto-enumeration of covered reps is a follow-up (composes accessControl role membership + territory membership reads).

**UX follow-ups (logged, not blockers):** the compute form + statements table use raw RFC 0048 subject ids; wiring the shared **UserPicker** (ADR 0261) for entry + name resolution is the polish pass. Plan **editing** (PATCH) is API-complete but UI is create+delete in v1.

**Recorded non-ship rationale for the surface:** `computeStatement` is a governed write (not a read) in `ctx.features.commissions` because it persists a draft and can target any rep — gating it `host:commissions:manage` prevents a rep computing another rep's statement.
