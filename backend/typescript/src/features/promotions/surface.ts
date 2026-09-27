/**
 * Promotions workflow surface (ADR 0274 / MERCH-B) — `ctx.features.promotions`.
 * A thin adapter over the promotions store (source of truth shared with REST).
 * Tenant from the run scope (CTI-1); `orgId` node-supplied + service-enforced.
 *
 * READ: listActive / applyPreview. WRITE: `create` — but an agent-authored promotion
 * MOVES MONEY, so (ADR 0058 chat-drivability review, finding 1) it lands PROPOSED
 * (`active:false`): a human activates it in the Promotions page. This is the
 * "agent proposes, human confirms" firewall (the strategy/CDP precedent), not an
 * auto-live path. `createPromotion` is the SAME service fn the REST route calls.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listPromotions, createPromotion, applyPromotionsUngated } from './promotionsService.js';

const INTERNAL = new Set(['tenantId', 'createdBy']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

export function buildPromotionsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    listActive: async (args) => ({
      promotions: (await listPromotions(tenantId, str(args.orgId))).filter((p) => p.active).map(project),
    }),
    // Preview what the active promotions would discount on a hypothetical cart (read-only).
    applyPreview: async (args) => {
      const items = Array.isArray(args.items) ? (args.items as { productId?: unknown; unitPrice?: unknown; quantity?: unknown }[]).map((i) => ({ productId: String(i?.productId ?? ''), unitPrice: Number(i?.unitPrice ?? 0), quantity: Number(i?.quantity ?? 0) })) : [];
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      const r = await applyPromotionsUngated({ tenantId, orgId: str(args.orgId), currency: str(args.currency) || 'USD', subtotalAfterCoupon: subtotal, items });
      return { discount: r.discount, appliedPromotions: r.appliedPromotions };
    },
    // WRITE (role:'action') — agent-authored ⇒ PROPOSED (active:false), human activates.
    create: async (args) => {
      const promotion = await createPromotion({
        tenantId, orgId: str(args.orgId), createdBy: 'agent',
        name: str(args.name), type: args.type, reward: args.reward,
        scope: args.scope, minSpend: args.minSpend, minQuantity: args.minQuantity, bogo: args.bogo, budget: args.budget, segmentId: args.segmentId,
        priority: args.priority,
        active: false, // proposed — never auto-live from a run (money-moving)
        // R2 PRO2-P1 (review B2) — this lane dropped it too.
        currency: args.currency,
      });
      return { promotionId: promotion.promotionId, active: promotion.active, proposed: true };
    },
  };
}
