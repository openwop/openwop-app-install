/**
 * Commerce Connect (ADR 0385) — the two-sided seller marketplace on Stripe
 * Connect (Express accounts + destination charges). Composes billing's ONE
 * Stripe client + ONE public webhook (via `connectEventHook`) and, in later
 * phases, marketplace's Listing projection. Toggle OFF ⇒ routes 404, the
 * webhook handler declines (`handled:false`), byte-identical behavior.
 *
 * @see docs/adr/0385-commerce-connect-seller-marketplace.md
 */
import type { BackendFeature } from '../types.js';
import { registerCommerceConnectRoutes } from './routes.js';
import { registerCommerceListingGate } from './listingApproval.js';
import { registerCommerceConnectExceptionSources } from './exceptionSources.js';
import { registerCommerceConnectErasure } from './erasure.js';
import { setConnectEventHook } from '../billing/connectEventHook.js';
import { setListingPricingProvider } from '../marketplace/listingPricingHook.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { handleConnectEvent, getSeller, listPaidListings, getOrder, createCheckout, sellerStats, listingPricingFor } from './connectService.js';

export const commerceConnectFeature: BackendFeature = {
  id: 'commerce-connect',
  registerRoutes: (deps) => {
    registerCommerceConnectRoutes(deps);
    // ADR 0385 (chat-first-port F3) — register the listing-publish decision handler
    // on the core approvals hook (feature → core; the shared decision core dispatches
    // claim/reject for `kind:'commerce-listing-publish'` here, superadmin-gated).
    registerCommerceListingGate();
    // ADR 0460 (chat-first-port F3 finding 2) — surface the log-only webhook
    // anomalies (unknown order / unknown account / dispute loss) as operator-visible
    // exception-feed rows instead of silent `log.error`.
    registerCommerceConnectExceptionSources();
    // MPL-7 (ADR 0464) — the subject-erasure seam. This feature owned 11 durable
    // namespaces and registered ZERO erasers; `commerce-connect:listing-tombstone`
    // was reachable by no eraser, no purger and no tenant teardown. What the
    // eraser deliberately does NOT touch (the nine money-truth stores) is argued
    // in `erasure.ts` — the ratchet resolves coverage at feature-DIRECTORY level,
    // so that paragraph is what keeps this registration from reading as a
    // blanket coverage claim over all eleven.
    registerCommerceConnectErasure();
    // ADR 0385 § webhook composition — billing fires, we handle; billing never
    // imports this feature. Registration is global; the HANDLER gates on the
    // resolved tenant's toggle (enablement is per-tenant, boot is not).
    setConnectEventHook(handleConnectEvent);
    // ADR 0385 P4 — marketplace fires, we annotate; marketplace never imports
    // this feature. Per-tenant toggle checked HERE (registration is global).
    setListingPricingProvider(async (packNames, viewerTenantId) => {
      const assignment = await resolveOne('commerce-connect', { tenantId: viewerTenantId });
      if (!assignment?.enabled) return {};
      return listingPricingFor(packNames, viewerTenantId);
    });
  },
  // ctx.commerceConnect (ADR 0385 matrix row 3) — Phase 1 ships the seller READ;
  // listPaidListings/getOrder/createCheckout join in Phases 2/4. Surface calls
  // ride role:action nodes (recorded → replay-safe) and are toggle-gated at the
  // featureSurfaces seam per the run's tenant.
  surface: {
    id: 'commerce-connect',
    build: (scope) => ({
      sellerAccount: async () => {
        const seller = await getSeller(scope.tenantId);
        return {
          seller: seller
            ? {
                onboardingState: seller.onboardingState,
                chargesEnabled: seller.chargesEnabled,
                payoutsEnabled: seller.payoutsEnabled,
                region: seller.region,
                mode: seller.mode,
              }
            : null,
        };
      },
      // Phase 2 (matrix row 3): reads + the ONE scoped write. All tenant-scoped
      // to the run's tenant; the service enforces every money gate + idempotency
      // (deterministic orderId ⇒ a :fork replays to the same Stripe key).
      listPaidListings: async () => ({ listings: await listPaidListings(scope.tenantId) }),
      getOrder: async (input: Record<string, unknown>) => {
        const orderId = typeof input.orderId === 'string' ? input.orderId : '';
        const order = await getOrder(orderId);
        return {
          order: order && (order.buyerTenantId === scope.tenantId || order.sellerTenantId === scope.tenantId) ? order : null,
        };
      },
      // Phase 3 — the seller-stats node's single read (state + sales + payouts).
      sellerStats: async () => await sellerStats(scope.tenantId) as unknown as Record<string, unknown>,
      createCheckout: async (input: Record<string, unknown>) => {
        const packName = typeof input.packName === 'string' ? input.packName : '';
        const base = process.env.OPENWOP_PUBLIC_BASE_URL ?? 'http://localhost:8080';
        const started = await createCheckout(scope.tenantId, packName, {
          successUrl: `${base}/commerce-connect?purchase=success`,
          cancelUrl: `${base}/commerce-connect?purchase=cancelled`,
        });
        return { orderId: started.order.orderId, url: started.url, mode: started.mode };
      },
    }),
  },
  requiredPacks: [
    // Kept in LOCKSTEP with `packs/feature.commerce-connect.nodes/pack.json`.
    // This ref is the registry install TARGET when the pack is absent on disk
    // (`installRegistryPacks.ts`), so a stale pin here would fetch the OLD
    // content under a new local version — the exact repo↔registry drift
    // `scripts/check-pack-version-bump.mjs` exists to prevent. Every other
    // feature in the repo holds this invariant (measured: 113/113); nothing
    // enforces it mechanically yet.
    { name: 'feature.commerce-connect.nodes', version: '1.0.1' },
  ],
  toggleDefault: {
    id: 'commerce-connect',
    label: 'Commerce Connect (seller marketplace)',
    description:
      'Two-sided seller marketplace on Stripe Connect: Express seller onboarding, destination-charge purchases with a platform application fee, and paid marketplace listings. Rides billing’s Stripe key + webhook; demo-mode without a key. OFF by default.',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'commerce-connect',
  },
};
