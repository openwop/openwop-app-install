/**
 * ADR 0462 Phase 2 — the wearable PROVIDER ADAPTER registry (honesty-gated).
 *
 * Each provider (fitbit/oura/…) has its own webhook signature scheme + payload
 * shape, so a provider-specific adapter supplies three pure functions. The lane is
 * present ONLY when the operator opts in (`OPENWOP_WEARABLE_PROVIDER_ENABLED`) AND at
 * least one adapter is registered; otherwise `wearableProviderConfigured()` is false,
 * the webhook route 404s, and the admin surface reads "awaiting adapter". This is the
 * honest posture for a lane whose LIVE credentials + provider webhook registration
 * don't exist in this environment (ADR 0462 §6, externally-blocked) — ships gated-off
 * + mock-tested.
 *
 * SECURITY: `verify` is called FIRST on every push (constant-time per the adapter),
 * with the signing secret resolved from the tenant's Connection (never stored
 * plaintext). Raw-byte HMAC providers need the raw request body — a real adapter that
 * requires it must ensure raw-body capture (a documented caveat of the gated-off lane).
 */

export interface WearablePush {
  /** The parsed JSON payload (a real raw-byte-HMAC adapter also needs `rawBody`). */
  payload: unknown;
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export interface WearableAdapter {
  /** Verify the provider's signature over the push using the tenant's signing
   *  secret. MUST be constant-time. An unverified push is a uniform 401. */
  verify(secret: string, push: WearablePush): boolean;
  /** The provider's OWN account id the push is for (→ the link store), or null. */
  extractProviderUserId(payload: unknown): string | null;
  /** Normalize the push into zero or more `(metric, value)` readings for the
   *  existing `ingestWearableMetric` kernel. Raw payloads are never persisted. */
  normalize(payload: unknown): Array<{ metric: string; value: number }>;
}

const adapters = new Map<string, WearableAdapter>();

/** Register a provider adapter (idempotent, keyed; repeat boots overwrite). A real
 *  boot registers only when the operator wires the provider; tests register fakes. */
export function registerWearableAdapter(provider: string, adapter: WearableAdapter): void {
  adapters.set(provider, adapter);
}

export function getWearableAdapter(provider: string): WearableAdapter | undefined {
  return adapters.get(provider);
}

/** The honesty gate: the lane is live only when the operator enabled it AND a
 *  provider adapter is registered. */
export function wearableProviderConfigured(): boolean {
  return process.env.OPENWOP_WEARABLE_PROVIDER_ENABLED === 'true' && adapters.size > 0;
}

/** Test-only reset. */
export function __resetWearableAdapters(): void {
  adapters.clear();
}
