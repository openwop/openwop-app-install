/**
 * Product-lifecycle seam (grade-data remediation, ADR 0279) — the dependency-safe
 * hook by which higher modules clean up their SOFT references to a product when it
 * is deleted, WITHOUT commerce importing them (the same ruling as `promotionSeam` /
 * `setSubscriptionInvoiceHook`: commerce is lower than every merch store, and
 * `subscriptions.ts` already imports `commerceService`, so the reverse edge would be
 * a cycle). `deleteProduct` fires this; each registrant fans out its own cleanup.
 *
 * Registrations are KEYED so a repeated boot (the feature `registerRoutes` can run
 * per test `createApp`) overwrites the same slot instead of stacking duplicate
 * handlers — idempotent by construction, no guard flag needed. Handlers MUST be
 * idempotent and are run best-effort: `fireProductDeleted` swallows a handler's
 * error so one registrant's failure can neither block the delete nor another
 * registrant's cleanup. Default = no handlers ⇒ `deleteProduct` is byte-identical
 * when nothing is wired.
 */
export interface ProductDeletedEvent {
  tenantId: string;
  orgId: string;
  productId: string;
}

type ProductDeletedHandler = (e: ProductDeletedEvent) => Promise<void>;

const handlers = new Map<string, ProductDeletedHandler>();

/** A higher module registers (idempotently, keyed) its per-product cleanup at boot. */
export function onProductDeleted(key: string, fn: ProductDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by `deleteProduct`; runs every registrant best-effort. Never throws.
 *  Returns how many handlers ran (surfaced on the audit row for observability). */
export async function fireProductDeleted(e: ProductDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a registrant's cleanup failure must not block the delete */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetProductLifecycleHooks(): void {
  handlers.clear();
}
