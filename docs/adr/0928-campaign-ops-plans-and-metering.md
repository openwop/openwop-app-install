# ADR 0928 — Campaign ops: plans, metering and delivery cost

Status: Proposed

Program: agency campaign operations (ADRs 0921–0928). PRD feature **F16**.
Depends on ADR 0921 (client accounts) and ADR 0925 (jobs).

## Context

Test price: **$500 per agency per month** for up to ten active client workspaces
and a bounded number of executions; extra usage is explicit. Meter active client
workspaces and execution volume. Track model and tool cost, connector
maintenance and support time per account. Entitlements are enforced on the
server. This is a test price, not a public offer, and needs no free plan.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **One entitlement resolver:** `resolveEntitlements` merges plan features,
  purchased bundles and unsold features (`features/billing/billingService.ts:
  846-893`); route guards `requireEntitledFeature` /
  `requireEntitledFeatureForTenant` (`features/billing/entitlementGuard.ts:21-63`)
  and the route auto-gate (`features/featureRoute.ts:69`); `resolveOne` is
  toggle + plan, fail-closed (`host/featureToggles/service.ts:574-588`).
- **Paid bundles (ADR 0419):** `OPENWOP_BILLING_BUNDLE_PRICES` maps price →
  bundle (`billingService.ts:308-340`); `OPENWOP_BILLING_PLAN_FEATURES` per plan
  (`:899-952`); the `priced ⟹ gated` invariant via `isSellableBundleFeature`
  (`host/featureBundles.ts:89`).
- **Plan limits:** `OPENWOP_BILLING_PLAN_LIMITS` (`billingService.ts:953-971`);
  only keys in `ENFORCED_PLAN_LIMIT_KEYS` are enforced or displayed
  (`host/planLimitsSeam.ts:26-35, 98`), ratcheted by
  `test/adr0821-displayed-limits-ratchet.test.ts`. `workflowRuns` is counted per
  tenant per UTC month (`host/planRunLimit.ts:1-60`).
- **Count-based limit template:** `features/kicktodo-commerce/tierGuard.ts:14-40`
  (read the limit from `resolveEntitlements(...).limits`, count active rows,
  refuse at the limit).
- **Costs:** `run.metadata.costUsd` per run (`observability/costEmitter.ts:
  207-265`); per-feature managed spend (`host/managedCredits.ts`).
- **No org/workspace/seat count limit exists** (grepped `maxOrgs|maxWorkspaces|
  orgLimit|seatLimit`).

## Decision

### D1 — An `agency-ops` bundle, priced by env, never in code

- Add a standalone bundle `agency-ops` to `distributions/bundles.json` containing
  `campaign-ops` and `campaign-ops-client-portal`. Price it with
  `OPENWOP_BILLING_BUNDLE_PRICES={"<stripe price id>":"agency-ops"}`.
  **Corrected 2026-10-18:** the first draft wrote `<price>:agency-ops`, but the
  variable is a JSON object (`features/billing/billingService.ts:312`); the
  colon form would be dropped with a warning. Found by openwop-app-ea. Money is never in
  `bundles.json`. Because both features are in the bundle, `priced ⟹ gated`
  holds structurally.
- **No free plan:** the bundle's features are not in any plan's free allowlist.
  The test price is a private Stripe price shared by link, not a listed
  storefront offer. Stripe setup follows the existing operator runbook
  (README § "Sell paid feature bundles").

### D2 — Two new enforced limit keys

- `campaignOps.activeClients` (default for the bundle: 10). Counted as
  `ClientAccount.status === 'active'` per tenant. Enforced at client create and
  at un-archive / un-pause with 403 `plan_limit_reached`
  (`{limit, used, key}`), the `tierGuard` pattern. Archived and paused clients do
  not count.
- `campaignOps.executionsMonthly` = **200** for the bundle at the $500 test
  price (owner decision, 2026-10-18). Counted per tenant per UTC month at **job start** (ADR 0925),
  in the same durable counter shape as `planRunLimit`. A replay or a reconcile
  retry does not count; a new job does.
- Both are added to `ENFORCED_PLAN_LIMIT_KEYS` (the ratchet requires it) and
  shown on the billing page.

### D3 — Extra usage is explicit, never silent

At the execution limit, a job start is refused with `plan_limit_reached`. The
operator sees the count and the limit and can ask for more; there is no automatic
overage charge in v1. An agency admin can see current usage at any time. Overage
billing is a later phase.

### D4 — Delivery cost per account (operator-facing, not customer-facing)

A superadmin-only read model `GET /v1/host/openwop-app/campaign-ops/admin/delivery-cost?tenantId&month`
sums, per agency and per client:

- model cost: `ChangeSet.costUsd` plus the interpretation runs' `costUsd`;
- tool cost: execution runs' `costUsd`;
- counts: requests, change sets, jobs, confirmed/conflicted/incomplete steps.

Connector maintenance and support time are recorded as manual monthly entries
(`{tenantId, month, connectorHours, supportHours, note}`) by a superadmin on the
same page. They are cost facts for pricing the test, not billed to the customer.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Limit checks in `features/campaign-ops/` (client and job services); the delivery-cost read model in `features/campaign-ops/admin/`. Billing is composed through `resolveEntitlements`, never reimplemented. |
| 2 | Toggle | None of its own; entitlement gates `campaign-ops` through the bundle. |
| 3 | Workflow surface | None. |
| 4 | Node pack | None. |
| 5 | Envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | None. |
| 8 | RBAC | Limits enforced server-side at the two write points; the cost page is `requireSuperadmin`. |
| 9 | Replay / fork | Execution count is taken at job start, which a replay does not repeat. |
| 10 | Frontend | Usage on the billing page (existing); the superadmin cost page in Admin. |

## RFC verdict

**Host extension, no RFC.**

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| P0 | `agency-ops` bundle + the two limit keys with enforcement and the ratchet entry | No (PRD tier 3; the demo runs on a superadmin or billing-exempt tenant) |
| P1 | Delivery-cost read model + manual entries | No |
| Later | Overage billing; per-seat pricing if agencies ask | No |

## Alternatives weighed

- **Meter via `workflowRuns`.** Rejected: it counts every run of every feature,
  so it cannot express "executions of approved change sets".
- **Count client orgs instead of client accounts.** Rejected: an agency's root
  org and any non-client team org would count; `ClientAccount` is the precise
  unit.

## PRD-vs-architecture corrections

1. "Compose the existing billing and entitlements" → a bundle plus two enforced
   limit keys on the existing seams; no campaign-ops billing code path.
2. "Track connector maintenance and support time" → manual superadmin entries;
   there is no system that measures them.

## Open questions

- [x] **Q1** Execution allowance for the $500 test price: **200 per month**
      (owner, 2026-10-18).
- [ ] **Q2** Should a client in `preview` mode count toward
      `activeClients`? Proposed: yes, since it is an onboarded client.
- [ ] No `/architect` pass has been run on this ADR.
