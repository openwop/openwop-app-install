/**
 * ADR 0798 — the workspace key policy, as the authentication path reads it.
 *
 * `authMiddleware` asks "are keys turned off here?" on every request a key
 * makes. That is one more store read per request, so it is cached for a minute
 * per tenant and dropped the moment the policy route changes it on this
 * instance. Another instance converges within the minute — acceptable for a
 * switch an admin flips by hand, and the same bound the issuer-live cache has.
 */
import { getTenantKeyPolicy } from './apiKeyService.js';

const cache = new Map<string, { disabled: boolean; at: number }>();
const TTL_MS = 60_000;

export async function tenantKeysDisabled(tenantId: string, now: number = Date.now()): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit && now - hit.at < TTL_MS) return hit.disabled;
  const disabled = (await getTenantKeyPolicy(tenantId)).disabled === true;
  if (cache.size > 5000) cache.clear();
  cache.set(tenantId, { disabled, at: now });
  return disabled;
}

export function invalidateTenantKeyPolicyCache(tenantId?: string): void {
  if (tenantId === undefined) cache.clear();
  else cache.delete(tenantId);
}
