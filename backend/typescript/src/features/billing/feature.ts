/**
 * Subscriptions & Billing (ADR 0176) — a new feature-package that reverses the
 * roadmap's commerce cut ADDITIVELY. Owns subscription/plan state + the prepaid
 * AI-token balance ledger; drives Stripe host-side (BYOK, demo-mode by default);
 * expresses commercial policy through ONE central entitlement resolver — never by
 * editing individual features. R-1 (the MyndHyve cutover): live mode works day-1
 * against the existing Stripe account (config price catalog + Stripe-id-preserving
 * importer + webhook parity/idempotency). Toggle OFF ⇒ zero behavior change.
 *
 * @see docs/adr/0176-subscriptions-billing.md
 */
import type { BackendFeature } from '../types.js';
import { registerBillingRoutes } from './routes.js';
import { setManagedBalanceProvider } from '../../host/managedBalanceHook.js';
import { getBalance, drawFromBalance } from './billingService.js';

export const billingFeature: BackendFeature = {
  id: 'billing',
  registerRoutes: (deps) => {
    registerBillingRoutes(deps);
    // ADR 0176 Phase 2 — wire the prepaid-balance hook so the managed provider draws
    // from balance before the daily cap (dependency inversion; core stays feature-free).
    setManagedBalanceProvider({
      available: async (tenantId) => (await getBalance(tenantId)).totalAvailable,
      draw: (tenantId, tokens) => drawFromBalance(tenantId, tokens),
    });
  },
  toggleDefault: {
    id: 'billing',
    label: 'Subscriptions & Billing',
    description:
      'Stripe subscriptions, plan tiers, and a prepaid AI-token balance — host-side (BYOK), demo-mode by default. Plan entitlements resolve through one central resolver; usage limits are governance policy. OFF by default; when off, all features are unrestricted.',
    category: 'Admin',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'billing',
  },
};
