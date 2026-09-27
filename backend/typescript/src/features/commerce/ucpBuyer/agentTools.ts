/**
 * Procurement Concierge chat tools (CFP-1 — CHAT-FIRST-PORT-AUDIT #1; ADR 0308 seam).
 *
 * The `feature.commerce.buyer.agents.procurement-concierge` pack allowlisted node
 * typeIds that nothing projected into the tool loop, so the agent dispatched with
 * ZERO callable tools. This registers the honest, MONEY-SAFE subset.
 *
 * MONEY RULES ARE ABSOLUTE. Checkout is the app's highest-risk action, and the
 * SERVICE is the authoritative guard (fail-closed org cap + an ALWAYS-required
 * human sign-off on the reviews-inbox queue). The chat tools NEVER move money and
 * NEVER complete a purchase:
 *   - READS (fail EMPTY without an acting user): list-purchases, track-order — over
 *     the buyer's OWN UcpPurchase/order state.
 *   - PREPARE (fail TYPED): build-cart — drafts a spend-CAPPED AP2 cart draft; buys
 *     nothing.
 *   - REQUEST-ONLY (fail TYPED): checkout — REQUESTS the human sign-off (parks the
 *     commerce-spend approval on the reviews inbox) and reports its state. It never
 *     completes a purchase: it only ever calls the service when there is no approval
 *     yet (which parks + throws), and once approved it directs the human to the
 *     governed placement path rather than finalizing from chat (Blocker 2, deferred).
 *
 * External merchant discovery/search (`discover`, `search-catalog`) are PRUNED from
 * the allowlist for this conservative first port — the concierge builds a cart from a
 * human-supplied merchant + lines; model-initiated outbound egress can be added later
 * as read-only tools.
 *
 * Authority parity: workspace:read (reads) / workspace:write (prepare + request)
 * via `resolveEffectiveAccess` — the same boundary featureRoute.requireOrgScope
 * enforces on `ucpBuyer/routes.ts` — plus the `commerce-ucp-buyer` toggle.
 */
import { registerFeatureAgentTool } from '../../../host/agentToolProvider.js';
import type { BundleScope } from '../../../host/inMemorySurfaces.js';
import { resolveOne } from '../../../host/featureToggles/service.js';
import { listOrgs, resolveEffectiveAccess } from '../../../host/accessControlService.js';
import type { Scope } from '../../../host/accessControlService.js';
import { getApproval } from '../../../host/approvalService.js';
import { OpenwopError } from '../../../types.js';
import { listPurchases, getPurchase, trackPurchase, buildPurchaseDraft, checkoutPurchase } from './ucpBuyerService.js';

const BUYER_TOGGLE = 'commerce-ucp-buyer';
const NS = 'openwop:feature.commerce.buyer.nodes.';

export const BUYER_LIST_PURCHASES_TOOL_ID = `${NS}list-purchases`;
export const BUYER_TRACK_ORDER_TOOL_ID = `${NS}track-order`;
export const BUYER_BUILD_CART_TOOL_ID = `${NS}build-cart`;
export const BUYER_CHECKOUT_TOOL_ID = `${NS}checkout`;

/** Every id this feature registers — the pack allowlist must equal this set. */
export const COMMERCE_BUYER_TOOL_IDS: readonly string[] = [
  BUYER_LIST_PURCHASES_TOOL_ID,
  BUYER_TRACK_ORDER_TOOL_ID,
  BUYER_BUILD_CART_TOOL_ID,
  BUYER_CHECKOUT_TOOL_ID,
];

type ToolResult = { content: string; isError?: boolean };
const ok = (payload: unknown): ToolResult => ({ content: JSON.stringify(payload) });
const empty = (note: string): ToolResult => ({ content: JSON.stringify({ note }) });
const toolError = (error: string, message: string): ToolResult => ({ content: JSON.stringify({ error, message }), isError: true });
const isResult = (v: unknown): v is ToolResult => typeof (v as { content?: unknown }).content === 'string';
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function buyerEnabled(tenantId: string, userId?: string): Promise<boolean> {
  const a = await resolveOne(BUYER_TOGGLE, { tenantId, ...(userId ? { userId } : {}) }).catch(() => null);
  return a?.enabled === true;
}

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project<T extends object>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

async function resolveOrg(scope: BundleScope, inputOrgId: unknown, required: Scope): Promise<{ orgId: string } | ToolResult> {
  const orgs = await listOrgs(scope.tenantId);
  const orgId = (typeof inputOrgId === 'string' && inputOrgId.trim()) || (orgs.length === 1 ? orgs[0]!.orgId : undefined);
  if (!orgId) return toolError('org_required', `This workspace has ${orgs.length} organizations — pass \`orgId\` (ask the user which).`);
  if (!orgs.some((o) => o.orgId === orgId)) return toolError('not_found', 'Organization not found in this workspace.');
  const access = await resolveEffectiveAccess(scope.tenantId, { subject: scope.actingUserId!, orgId });
  if (!access.scopes.includes(required)) return toolError('not_found', 'Organization not found in this workspace.');
  return { orgId };
}

export function registerCommerceBuyerAgentTools(): void {
  // ── READS ──────────────────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BUYER_LIST_PURCHASES_TOOL_ID,
      description: 'List the org\'s outbound UCP purchases (merchant, intent, amount, status, approval state). Read-only.',
      inputSchema: {
        type: 'object',
        properties: { orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' } },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return empty('No acting user on this turn — purchase access is resolved per signed-in user.');
      if (!(await buyerEnabled(scope.tenantId, scope.actingUserId))) return empty('UCP buyer (agent purchasing) is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:read');
      if (isResult(org)) return org;
      const purchases = (await listPurchases(scope.tenantId, org.orgId)).map(project);
      return ok({ orgId: org.orgId, total: purchases.length, purchases });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BUYER_TRACK_ORDER_TOOL_ID,
      description: 'Track one outbound purchase — re-checks the merchant\'s current delivery/order status. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          purchaseId: { type: 'string', description: 'The purchase to track.' },
        },
        required: ['purchaseId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return empty('No acting user on this turn — purchase access is resolved per signed-in user.');
      if (!(await buyerEnabled(scope.tenantId, scope.actingUserId))) return empty('UCP buyer (agent purchasing) is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:read');
      if (isResult(org)) return org;
      const purchaseId = str(input.purchaseId);
      if (!purchaseId) return toolError('validation_error', 'Pass the `purchaseId` to track.');
      try {
        const purchase = await trackPurchase(scope.tenantId, org.orgId, purchaseId, { actingUserId: scope.actingUserId });
        return ok({ orgId: org.orgId, purchase: project(purchase) });
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message);
        throw err;
      }
    },
  });

  // ── PREPARE (no money) ───────────────────────────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BUYER_BUILD_CART_TOOL_ID,
      description:
        'Prepare a spend-CAPPED purchase cart draft from an EXPLICIT human authorization (it buys nothing). Pass the human\'s words as '
        + '`intent`, their ceiling as `maxAmountMinor` (minor units — the mandate pins it), the `merchantUrl`, and the `lines`. '
        + 'Never inflate the ceiling, and never invent prices — ask the human for the price of each line if you do not have it from them. '
        + 'Nothing is bought until you request checkout and a human signs off in the reviews inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          merchantUrl: { type: 'string', description: 'The external UCP merchant base URL.' },
          intent: { type: 'string', description: 'The human\'s authorization, in their own words.' },
          // R2 UCP-P2-M6 — "e.g. cents" biased every conversion toward ×100, on the ONE
          // field that caps agent spend: a human's "up to ¥50,000" became 5,000,000 —
          // a 100× inflated ceiling, which `buildCartMandate` then honours. State the
          // exponent rule, and require the currency it applies to.
          maxAmountMinor: {
            type: 'number',
            description: 'The maximum authorized spend in the currency\'s MINOR units. The exponent varies by currency: USD/EUR have 2 (¤1.00 = 100), JPY/KRW have 0 (¥50000 = 50000, NOT 5000000), KWD/BHD have 3. Convert with the exponent of the `currency` you pass, never a fixed ×100.',
          },
          currency: { type: 'string', description: 'ISO 4217 currency code (e.g. USD, EUR, JPY). Required — `maxAmountMinor` cannot be interpreted without it.' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                externalProductId: { type: 'string' },
                name: { type: 'string' },
                quantity: { type: 'number' },
                unitPriceMinor: { type: 'number' },
              },
              additionalProperties: false,
            },
            description: 'The cart line items (from the merchant\'s catalog).',
          },
        },
        required: ['merchantUrl', 'intent', 'maxAmountMinor', 'currency'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'A cart can only be prepared from a human-initiated turn.');
      if (!(await buyerEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'UCP buyer (agent purchasing) is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:write');
      if (isResult(org)) return org;
      try {
        const purchase = await buildPurchaseDraft({
          tenantId: scope.tenantId,
          orgId: org.orgId,
          createdBy: scope.actingUserId,
          merchantUrl: input.merchantUrl,
          intent: input.intent,
          maxAmountMinor: input.maxAmountMinor,
          currency: input.currency,
          lines: Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : [],
        });
        return ok({
          purchaseId: purchase.purchaseId,
          status: purchase.status,
          purchase: project(purchase),
          note: 'Cart prepared as a capped draft — it buys nothing. Next, request checkout; it always pauses for a human sign-off in the reviews inbox.',
        });
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message);
        throw err;
      }
    },
  });

  // ── REQUEST-ONLY (never completes a purchase) ─────────────────────────────────
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: BUYER_CHECKOUT_TOOL_ID,
      description:
        'REQUEST a human sign-off to check out a prepared cart. This NEVER buys anything from chat: it parks a commerce-spend '
        + 'approval on the reviews inbox and reports its state. When it says a sign-off is pending, tell the human it is waiting '
        + 'in the reviews inbox and STOP. If it says the org spend cap is unset/exhausted, say so plainly — never seek another way to pay.',
      inputSchema: {
        type: 'object',
        properties: {
          orgId: { type: 'string', description: 'The organization id (omit when the workspace has exactly one).' },
          purchaseId: { type: 'string', description: 'The prepared purchase to request checkout for.' },
        },
        required: ['purchaseId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) return toolError('acting_user_required', 'Checkout can only be requested from a human-initiated turn.');
      if (!(await buyerEnabled(scope.tenantId, scope.actingUserId))) return toolError('feature_disabled', 'UCP buyer (agent purchasing) is not enabled for this workspace.');
      const org = await resolveOrg(scope, input.orgId, 'workspace:write');
      if (isResult(org)) return org;
      const purchaseId = str(input.purchaseId);
      if (!purchaseId) return toolError('validation_error', 'Pass the `purchaseId` to check out.');
      const p = await getPurchase(scope.tenantId, org.orgId, purchaseId);
      if (!p) return toolError('not_found', 'Purchase not found.');

      switch (p.status) {
        case 'placed':
          return ok({ purchaseId, status: 'placed', note: 'This purchase is already placed.' });
        case 'placing':
          return ok({ purchaseId, status: 'placing', note: 'This purchase is being placed — check back with track-order.' });
        case 'canceled':
          return toolError('canceled', 'This purchase was canceled.');
        case 'unknown':
          return toolError('outcome_unknown', 'This purchase\'s outcome could not be confirmed with the merchant — a human must verify it before any retry.');
        default:
          break; // draft | awaiting_approval | failed
      }

      // If an approval already exists, REPORT its state — never re-invoke checkout
      // (an approved purchase would COMPLETE; final placement is a governed action).
      if (p.approvalId) {
        const appr = await getApproval(p.approvalId);
        if (appr?.status === 'approved') {
          return ok({
            purchaseId,
            status: 'approved_pending_placement',
            approvalId: p.approvalId,
            // R2 UCP-P2-B4 — this named TWO paths, and until this pass neither existed:
            // approving in the reviews inbox only flips the approval row, and the
            // Purchases page had no placement control at all. Name the ONE real path,
            // and hand over the deep link so the human is not left hunting for it.
            note: 'A human approved this purchase. Chat does not finalize purchases: open the purchase and press "Place this purchase" to complete it. Approving in the reviews inbox does NOT place the order.',
            placementUrl: `/commerce/purchases/${encodeURIComponent(purchaseId)}?org=${encodeURIComponent(org.orgId)}`,
          });
        }
        if (appr?.status === 'rejected') return toolError('rejected', 'This purchase was rejected by an approver.');
        return ok({ purchaseId, status: 'awaiting_approval', approvalId: p.approvalId, note: 'A sign-off for this purchase is pending in the reviews inbox. Nothing is bought until it is approved.' });
      }

      // No approval yet — REQUEST one. checkoutPurchase creates the commerce-spend
      // approval and throws `approval_required`; the fail-closed org cap throws first
      // if purchasing is not enabled. Either way, nothing is purchased here.
      try {
        await checkoutPurchase(scope.tenantId, org.orgId, purchaseId, { actor: scope.actingUserId });
        // Defensive: a bare draft with no approval should always park (throw) above.
        const after = await getPurchase(scope.tenantId, org.orgId, purchaseId);
        return ok({ purchaseId, status: after?.status ?? 'awaiting_approval', note: 'A human sign-off has been requested — it is waiting in the reviews inbox.' });
      } catch (err) {
        if (err instanceof OpenwopError) {
          if (err.code === 'approval_required') {
            return ok({ purchaseId, status: 'awaiting_approval', note: 'A human sign-off has been requested — it is waiting in the reviews inbox. Nothing is bought until it is approved, and once approved the human completes it with "Place this purchase" on the purchase page (not chat, and not the inbox).', placementUrl: `/commerce/purchases/${encodeURIComponent(purchaseId)}?org=${encodeURIComponent(org.orgId)}` });
          }
          return toolError(err.code, err.message);
        }
        throw err;
      }
    },
  });
}
