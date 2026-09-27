# ADR 0221 — Commerce governance wiring: audit + host events, spend thresholds, brokered confirmations, order-ops verbs, CRM linkage

**Status:** implemented (2026-07-03 — ecommerce gap-analysis §5 Phase B, B1–B6)
**Date:** 2026-07-03
**Track:** A (Software & App Architecture) — extends `features/commerce/` (ADR 0177).
**No OpenWOP wire change → no RFC** (all events are host-ext `host.commerce.*` types
through the ADR 0208 dispatcher; all routes stay under `/v1/host/openwop-app/*`).
**Composes (does NOT fork):** the ONE audit store (ADR 0028), the host-event
dispatcher (`emitHostEvent`, ADR 0208 `crm-orchestration-wiring` — webhook fanout +
event→workflow bindings), the ONE approval loop (`host/approvalService.ts`, ADR
0025/0070/0198 — new `commerce-spend` kind, same queue/quorum/CAS), the governance
policy store (`host/governanceService.ts` — new `commerce` threshold block beside
`adSpend`), the ADR 0193 brokered email spine (`features/email/brokeredProvider.ts`),
CRM Activities (ADR 0008 — deterministic-id append, the ADR 0162 pattern), and the
existing `feature.commerce.{nodes,agents}` packs (v1.1.0).

## Context

ADR 0177 shipped commerce as a working but governance-blind product layer: no
mutation wrote an audit row, no lifecycle event left the feature, refunds and
agent-created orders had no monetary guardrail (the ecommerce gap analysis graded
E7/E8 down for exactly this), the order-confirmation email seam had no wired
transport, and agents had only 2 tools. Every mechanism needed already existed
platform-side — this ADR is wiring, not construction.

## Decision

1. **B1 — Audit rows.** `recordCommerceAction()` in `commerceService.ts` (the
   `recordCmsAction`/`recordAdsAction` precedent): every product / order / coupon
   mutation appends `commerce.<action>` to the ONE audit store with
   `payload.tenantId` (the governance read requires it), the actor, and
   ids/status/amounts only — never card data, never a contact email. Routes pass
   the acting user; the Stripe webhook stamps `stripe-webhook`; agent paths stamp
   `agent`; the seeder's actor rides `createdBy`.
2. **B2 — Host events.** The same helper emits `host.commerce.order.created|paid|
   refunded|canceled|fulfillment-updated` and `host.commerce.inventory.low-stock`
   (fired once per downward threshold crossing in `adjustInventory`) through
   **`emitHostEvent`** — signed-webhook fanout AND event→workflow trigger bindings
   in one call. This is what Phase C8's chain packs will bind to.
3. **B3 — Spend thresholds.** `GovernancePolicy.commerce.{order,refund}ApprovalThresholdMinor`
   (superadmin PUT, same null-clears contract as `adSpend`). Enforcement lives IN
   `commerceService` (`assertCommerceGate`) — the adsAdapter placement lesson:
   direct node calls bypass the capability-firewall. An at/over-threshold mutation
   parks a **`commerce-spend`** PendingApproval (deterministic `spendIdemKey`:
   `commerce-refund:<orderId>`, or a content hash for not-yet-created orders) and
   throws `approval_required` (409, `{approvalId, approvalStatus}` — the raw
   approvalId is entropy-scrubbed by the error envelope's DATA-6 sanitizer on
   the wire, deliberately not weakened; callers key off `approvalStatus` and
   the reviews inbox); a retry after the human decision resumes via the key map. Scope: refunds gate for EVERY
   caller; order-creation gates only the AGENT paths (`ctx.features.commerce`
   `createOrder` and UCP checkout set `requireApprovalOverThreshold` — operator
   REST data-entry stays frictionless). `ucp-place-order` MCP metadata flips to
   `mcpApproval:'conditional'` (defense-in-depth; the service gate is authoritative).
4. **B4 — Real confirmations.** The commerce transactional seam keeps its shape but
   gains a **default transport** wired at feature boot:
   `sendBrokeredTransactionalEmail` (in `features/email/brokeredProvider.ts` — the
   email feature stays the single sender owner) resolves the per-org sender address
   + the acting human's email Connection and sends through the ADR 0193 adapter
   with idempotency key `commerce:order-confirm:<orderId>` on the ONE sent-ledger.
   No sender / no connection ⇒ `false` — the documented honest no-op. Never throws
   into the order flow.
5. **B5 — Order-ops verbs.** `ctx.features.commerce` grows `getOrder`, `listOrders`,
   `refundOrder`, `updateFulfillment`, `adjustInventory`, `listCoupons`,
   `createCoupon`; `feature.commerce.nodes` v1.1.0 ships the matching 7 new nodes
   and the Store Assistant's allowlist widens to all 9 (prompt teaches the
   `approval_required` stop-and-wait behavior). Every write goes through the
   service, so B1/B2/B3 apply by construction.
6. **B6 — CRM linkage.** `markAsPaid` appends a deterministic-id Activity
   (`act:commerce-order-<id>`, kind `note`) to the linked contact's timeline —
   idempotent under webhook re-delivery, best-effort, never blocks payment.
   (Auto-creating a Deal was considered and deferred: the CRM remediation owns
   Deal semantics; an Activity is the uncontended floor.)

## Alternatives considered

- **Firewall-only enforcement for B3** — rejected: the capability-firewall misses
  direct node calls (the documented adsAdapter lesson); service-layer is the only
  chokepoint all four callers (REST, surface, UCP, chains) share.
- **A new `commerce-approval` store** — rejected: ADR 0025 §4 "no second approval
  store"; `commerce-spend` is one more kind on the ONE queue.
- **Gating operator REST order-creation** — rejected: data-entry friction with no
  risk reduction (the operator is the approver); agent paths are where autonomy
  meets money.
- **A bespoke SMTP sender for confirmations** — rejected: ADR 0193's brokered spine
  is the single sender; commerce ships only the compose + context.

## Test plan (landed with the change)

Route: refund below/at threshold (allow / 409 `approval_required`), approve →
retry succeeds, reject → stays blocked; governance PUT round-trips the `commerce`
block; agent-path order gate via the surface. Service: low-stock event fires once
per crossing; order-paid activity is idempotent; audit rows land for the full
lifecycle. Packs: 9 nodes load; manifest versions match `requiredPacks`.
