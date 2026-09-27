/**
 * Commerce Connect service facade (ADR 0385; CC-6 split 2026-07-17). The
 * implementation now lives in domain modules — stores (collections+helpers),
 * onboarding, listings, orders, webhookHandlers, adminOps — and THIS file
 * re-exports the public surface verbatim so no import site (routes, feature,
 * packs surface, tests) changed. The DurableCollection singletons stay
 * package-private in stores.ts (not re-exported here).
 */
export {
  bindSellerAccount, listingState,
  DEFAULT_FEE_PCT, platformRegion, orderIdFor, __resetCommerceConnect,
  type OnboardingState, type SellerAccount, type SellerPayout,
  type ListingLane, type ApprovalState, type PaidListing,
  type OrderStatus, type ConnectOrder, type ConnectDispute,
} from './stores.js';
export * from './onboarding.js';
export * from './listings.js';
export * from './orders.js';
export * from './webhookHandlers.js';
export * from './adminOps.js';
