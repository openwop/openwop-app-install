/**
 * Promotions (ADR 0274 / MERCH-B) — a rule-based incentives engine + loss-leader
 * tooling that COMPOSES the commerce order path via the `promotionSeam` hook
 * (commerce never imports promotions — ruling 1). Registering the feature installs
 * the hook; the engine itself no-ops per-tenant when the toggle is off, so commerce
 * stays byte-identical. Depends on commerce (a promotion has nothing to discount
 * without an order); recommends crm (segment targeting degrades gracefully).
 * Host-extension — no RFC.
 *
 * @see docs/adr/0274-merch-b-promotions-loss-leaders.md
 */
import type { BackendFeature } from '../types.js';
import { registerPromotionsRoutes } from './routes.js';
import { buildPromotionsSurface } from './surface.js';
import { registerPromotionsAgentTools } from './agentTools.js';
import { setOrderDiscountHook } from '../commerce/promotionSeam.js';
import { onProductDeleted } from '../commerce/productLifecycleSeam.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { applyPromotions, pruneProductRefs, erasePromotionSubject } from './promotionsService.js';

export const promotionsFeature: BackendFeature = {
  id: 'promotions',
  registerRoutes: (deps) => {
    registerPromotionsRoutes(deps);
    // CFP-1 — the Promotions Manager's conversational tools (chat-first port).
    registerPromotionsAgentTools();
    // Install the commerce order-discount hook (ADR 0274 ruling 2 — a delta AFTER
    // resolvePrice, never a second pricing path). No-op per-tenant when off.
    setOrderDiscountHook(applyPromotions);
    // RI-4 (grade-data) — drop the product from promotion scopes when it is
    // deleted; a scope that empties deactivates its promotion (disable-don't-
    // destroy). Keyed + idempotent; touches only this feature's own rows.
    onProductDeleted('promotions', async ({ tenantId, orgId, productId }) => {
      await pruneProductRefs(tenantId, orgId, productId);
    });
    // R2 PRO2-P24 — a promotion row carries `createdBy`, a subject key, and this store
    // appeared in NO subject eraser anywhere in the repo (commerce, its own sibling,
    // registers one). Low volume, so this is hygiene rather than a leak — but a deleted
    // operator otherwise leaves their id on every promotion with no erasure path. The
    // promotion itself survives: it is an org's pricing record, not a person's data.
    registerSubjectEraser(async function erasePromotions(tenantId, subjectKey) {
      await erasePromotionSubject(tenantId, subjectKey);
    });
  },
  surface: { id: 'promotions', build: buildPromotionsSurface },
  toggleDefault: {
    id: 'promotions',
    label: 'Promotions',
    description: 'Rule-based promotions engine + loss-leader tooling (MERCH-B).',
    category: 'Commerce',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'promotions',
  },
  requiredPacks: [
    { name: 'feature.promotions.nodes', version: '1.0.0' },
    { name: 'feature.promotions.agents', version: '1.0.1' },
  ],
  dependsOn: ['commerce'],
  recommends: ['crm'],
};
